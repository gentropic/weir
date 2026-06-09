// weir sync engine — the provider-agnostic file mirror (SYNC.md Move 2). Two memory VFS
// trees stand in for local + remote; assert push/pull mirror the sync set, respect the
// device-local excludes, are idempotent, and round-trip content. Run: node tools/smoke-sync.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { SyncEngine, syncCollectPaths } from '../src/js/sync.js';
import { Store } from '../src/js/store/store.js';

const mk = () => VFS.create({ type: 'memory' });
async function write(vfs, p, s) {
  const slash = p.lastIndexOf('/');
  if (slash > 0) await vfs.mkdir(p.slice(0, slash), { recursive: true }).catch(() => {});
  await vfs.writeFile(p, s);
}
const read = async (vfs, p) => { try { return await vfs.readFile(p, 'utf8'); } catch { return null; } };

const local = await mk();
const remote = await mk();

// a store-shaped local tree: corpus files (the real layout) + a device-local settings file
await write(local, '/meta.json', '{"schema":5}');
await write(local, '/feeds/abc.json', '{"id":"abc"}');
await write(local, '/items/abc.ndjson', '{"id":"i1"}\n{"id":"i2"}');   // shards live under /items
await write(local, '/content/abc/i1.html', '<p>hi</p>');                     // legacy per-item file — must stay excluded
await write(local, '/content/abc.ndjson', '{"id":"x","html":"<p>hi</p>"}');   // per-feed content pack — must sync
await write(local, '/catalog/0f', '{"glass_id":"g1"}');
await write(local, '/schema/vocab/domain.json', '{"facet":"domain"}');
await write(local, '/settings.json', '{"sync_role":"hub","mount":"device-local"}');

// the sync set covers the corpus (incl. the easily-missed /items) and excludes settings
const set = await syncCollectPaths(local);
assert.ok(set.includes('/items/abc.ndjson'), 'item shards (/items) are in the sync set');
assert.ok(set.includes('/content/abc.ndjson'), 'per-feed content packs ARE synced');
assert.ok(!set.includes('/content/abc/i1.html'), 'legacy per-item content files stay excluded');
assert.ok(set.includes('/schema/vocab/domain.json'), 'nested vocab is in the sync set');
assert.ok(!set.includes('/settings.json'), 'device-local settings is excluded');

// push: local → remote mirrors the corpus, not settings
const eng = new SyncEngine({ local, remote });
const r1 = await eng.push();
assert.equal(r1.pushed, 6, `pushed the 5 index files + 1 content pack (got ${r1.pushed})`);
assert.equal(await read(remote, '/items/abc.ndjson'), '{"id":"i1"}\n{"id":"i2"}', 'shard mirrored + content round-trips');
assert.equal(await read(remote, '/content/abc.ndjson'), '{"id":"x","html":"<p>hi</p>"}', 'content PACK mirrored');
assert.equal(await read(remote, '/content/abc/i1.html'), null, 'legacy per-item content NOT mirrored');
assert.equal(await read(remote, '/settings.json'), null, 'settings NOT mirrored (device-local)');

// manifest stat-diff: a second push uploads nothing (everything's unchanged)
const r1b = await eng.push();
assert.equal(r1b.pushed, 0, 'second push uploads nothing (manifest stat-diff)');
assert.equal(r1b.skipped, 6, 'all 6 are skipped via the manifest');

// change one local file → only it re-uploads
await write(local, '/items/abc.ndjson', '{"id":"i1"}\n{"id":"i2"}\n{"id":"i9"}\n{"id":"i10"}');   // size differs
const r1c = await eng.push();
assert.equal(r1c.pushed, 1, `only the changed local file re-uploads (got ${r1c.pushed})`);
assert.equal(r1c.skipped, 5, 'the other 5 are still skipped');

// pull: changes on the remote flow back to local
await write(remote, '/items/abc.ndjson', '{"id":"r1"}\n{"id":"r2"}');   // a remote-side change
await write(remote, '/feeds/xyz.json', '{"id":"xyz"}');                  // and a new feed
const r2 = await eng.pull();
assert.equal(r2.pulled, 2, `pulled the changed shard + the new feed (got ${r2.pulled})`);
assert.equal(await read(local, '/items/abc.ndjson'), '{"id":"r1"}\n{"id":"r2"}', 'local shard updated from remote');
assert.equal(await read(local, '/feeds/xyz.json'), '{"id":"xyz"}', 'new remote feed arrived locally');
assert.equal((await eng.pull()).pulled, 0, 'second pull is a no-op');

// pull recorded what it wrote → a follow-up push does NOT echo the pulled files back
assert.equal((await eng.push()).pushed, 0, 'push does not echo just-pulled files (manifest updated on pull)');

// ── store.reload(): a pull writes files underneath the store; reload() surfaces them ──
const sa = new Store(await mk()); await sa._hydrate();
await sa.vfs.writeFile('/feeds/f1.json', '{"id":"f1","title":"F1"}');
assert.ok(!sa.feeds.has('f1'), 'store has not seen the file-only feed before reload');
await sa.reload();
assert.ok(sa.feeds.has('f1'), 'reload() picks up files written underneath the store');

// ── pull + reload integration: the engine surfaces a synced feed in the live store ──
const sb = new Store(await mk()); await sb._hydrate();
const eng2 = new SyncEngine({ local: sb.vfs, remote: sa.vfs, store: sb });
const r3 = await eng2.pull();
assert.ok(r3.pulled >= 1, 'pull copied the remote feed file');
assert.ok(sb.feeds.has('f1'), 'pull + store.reload() surfaces the synced feed in the live store');

// ── bootstrap pull (change-feed backend, no cursor yet): fetch only not-yet-synced files,
//    then capture the cursor so later pulls go incremental ──
const MANIFEST = '/sync-state.json';
const bsLocal = await mk();
const bsRemote = await mk();
await write(bsRemote, '/items/k.ndjson', '{"id":"k1"}');
await write(bsRemote, '/feeds/k.json', '{"id":"k"}');
const bsBe = bsRemote.resolve('/').backend;          // give the memory backend a (fake) change feed
bsBe.latestCursor = async () => 'CUR-A';
bsBe.changes = async (c) => ({ entries: [], cursor: c, has_more: false });
const bsEng = new SyncEngine({ local: bsLocal, remote: bsRemote });
const bs = await bsEng.pull();
assert.equal(bs.mode, 'bootstrap', 'change feed + no cursor → bootstrap');
assert.equal(bs.pulled, 2, `bootstrap fetches the 2 not-yet-synced files (got ${bs.pulled})`);
assert.equal(await read(bsLocal, '/items/k.ndjson'), '{"id":"k1"}', 'bootstrap brought the file local');
const bs2 = await bsEng.pull();
assert.equal(bs2.mode, 'incremental', 'cursor captured → subsequent pulls are incremental');
assert.equal(bs2.pulled || 0, 0, 'no deltas → incremental pulls nothing');

// ── incremental pull: process a delta (add + delete), map paths (strip the backend root),
//    advance the cursor ──
const inLocal = await mk();
await write(inLocal, MANIFEST, JSON.stringify({ cursor: 'c0', files: {} }));   // pre-seed a cursor
await write(inLocal, '/feeds/old.json', '{"id":"old"}');                         // the delta will delete this
const mockBe = {
  _root: '/weir',
  latestCursor: async () => 'cLatest',
  changes: async () => ({
    entries: [
      { '.tag': 'file', path_display: '/weir/items/new.ndjson', name: 'new.ndjson' },
      { '.tag': 'deleted', path_display: '/weir/feeds/old.json', name: 'old.json' },
    ], cursor: 'c1', has_more: false,
  }),
};
const mockRemote = {
  resolve: () => ({ backend: mockBe }),
  readFile: async (p) => { if (p === '/items/new.ndjson') return new TextEncoder().encode('{"id":"n1"}'); throw new Error('ENOENT ' + p); },
};
const inEng = new SyncEngine({ local: inLocal, remote: mockRemote });
const inc = await inEng.pull();
assert.equal(inc.mode, 'incremental', 'cursor + change feed → incremental');
assert.equal(inc.pulled, 1, 'incremental fetched the added file');
assert.equal(inc.removed, 1, 'incremental removed the deleted file');
assert.equal(await read(inLocal, '/items/new.ndjson'), '{"id":"n1"}', 'added file mapped (/weir/… → /…) + written local');
assert.equal(await read(inLocal, '/feeds/old.json'), null, 'deleted file removed locally');
assert.equal(JSON.parse(await read(inLocal, MANIFEST)).cursor, 'c1', 'cursor advanced to the delta cursor');

console.log('sync (engine mirror) smoke ok');
