// WebMCP adapter tool logic (buildWeirTools) over a real Store — no browser.
// Run: node tools/smoke-webmcp.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { buildWeirTools } from '../src/js/webmcp.js';

const store = new Store(await VFS.create()); await store._hydrate();
await store.putFeed({ id: 'f', name: 'Boing Boing', adapter: 'feed', url: 'http://b/f' });
await store.upsertItems([
  { id: 'a1', feed_id: 'f', type: 'article', title: 'Jack Daniel preacher', author: 'Jason', url: 'http://b/1', excerpt: 'whiskey history', published_at: Date.parse('2026-05-01'), tags: ['whiskey'], content: '<p>full whiskey text here</p>' },
  { id: 'v1', feed_id: 'f', type: 'video', title: '3D Print Farm', url: 'http://b/2', published_at: Date.parse('2026-05-02') },
]);

const tools = buildWeirTools({ store });

// ── queryItems ──
const all = await tools.queryItems({});
assert.equal(all.count, 2, 'all items');
assert.ok(all.items.every((i) => i.id && i.title && i.feed === 'Boing Boing'), 'compact projection');

const q = await tools.queryItems({ q: 'whiskey' });
assert.equal(q.count, 1); assert.equal(q.items[0].id, 'a1', 'text search hits a1');
assert.ok(q.items[0].published.startsWith('2026-05-01'), 'published as ISO');

const vids = await tools.queryItems({ type: 'video' });
assert.equal(vids.count, 1); assert.equal(vids.items[0].id, 'v1', 'type filter');

const capped = await tools.queryItems({ limit: 999 });
assert.equal(capped.count, 2, 'limit cap does not error');

// ── pagination: keyset cursor, newest first (v1 2026-05-02 before a1 2026-05-01) ──
const p1 = await tools.queryItems({ limit: 1 });
assert.equal(p1.count, 1); assert.equal(p1.total, 2); assert.equal(p1.hasMore, true);
assert.equal(p1.items[0].id, 'v1', 'page 1 = newest'); assert.ok(p1.nextCursor, 'nextCursor present');
const p2 = await tools.queryItems({ limit: 1, cursor: p1.nextCursor });
assert.equal(p2.items[0].id, 'a1', 'page 2 = next item, no overlap');
assert.equal(p2.hasMore, false, 'no more after last'); assert.ok(!p2.nextCursor, 'no cursor at the end');
const pBad = await tools.queryItems({ cursor: 'garbage!!' });
assert.equal(pBad.count, 2, 'bad cursor → ignored, full set');

// ── getItem ──
const it = await tools.getItem({ id: 'a1', content: true });
assert.equal(it.title, 'Jack Daniel preacher');
assert.equal(it.author, 'Jason');
assert.match(it.content_text, /full whiskey text here/, 'content_text extracted + stripped');
await assert.rejects(tools.getItem({ id: 'ghost' }), /No item/, 'missing id errors helpfully');
await assert.rejects(tools.getItem({}), /No item/, 'missing id param errors');

// ── listFacets (Stage-0 deterministic) — bounded { total, terms, omitted } ──
const f = await tools.listFacets();
assert.ok(f.form.terms.find((t) => t.term === 'article' && t.count === 1), 'form: article');
assert.ok(f.form.terms.find((t) => t.term === 'video' && t.count === 1), 'form: video');
assert.equal(f.form.total, 2, 'form total');
assert.ok(f.provenance.terms.find((t) => t.term === 'web-feed' && t.count === 2), 'provenance: web-feed ×2');
assert.ok(f.temporal.terms.find((t) => t.term === '2026' && t.count === 2), 'temporal: 2026 ×2');
assert.ok(f.entity.terms.find((t) => t.term === 'whiskey' && t.count === 1), 'entity from tags');

// caps: limit + facet drill-down + omitted bookkeeping
const cap = await tools.listFacets({ facet: 'form', limit: 1 });
assert.deepEqual(Object.keys(cap), ['form'], 'facet filter returns only that facet');
assert.equal(cap.form.terms.length, 1, 'limit caps terms');
assert.equal(cap.form.omitted, 1, 'omitted = total - shown');

// archived items are excluded from facets + default query
store.setState('v1', { archived: true });
const f2 = await tools.listFacets();
assert.ok(!(f2.form.terms.find((t) => t.term === 'video')), 'archived item dropped from facets');
const inbox = await tools.queryItems({});
assert.equal(inbox.count, 1, 'archived item dropped from default query');

// ── mutations: setState (read/saved/archived, reversible) ──
const upd = await tools.setState({ id: 'a1', saved: true, read: true });
assert.equal(upd.saved, true); assert.equal(upd.read, true, 'setState applied');
assert.equal(store.getItem('a1').saved, true, 'persisted to store');
await tools.setState({ id: 'a1', saved: false });
assert.equal(store.getItem('a1').saved, false, 'reversible');
await assert.rejects(tools.setState({ id: 'a1' }), /at least one/, 'needs a field');
await assert.rejects(tools.setState({ id: 'ghost', read: true }), /No item/);

// ── catalog control (mock app) ──
const calls = [];
const mockApp = {
  catalogAll: () => { calls.push('start'); return { running: true, todo: 3 }; },
  stopCatalog: () => { calls.push('stop'); return true; },
  catalogStatus: () => ({ running: false, progress: { total: 3, done: 1, failed: 0 } }),
  catalogItem: async (id) => { calls.push('item:' + id); store.getItem(id).glass_id = 'glass-x'; return { ok: true, card: { facets: { domain: ['x'] } } }; },
};
const ctlTools = buildWeirTools({ store, app: mockApp });
assert.deepEqual(await ctlTools.catalogControl({ action: 'start' }), { running: true, todo: 3 }, 'start');
const status = await ctlTools.catalogControl({});   // default status
assert.equal(status.running, false); assert.equal(status.total, 2); assert.ok('cataloged' in status, 'status has counts');
assert.deepEqual(await ctlTools.catalogControl({ action: 'stop' }), { stopped: true }, 'stop');
// clear: writes a card, then clears it
await store.writeCard({ glass: { document_ref: 'a1', cataloged: '2026-06-01' }, facets: {}, dublin_core: {} });
assert.ok((await store.catalogCount()) >= 1, 'a card exists');
const cleared = await ctlTools.catalogControl({ action: 'clear' });
assert.ok(cleared.cleared >= 1, 'clear removed cards');
assert.equal(await store.catalogCount(), 0, 'catalog empty after clear');
await assert.rejects(ctlTools.catalogControl({ action: 'nope' }), /start \| stop \| clear \| status/);
// catalogItem requires app
await assert.rejects(tools.catalogItem({ id: 'a1' }), /only available/, 'catalogItem needs app');

console.log('webmcp tools smoke ok:', JSON.stringify({ items: all.count, facets: Object.keys(f).length, mutations: calls.length }));
