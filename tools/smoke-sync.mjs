// weir sync engine — the provider-agnostic file mirror (SYNC.md Move 2). Two memory VFS
// trees stand in for local + remote; assert push/pull mirror the sync set, respect the
// device-local excludes, are idempotent, and round-trip content. Run: node tools/smoke-sync.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { createHash } from 'node:crypto';
import { SyncEngine, syncCollectPaths, syncRetry, syncShouldScan, syncSummarize, syncDropboxContentHash } from '../src/js/sync.js';
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
await write(inLocal, '/items/echo.ndjson', '{"id":"echo"}');                     // our own upload, about to be echoed back
const echoHash = await syncDropboxContentHash(new TextEncoder().encode('{"id":"echo"}'));
const mockBe = {
  _root: '/weir',
  latestCursor: async () => 'cLatest',
  changes: async () => ({
    entries: [
      { '.tag': 'file', path_display: '/weir/items/new.ndjson', name: 'new.ndjson' },
      { '.tag': 'file', path_display: '/weir/items/echo.ndjson', name: 'echo.ndjson', content_hash: echoHash },   // echo: matches local → must be skipped
      { '.tag': 'deleted', path_display: '/weir/feeds/old.json', name: 'old.json' },
    ], cursor: 'c1', has_more: false,
  }),
};
const fetched = [];
const mockRemote = {
  resolve: () => ({ backend: mockBe }),
  readFile: async (p) => { fetched.push(p); if (p === '/items/new.ndjson') return new TextEncoder().encode('{"id":"n1"}'); if (p === '/items/echo.ndjson') return new TextEncoder().encode('{"id":"echo"}'); throw new Error('ENOENT ' + p); },
};
const inEng = new SyncEngine({ local: inLocal, remote: mockRemote });
const inc = await inEng.pull();
assert.equal(inc.mode, 'incremental', 'cursor + change feed → incremental');
assert.equal(inc.pulled, 1, 'incremental fetched only the genuinely-new file (echo skipped)');
assert.equal(inc.removed, 1, 'incremental removed the deleted file');
assert.equal(inc.echoed, 1, 'the content-hash-matching echo was recognized + skipped');
assert.ok(!fetched.includes('/items/echo.ndjson'), 'echo file was NOT re-downloaded (no wasteful fetch)');
assert.ok(fetched.includes('/items/new.ndjson'), 'genuinely-new file WAS downloaded');
assert.equal(await read(inLocal, '/items/new.ndjson'), '{"id":"n1"}', 'added file mapped (/weir/… → /…) + written local');
assert.equal(await read(inLocal, '/feeds/old.json'), null, 'deleted file removed locally');
assert.equal(JSON.parse(await read(inLocal, MANIFEST)).cursor, 'c1', 'cursor advanced to the delta cursor');

// content_hash algorithm: a <4 MB single-block file = SHA256(SHA256(bytes)), verified independently.
{
  const data = new TextEncoder().encode('hello dropbox content hash');
  const blockDigest = createHash('sha256').update(data).digest();              // raw 32 bytes (one block)
  const expected = createHash('sha256').update(blockDigest).digest('hex');     // SHA256 of the concatenated block digests
  assert.equal(await syncDropboxContentHash(data), expected, 'single-block content_hash = SHA256(SHA256(block))');
  assert.notEqual(await syncDropboxContentHash(new TextEncoder().encode('x')), expected, 'different content → different hash');
}

// ── rate-limit-aware retry: a Dropbox throttle (too_many_write_operations) backs off SECONDS,
// escalating, and rides it out; a transient error keeps the quick ramp. Inject a fast sleep that
// records waits (no real waiting), so the test is instant. (The big-first-push 429 fix.) ──
{
  const waits = []; const fast = async (ms) => { waits.push(ms); };
  let n = 0;
  const r = await syncRetry(async () => { if (n++ < 2) throw new Error('dropbox: too_many_write_operations (request id …)'); return 'ok'; }, 6, fast);
  assert.equal(r, 'ok', 'syncRetry rides out a Dropbox throttle and succeeds');
  assert.equal(n, 3, 'retried until success');
  assert.ok(waits.length === 2 && waits.every((w) => w >= 4000), 'throttle backoff is seconds-scale, not sub-3s');
  assert.ok(waits[1] > waits[0], 'backoff escalates');

  const w2 = []; let m = 0;
  await syncRetry(async () => { if (m++ < 1) throw new Error('transient network blip'); return 1; }, 6, async (ms) => w2.push(ms));
  assert.ok(w2[0] < 1000, 'a non-throttle error keeps the quick sub-second first backoff');

  // a thrown "Failed to fetch" = a Dropbox 429 masked as CORS (no header → fetch throws) → seconds backoff
  const w3 = []; let k = 0;
  await syncRetry(async () => { if (k++ < 1) throw new TypeError('Failed to fetch'); return 1; }, 6, async (ms) => w3.push(ms));
  assert.ok(w3[0] >= 4000, 'a thrown "Failed to fetch" (masked 429/CORS) backs off seconds, not sub-second');

  await assert.rejects(syncRetry(async () => { throw new Error('429 too_many_requests'); }, 3, async () => {}), /too_many/, 'rethrows after exhausting tries');
}

// ── scan-skip decision: don't re-walk the whole tree every cycle. Skip when clean (rev
// unchanged, off a force cycle); scan when local changed, forced, or on the periodic safety net. ──
assert.equal(syncShouldScan({ rev: 5, lastRev: 5, cycle: 1, forceEvery: 10 }), false, 'clean + off-cycle → skip the FS scan');
assert.equal(syncShouldScan({ rev: 6, lastRev: 5, cycle: 1, forceEvery: 10 }), true, 'local changed (rev advanced) → scan');
assert.equal(syncShouldScan({ rev: 5, lastRev: 5, cycle: 10, forceEvery: 10 }), true, 'safety-net cycle (10 % 10) → scan even when clean');
assert.equal(syncShouldScan({ rev: 5, lastRev: undefined, cycle: 3, forceEvery: 10 }), true, 'first push (no lastRev) → scan');
assert.equal(syncShouldScan({ rev: 5, lastRev: 5, cycle: 3, forceEvery: 10, force: true }), true, 'manual force → scan');

// ── mutation counter: flush-with-writes bumps it (corpus path); a no-op flush does not. (Notes
// bypass flush and bump via store.touchSync from stacks — covered in smoke-stacks.) ──
{
  const s = new Store(await mk()); await s._hydrate();
  const m0 = s._mutations;
  await s.putFeed({ id: 'f', name: 'F', adapter: 'feed', url: 'http://f' });
  await s.upsertItems([{ id: 'f:1', feed_id: 'f', type: 'article', title: 'hi', excerpt: 'x' }]);
  await s.flush();
  assert.ok(s._mutations > m0, 'flush with writes bumps the mutation counter');
  const m1 = s._mutations;
  await s.flush();
  assert.equal(s._mutations, m1, 'a no-op flush does NOT bump (so idle cycles skip the scan)');
}

// ── activity readout: categorize synced paths by kind, so the UI can show "items 2, notes 1". ──
{
  const s = syncSummarize(['/items/a.ndjson', '/items/b.ndjson', '/content/a.ndjson', '/stacks/inbox/n.md', '/catalog/0f', '/sync-state.json']);
  assert.equal(s.total, 6, 'counts every path');
  assert.equal(s.byKind.items, 2, 'items bucket');
  assert.equal(s.byKind.content, 1, 'content bucket');
  assert.equal(s.byKind.notes, 1, 'stacks → notes bucket');
  assert.equal(s.byKind.catalog, 1, 'catalog bucket');
  assert.equal(s.byKind.other, 1, 'unrecognized path → other');
  assert.equal(syncSummarize([]).total, 0, 'empty → zero, no throw');
}

// ── fast paths (vfs 0.3.0): listTree bootstrap + writeFiles batch push ──
{
  // bootstrap via listTree — ONE sweep returns entries + cursor; fetch only the missing files.
  const local = await mk();
  await write(local, MANIFEST, JSON.stringify({ files: {} }));   // fresh reader, no cursor → bootstrap
  let listTreeCalls = 0;
  const be = {
    changes: async () => ({ entries: [], cursor: 'c', has_more: false }),   // present → bootstrap mode (not full-mirror)
    latestCursor: async () => 'cFallback',
    listTree: async () => { listTreeCalls++; return { cursor: 'cTree', entries: [
      { path: '/items/a.ndjson', type: 'file', size: 5, contentHash: 'h1' },
      { path: '/feeds', type: 'directory' },                       // skipped (not a file)
      { path: '/feeds/b.json', type: 'file', size: 3, contentHash: 'h2' },
      { path: '/sync-state.json', type: 'file', size: 9 },         // excluded — must NOT be fetched
    ] }; },
  };
  const fetched = [];
  const remote = { resolve: () => ({ backend: be }), readFile: async (p) => { fetched.push(p); return new TextEncoder().encode(p === '/items/a.ndjson' ? '{"id":"a"}' : '{"id":"b"}'); } };
  const r = await new SyncEngine({ local, remote }).pull();
  assert.equal(r.mode, 'bootstrap', 'no cursor → bootstrap');
  assert.equal(listTreeCalls, 1, 'bootstrap used a single listTree sweep (no per-file stat walk)');
  assert.deepEqual(fetched.sort(), ['/feeds/b.json', '/items/a.ndjson'], 'fetched files only (skipped the directory + the excluded manifest)');
  assert.equal(JSON.parse(await read(local, MANIFEST)).cursor, 'cTree', 'cursor came from listTree — no separate latestCursor call');
}
{
  // push uses per-file files/upload (NOT the backend's batch writeFiles): Dropbox upload_session
  // isn't CORS-enabled from a browser. Even when the remote ADVERTISES writeFiles, push must not
  // call it — assert the changed files land per-file and writeFiles is left untouched.
  const local = await mk(); const remote = await mk();
  await write(local, '/items/x.ndjson', '{"id":"x"}');
  await write(local, '/feeds/y.json', '{"id":"y"}');
  await write(local, MANIFEST, JSON.stringify({ files: {} }));
  let batchCalled = false;
  remote.resolve('/').backend.writeFiles = async () => { batchCalled = true; };   // tempt push to batch
  const r = await new SyncEngine({ local, remote }).push();
  assert.equal(r.pushed, 2, 'push uploaded both changed files');
  assert.equal(batchCalled, false, 'push did NOT use remote.writeFiles (upload_session is CORS-blocked)');
  assert.equal(await read(remote, '/items/x.ndjson'), '{"id":"x"}', 'file uploaded per-file (files/upload)');
}

// ── reader role: push uploads ONLY its own deltas (notes), never corpus — safe by construction ──
// (push is per-file files/upload, so we assert by what lands in the remote, not via a writeFiles spy.)
{
  const local = await mk(); const remote = await mk();
  await write(local, '/items/x.ndjson', '{"id":"x"}');       // corpus — a reader must NOT push this
  await write(local, '/feeds/f.json', '{"id":"f"}');          // corpus
  await write(local, '/stacks/inbox/note.md', '# my note');   // reader delta — OK to push
  await write(local, MANIFEST, JSON.stringify({ files: {} }));
  const r = await new SyncEngine({ local, remote, role: 'reader' }).push();
  assert.equal(r.heldForRole, 2, 'reader held back the 2 corpus files (cannot clobber the hub)');
  assert.equal(await read(remote, '/stacks/inbox/note.md'), '# my note', 'reader pushed its note');
  assert.equal(await read(remote, '/items/x.ndjson'), null, 'reader did NOT push the corpus item shard');
  assert.equal(await read(remote, '/feeds/f.json'), null, 'reader did NOT push the corpus feed');
  // a hub pushes everything
  const local2 = await mk(); const remote2 = await mk();
  await write(local2, '/items/x.ndjson', '{"id":"x"}');
  await write(local2, '/stacks/inbox/n.md', '# n');
  await write(local2, MANIFEST, JSON.stringify({ files: {} }));
  const r2 = await new SyncEngine({ local: local2, remote: remote2, role: 'hub' }).push();
  assert.equal(r2.heldForRole, 0, 'hub holds nothing back');
  assert.equal(await read(remote2, '/items/x.ndjson'), '{"id":"x"}', 'hub pushed the corpus');
  assert.equal(await read(remote2, '/stacks/inbox/n.md'), '# n', 'hub pushed the note');
}

// ── bootstrap batches LOCAL writes via the local backend's writeFiles (IDB on the phone) ──
{
  const local = await mk();
  await write(local, MANIFEST, JSON.stringify({ files: {} }));
  const lbe = local.resolve('/').backend;        // memory backend has no writeFiles — patch one in to exercise the wiring
  let batchCalls = 0, batched = 0;
  lbe.writeFiles = async (files) => { batchCalls++; batched += files.length; for (const f of files) await write(local, f.path, new TextDecoder().decode(f.content)); };
  const be = {
    changes: async () => ({ entries: [], cursor: 'c', has_more: false }),
    latestCursor: async () => 'cFallback',
    listTree: async () => ({ cursor: 'cTree', entries: [{ path: '/items/a.ndjson', type: 'file' }, { path: '/items/b.ndjson', type: 'file' }] }),
  };
  const remote = { resolve: () => ({ backend: be }), readFile: async (p) => new TextEncoder().encode(`data:${p}`) };
  const r = await new SyncEngine({ local, remote }).pull();
  assert.equal(r.mode, 'bootstrap', 'bootstrap mode');
  assert.equal(r.pulled, 2, 'pulled both files');
  assert.ok(batchCalls >= 1, 'bootstrap committed local writes via the backend batch (writeFiles)');
  assert.equal(batched, 2, 'both files went through the batch, not per-file');
  assert.equal(await read(local, '/items/a.ndjson'), 'data:/items/a.ndjson', 'file landed locally');
  assert.equal(JSON.parse(await read(local, MANIFEST)).cursor, 'cTree', 'cursor set from listTree');
}

// ── masked-CORS-on-200: Dropbox `files/upload` returns 200 but NO Access-Control-Allow-Origin, so
// the browser blocks the response and fetch THROWS even though the bytes landed. push() must CONFIRM
// via metadata (content_hash match) and record the file — not re-push it forever (the all-day
// console-error accumulation). ──
{
  const local = await mk();
  await write(local, '/items/x.ndjson', '{"id":"i1"}');
  const stored = new Map();
  const remote = {
    mkdir: async () => {},
    // the upload SUCCEEDS server-side (bytes stored) but the CORS-blocked 200 makes fetch throw
    writeFile: async (p, data) => { stored.set(p, data); throw new TypeError('Failed to fetch'); },
    // get_metadata is RPC (CORS-readable) → returns the real content_hash for the confirm
    stat: async (p) => { if (!stored.has(p)) throw new Error('ENOENT'); const d = stored.get(p); return { type: 'file', size: d.length, contentHash: await syncDropboxContentHash(d) }; },
  };
  const r = await new SyncEngine({ local, remote }).push();
  assert.equal(r.pushed, 1, 'masked-CORS upload is CONFIRMED via metadata + recorded (not lost to the throw)');
  assert.ok(stored.has('/items/x.ndjson'), 'the bytes did land on the remote');
  // idempotent: a fresh engine reloads the persisted manifest → does NOT re-push (no daily accumulation)
  const r2 = await new SyncEngine({ local, remote }).push();
  assert.equal(r2.pushed, 0, 'after confirmation the file is not re-pushed');
}

console.log('sync (engine mirror) smoke ok');
