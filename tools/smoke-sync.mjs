// weir sync engine — the provider-agnostic file mirror (SYNC.md Move 2). Two memory VFS
// trees stand in for local + remote; assert push/pull mirror the sync set, respect the
// device-local excludes, are idempotent, and round-trip content. Run: node tools/smoke-sync.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { SyncEngine, syncCollectPaths } from '../src/js/sync.js';

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
await write(local, '/content/abc/i1.html', '<p>hi</p>');
await write(local, '/catalog/0f', '{"glass_id":"g1"}');
await write(local, '/schema/vocab/domain.json', '{"facet":"domain"}');
await write(local, '/settings.json', '{"sync_role":"hub","mount":"device-local"}');

// the sync set covers the corpus (incl. the easily-missed /items) and excludes settings
const set = await syncCollectPaths(local);
assert.ok(set.includes('/items/abc.ndjson'), 'item shards (/items) are in the sync set');
assert.ok(set.includes('/content/abc/i1.html'), 'content is in the sync set');
assert.ok(set.includes('/schema/vocab/domain.json'), 'nested vocab is in the sync set');
assert.ok(!set.includes('/settings.json'), 'device-local settings is excluded');

// push: local → remote mirrors the corpus, not settings
const eng = new SyncEngine({ local, remote });
const r1 = await eng.push();
assert.equal(r1.pushed, 6, `pushed the 6 corpus files (got ${r1.pushed})`);
assert.equal(await read(remote, '/items/abc.ndjson'), '{"id":"i1"}\n{"id":"i2"}', 'shard mirrored + content round-trips');
assert.equal(await read(remote, '/content/abc/i1.html'), '<p>hi</p>', 'content mirrored');
assert.equal(await read(remote, '/settings.json'), null, 'settings NOT mirrored (device-local)');

// idempotent: a second push copies nothing
assert.equal((await eng.push()).pushed, 0, 'second push is a no-op (nothing differs)');

// pull: changes on the remote flow back to local
await write(remote, '/items/abc.ndjson', '{"id":"i1"}\n{"id":"i2"}\n{"id":"i3"}');   // remote gained an item
await write(remote, '/feeds/xyz.json', '{"id":"xyz"}');                                // and a new feed
const r2 = await eng.pull();
assert.equal(r2.pulled, 2, `pulled the changed shard + the new feed (got ${r2.pulled})`);
assert.equal(await read(local, '/items/abc.ndjson'), '{"id":"i1"}\n{"id":"i2"}\n{"id":"i3"}', 'local shard updated from remote');
assert.equal(await read(local, '/feeds/xyz.json'), '{"id":"xyz"}', 'new remote feed arrived locally');
assert.equal((await eng.pull()).pulled, 0, 'second pull is a no-op');

console.log('sync (engine mirror) smoke ok');
