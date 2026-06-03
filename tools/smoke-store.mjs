// End-to-end store test against the in-memory backend (runs in node; the IDB/
// FSA backends need a browser but share this exact code path). Exercises insert,
// dedup, lazy content, state, prune + tombstone resurrection guard, and
// rehydration from the persisted shards. Run: `node tools/smoke-store.mjs`.

import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';

const vfs = await VFS.create();          // memory, persists for this instance
const store = new Store(vfs);
await store._hydrate();

assert.equal(await store.ping(), true, 'ping round-trip');

await store.putFeed({ id: 'arxiv-geo', name: 'arXiv geo', adapter: 'feed', url: 'https://example.com/feed' });
assert.equal(store.listFeeds().length, 1, 'one feed');

const RAW = [
  { id: 'arxiv:2026.001', feed_id: 'arxiv-geo', title: 'Variogram cross-validation', type: 'paper',
    author: 'Marques', published_at: 3000, content: '<p>Full <b>abstract</b> body here.</p>' },
  { id: 'arxiv:2026.002', feed_id: 'arxiv-geo', title: 'Kriging uncertainty', type: 'paper', published_at: 2000 },
  { id: 'arxiv:2026.003', feed_id: 'arxiv-geo', title: 'Geomet recovery GP', type: 'paper', published_at: 1000 },
];
let r = await store.upsertItems(RAW);
assert.deepEqual(r, { inserted: 3, updated: 0, skipped: 0 }, 'initial insert');

assert.equal(store.query({ view: 'inbox' }).length, 3, 'inbox has 3');
assert.equal(store.query({ feed_id: 'arxiv-geo' }).length, 3, 'feed filter');
assert.equal(store.search('kriging').length, 1, 'text search');
assert.equal(store.query({ view: 'inbox' })[0].id, 'arxiv:2026.001', 'sorted newest-first');

const body = await store.getContent('arxiv:2026.001');
assert.match(body, /Full/, 'lazy content round-trip');
assert.equal(await store.getContent('arxiv:2026.002'), null, 'no content → null');

assert.equal(store.counts().unread, 3, 'all unread');
store.setState('arxiv:2026.001', { read: true });
store.setState('arxiv:2026.002', { saved: true });
assert.equal(store.counts().unread, 2, 'one read');
assert.equal(store.counts().saved, 1, 'one saved');

// Re-fetch (dedup): same ids, changed title — must update, not duplicate, and
// must preserve read/saved set above.
r = await store.upsertItems(RAW.map((x) => ({ ...x, title: x.title + ' (v2)' })));
assert.deepEqual(r, { inserted: 0, updated: 3, skipped: 0 }, 're-fetch updates');
assert.equal(store.getItem('arxiv:2026.001').read, true, 'read preserved on re-fetch');
assert.equal(store.getItem('arxiv:2026.002').saved, true, 'saved preserved on re-fetch');
assert.match(store.getItem('arxiv:2026.003').title, /v2/, 'mutable field updated');

// ── tagging: shared verb with provenance (human / llm), idempotent, queryable ──
store.addTag('arxiv:2026.001', 'kriging', 'human');
store.addTag('arxiv:2026.001', 'kriging', 'human');   // idempotent
store.addTag('arxiv:2026.002', 'geo', 'llm');
assert.deepEqual(store.getItem('arxiv:2026.001').tags, ['kriging'], 'tag added once (idempotent)');
assert.equal(store.getItem('arxiv:2026.001').tag_src.kriging, 'human', 'human provenance recorded');
assert.equal(store.getItem('arxiv:2026.002').tag_src.geo, 'llm', 'llm provenance recorded');
assert.equal(store.query({ tag: 'kriging' }).length, 1, 'query by tag');
assert.match(store.getItem('arxiv:2026.001').search_text, /kriging/, 'tag folded into search_text');
// a re-fetch must NOT drop tags or their provenance (the dedup gotcha)
await store.upsertItems([{ ...RAW[0], title: 'changed again' }]);
assert.deepEqual(store.getItem('arxiv:2026.001').tags, ['kriging'], 'tags survive re-fetch');
assert.equal(store.getItem('arxiv:2026.001').tag_src.kriging, 'human', 'provenance survives re-fetch');
// remove clears the provenance entry (and the map when empty)
store.removeTag('arxiv:2026.002', 'geo');
assert.deepEqual(store.getItem('arxiv:2026.002').tags, [], 'tag removed');
assert.equal(store.getItem('arxiv:2026.002').tag_src, undefined, 'tag_src cleared when last tag removed');

// bulk-tag (isolated store, so it can't perturb the carefully-sequenced asserts above)
{
  const bs = new Store(await VFS.create()); await bs._hydrate();
  await bs.putFeed({ id: 'bf', name: 'bulk', adapter: 'feed', url: 'http://x/f' });
  await bs.upsertItems([{ id: 'b1', feed_id: 'bf', title: 'one', type: 'article' }, { id: 'b2', feed_id: 'bf', title: 'two', type: 'article' }]);
  const bn = bs.addTagBulk(['b1', 'b2'], ['batch', 'batch', ' batch '], 'human');   // repeats + whitespace dedup to one
  assert.equal(bn, 2, 'addTagBulk changed both items');
  assert.ok(bs.getItem('b1').tags.includes('batch') && bs.getItem('b2').tags.includes('batch'), 'bulk tag landed on both');
  assert.deepEqual(bs.getItem('b1').tags, ['batch'], 'dedups repeats/whitespace to a single tag');
  assert.equal(bs.getItem('b2').tag_src.batch, 'human', 'bulk provenance recorded');
  assert.equal(bs.addTagBulk(['b1'], ['batch'], 'human'), 0, 'bulk is idempotent (no change → 0)');
  assert.equal(bs.query({ tag: 'batch' }).length, 2, 'both queryable by the bulk tag');

  // rename carries provenance; renaming into an existing tag merges
  bs.addTag('b1', 'old', 'human');
  assert.equal(bs.renameTag('old', 'fresh'), 1, 'rename touched 1 item');
  assert.ok(bs.getItem('b1').tags.includes('fresh') && !bs.getItem('b1').tags.includes('old'), 'tag renamed on the item');
  assert.equal(bs.getItem('b1').tag_src.fresh, 'human', 'provenance carried through rename');
  bs.renameTag('fresh', 'batch');   // merge into the existing 'batch'
  assert.deepEqual(bs.getItem('b1').tags.filter((t) => t === 'batch'), ['batch'], 'merge dedups to a single tag');

  // counts (registered-but-unused included), color, delete-everywhere
  await bs.setTag('batch', { color: '#98c379' });
  assert.equal(bs.getTags().batch.color, '#98c379', 'tag color stored in the registry');
  assert.equal(bs.tagCounts().batch, 2, 'tagCounts: both items carry batch');
  assert.equal(bs.deleteTag('batch'), 2, 'deleteTag removed from both items');
  assert.equal(bs.query({ tag: 'batch' }).length, 0, 'tag gone from every item');
  assert.ok(!('batch' in bs.getTags()), 'tag removed from the registry');
}

// Prune one, then prove it cannot be resurrected by a later poll.
assert.deepEqual(await store.prune(['arxiv:2026.003']), { pruned: 1 }, 'prune one');
assert.equal(store.getItem('arxiv:2026.003'), null, 'pruned item gone');
r = await store.upsertItems([RAW[2]]);
assert.deepEqual(r, { inserted: 0, updated: 0, skipped: 1 }, 'tombstone blocks resurrection');

// Persist + rehydrate from shards in a fresh Store over the same backend.
await store.flush();
const reopened = new Store(vfs);
await reopened._hydrate();
assert.equal(reopened.items.size, 2, 'rehydrated item count');
assert.equal(reopened.archived.has('arxiv:2026.003'), true, 'tombstone survived reload');
assert.equal(reopened.getItem('arxiv:2026.001').read, true, 'read flag survived reload');
assert.deepEqual(reopened.getItem('arxiv:2026.001').tags, ['kriging'], 'tags survived reload');
assert.equal(reopened.getItem('arxiv:2026.001').tag_src?.kriging, 'human', 'tag provenance survived reload');
assert.match(await reopened.getContent('arxiv:2026.001'), /abstract/, 'content survived reload');

// clearFeedItems: drop a feed's items without tombstoning (feed re-point),
// saved items exempt; the new source's ids can flow in afterward.
{
  const s2 = new Store(await VFS.create());
  await s2._hydrate();
  await s2.putFeed({ id: 'hijacked', name: 'Hijacked', url: 'https://spam.example/feed' });
  await s2.upsertItems([
    { id: 'spam-1', feed_id: 'hijacked', title: 'Giay 1', content: 'x' },
    { id: 'spam-2', feed_id: 'hijacked', title: 'Giay 2' },
    { id: 'keep-me', feed_id: 'hijacked', title: 'accidentally saved' },
  ]);
  s2.setState('keep-me', { saved: true });
  assert.deepEqual(await s2.clearFeedItems('hijacked'), { removed: 2 }, 'cleared the two non-saved items');
  assert.equal(s2.getItem('spam-1'), null, 'spam gone');
  assert.equal(s2.getItem('keep-me').saved, true, 'saved item kept');
  assert.equal((s2.byFeed.get('hijacked') || new Set()).size, 1, 'feed index reflects removal');
  // No tombstone → the new source can deliver fresh ids freely.
  const r2 = await s2.upsertItems([{ id: 'real-1', feed_id: 'hijacked', title: 'Real PSF news' }]);
  assert.deepEqual(r2, { inserted: 1, updated: 0, skipped: 0 }, 'new source items flow in (no tombstone block)');
}

// Smart views: seeded on first run, persisted (incl. deletions), survive reload.
{
  const v = await VFS.create();
  const s2 = new Store(v); await s2._hydrate();
  assert.ok(s2.getViews().length >= 4, 'type defaults seeded on first run');
  assert.ok(s2.getViews().some((x) => x.query.type === 'video'), 'has a Videos view');
  // add a saved search + delete a built-in
  const kept = s2.getViews().filter((x) => x.id !== 'v-releases');
  await s2.saveViews([...kept, { id: 'v-search', name: 'rust stuff', query: { text: 'rust' } }]);
  const reopened2 = new Store(v); await reopened2._hydrate();
  assert.ok(!reopened2.getViews().some((x) => x.id === 'v-releases'), 'deletion persisted (not re-seeded)');
  assert.ok(reopened2.getViews().some((x) => x.id === 'v-search'), 'saved search persisted');
  // a view query filters via store.query (inbox-ish)
  await reopened2.putFeed({ id: 'mix', name: 'Mix', adapter: 'feed', url: 'http://m/f' });
  await reopened2.upsertItems([
    { id: 'a1', feed_id: 'mix', type: 'article', title: 'hello' },
    { id: 'v1', feed_id: 'mix', type: 'video', title: 'a clip' },
  ]);
  assert.equal(reopened2.query({ type: 'video' }).length, 1, 'Videos view query returns only videos');
}

// Backup round-trip: exportAll → importAll into a fresh VFS → re-hydrate is
// byte-for-byte the same corpus, and strays not in the backup are pruned.
{
  const a = new Store(await VFS.create()); await a._hydrate();
  await a.putFeed({ id: 'bk', name: 'Backup Me', adapter: 'feed', url: 'http://b/f', category: 'dev' });
  await a.upsertItems([
    { id: 'bk-1', feed_id: 'bk', type: 'article', title: 'kept', content: '<p>body one</p>' },
    { id: 'bk-2', feed_id: 'bk', type: 'video', title: 'clip' },
  ]);
  a.setState('bk-1', { saved: true });
  await a.setSettings({ default_poll_interval_minutes: 222 });
  await a.saveViews([{ id: 'v-x', name: 'My View', query: { text: 'foo' } }]);
  const backup = await a.exportAll();
  assert.ok(backup.files['/feeds/' + a.feedKey('bk') + '.json'], 'backup includes the feed file');
  assert.ok(Object.keys(backup.files).some((p) => p.startsWith('/content/')), 'backup includes lazy content');
  assert.ok(backup.meta.files === Object.keys(backup.files).length, 'meta count matches');

  // Restore into a DIFFERENT store that has a stray feed (must be pruned).
  const b = new Store(await VFS.create()); await b._hydrate();
  await b.putFeed({ id: 'stray', name: 'Stray', adapter: 'feed', url: 'http://s/f' });
  const r = await b.importAll(backup);
  assert.ok(r.pruned >= 1, 'stray feed pruned (exact snapshot)');

  // Re-hydrate from the restored VFS — identical to the source.
  const c = new Store(b.vfs); await c._hydrate();
  assert.equal(c.items.size, 2, 'items restored');
  assert.equal(c.getFeed('bk')?.name, 'Backup Me', 'feed restored');
  assert.equal(c.getFeed('stray'), null, 'stray gone after restore');
  assert.equal(c.getItem('bk-1').saved, true, 'saved flag survived backup');
  assert.match(await c.getContent('bk-1'), /body one/, 'lazy content survived backup');
  assert.equal(c.getSettings().default_poll_interval_minutes, 222, 'settings restored');
  assert.ok(c.getViews().some((v) => v.id === 'v-x'), 'views restored');
}

// ── storage breakdown: per-area byte sums from stat() ──
{
  const s = new Store(await VFS.create()); await s._hydrate();
  await s.putFeed({ id: 'sb', name: 'SB', adapter: 'feed', url: 'http://sb/f' });
  await s.upsertItems([{ id: 'sb-1', feed_id: 'sb', type: 'article', title: 'T', content: '<p>' + 'x'.repeat(500) + '</p>' }]);
  const bd = await s.storageBreakdown();
  assert.ok(bd.total > 0, 'breakdown total > 0');
  assert.ok(bd.areas.feeds > 0, 'feeds area counted');
  assert.ok(bd.areas.items > 0, 'items area counted');
  assert.ok(bd.areas.content > 0, 'content area counted');
  assert.equal(bd.total, Object.values(bd.areas).reduce((a, b) => a + b, 0), 'total = sum of areas');
}

// ── putFeed id collision: two feeds whose names slugify alike keep distinct ids ──
{
  const s = new Store(await VFS.create()); await s._hydrate();
  // Two bsky profiles, both name-fallback to the host 'bsky.app' → slug 'bsky-app'.
  const a = await s.putFeed({ name: 'bsky.app', adapter: 'feed', url: 'https://bsky.app/profile/did:plc:aaa/rss' });
  const b = await s.putFeed({ name: 'bsky.app', adapter: 'feed', url: 'https://bsky.app/profile/did:plc:bbb/rss' });
  assert.equal(a.id, 'bsky-app', 'first claims the clean slug');
  assert.notEqual(b.id, a.id, 'second feed gets a distinct id, not a clobber');
  assert.equal(s.listFeeds().length, 2, 'both feeds survive — no overwrite');
  // Re-adding the SAME url (no id) is idempotent — reuses the disambiguated id.
  const b2 = await s.putFeed({ name: 'bsky.app', adapter: 'feed', url: 'https://bsky.app/profile/did:plc:bbb/rss' });
  assert.equal(b2.id, b.id, 're-add of same url reuses its id (idempotent)');
  assert.equal(s.listFeeds().length, 2, 'still two feeds after re-add');
}

console.log('store smoke ok:', JSON.stringify(reopened.counts()));
