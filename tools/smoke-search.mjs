// Search v2 (SearchIndex on @gcu/librarian) over a real Store — no browser.
// Run: node tools/smoke-search.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { SearchIndex } from '../src/js/search.js';

const store = new Store(await VFS.create()); await store._hydrate();
await store.putFeed({ id: 'f', name: 'Feed', adapter: 'feed', url: 'http://f/x' });
await store.upsertItems([
  { id: 'a', feed_id: 'f', type: 'article', title: 'Kriging the iron deposit', excerpt: 'geostatistics estimation', published_at: 3 },
  { id: 'b', feed_id: 'f', type: 'article', title: 'Weekend recipes', excerpt: 'a passing note about kriging in the third paragraph', published_at: 2 },
  { id: 'c', feed_id: 'f', type: 'video', title: 'Minecraft base tour', excerpt: 'building a megabase', published_at: 1 },
  { id: 'd', feed_id: 'f', type: 'article', title: 'Old news', excerpt: 'archived stuff', published_at: 0 },
]);
store.setState('d', { archived: true });   // archived is a state flag, set after insert

const si = new SearchIndex(store).build();
assert.ok(si.ready, 'index built');

// ── ranking: title hit (a) beats body-only hit (b) ──
const r = si.search('kriging', { limit: 10 });
assert.ok(r.length >= 2, 'both kriging docs found');
assert.equal(r[0].id, 'a', 'title match ranks first (BM25F title boost)');
assert.ok(r.find((h) => h.id === 'b'), 'body-only match also found');
assert.ok(r[0].score > r.find((h) => h.id === 'b').score, 'title hit scores higher');

// ── fuzzy: a typo still finds it ──
const fz = si.search('krigging', { limit: 10 });   // double-g typo
assert.ok(fz.find((h) => h.id === 'a'), 'fuzzy catches the typo');

// ── prefix: partial term ──
const px = si.search('minecr', { limit: 10 });
assert.ok(px.find((h) => h.id === 'c'), 'prefix matches minecraft');

// ── snippet present (lean index → from the callback) ──
assert.ok(typeof r[0].snippet === 'string' && r[0].snippet.length, 'snippet generated via callback');

// ── scope filter (the app passes this for the current view) ──
const scoped = si.search('kriging', { limit: 10, filter: (id) => id === 'a' });
assert.equal(scoped.length, 1, 'filter scopes results'); assert.equal(scoped[0].id, 'a');

// ── archived items excluded from the index ──
assert.ok(!si.search('archived', { limit: 10 }).find((h) => h.id === 'd'), 'archived doc not indexed');

console.log('search smoke ok:', JSON.stringify({ kriging: r.length, top: r[0].id }));
