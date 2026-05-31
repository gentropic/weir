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

console.log('webmcp tools smoke ok:', JSON.stringify({ items: all.count, facets: Object.keys(f).length }));
