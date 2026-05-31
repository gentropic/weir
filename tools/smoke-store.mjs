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

console.log('store smoke ok:', JSON.stringify(reopened.counts()));
