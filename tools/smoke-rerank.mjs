// Retrieval tuning (SPEC-retrieval-tuning): weir_search reranks the curated minority over
// the feed firehose (no ML), with a facet-match bonus, plus a curated:true hard-scope.
// Run: node tools/smoke-rerank.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { SearchIndex } from '../src/js/search.js';
import { buildWeirTools } from '../src/js/webmcp.js';

const store = new Store(await VFS.create()); await store._hydrate();
await store.putFeed({ id: 'f', name: 'Feed', adapter: 'feed', url: 'http://f/x' });           // firehose source
await store.putFeed({ id: 'stacks', name: 'Stacks', adapter: 'stacks', url: '', next_poll_at: 8.64e15 });   // curated source
const Q = 'single-file offline browser owned rented';
await store.upsertItems([
  { id: 'fh', feed_id: 'f', type: 'article', title: Q, excerpt: 'an op-ed about ownership' },   // firehose, strong lexical
  { id: 'stacks:n', feed_id: 'stacks', type: 'note', title: Q, excerpt: 'the GCU posture' },     // curated, same lexical
  // facet-match pair (same firehose tier): both match "kriging" lexically; one also has it as a tag (→ entity facet)
  { id: 'fac', feed_id: 'f', type: 'article', title: 'study one', excerpt: 'geostatistics kriging estimation', tags: ['kriging'] },
  { id: 'nofac', feed_id: 'f', type: 'article', title: 'study two', excerpt: 'geostatistics kriging estimation' },
]);
const app = { searchIndex: new SearchIndex(store).build() };
const t = buildWeirTools({ store, app });

// ── curation rerank: the curated note outranks the firehose item at equal lexical match ──
const r = await t.search({ q: Q });
assert.equal(r.reranked, true, 'reranked by default');
const note = r.items.find((i) => i.id === 'stacks:n'), fh = r.items.find((i) => i.id === 'fh');
assert.ok(note && fh, 'both items found');
assert.ok(r.items.indexOf(note) < r.items.indexOf(fh), 'curated note ranks ABOVE the firehose item');
assert.equal(note.tier, 'curated', 'curated tier surfaced'); assert.equal(fh.tier, 'firehose', 'firehose tier surfaced');
assert.ok(note.score > fh.score, 'curated score is higher post-rerank');

// ── rerank:false → raw BM25 (no tier, no curation reorder) ──
const raw = await t.search({ q: Q, rerank: false });
assert.ok(!raw.reranked, 'rerank:false disables it');
assert.ok(raw.items.every((i) => i.tier === undefined), 'no tier annotation when not reranked');

// ── curated:true → hard-scope to the curated tier (firehose excluded) ──
const cur = await t.search({ q: Q, curated: true });
assert.ok(cur.items.some((i) => i.id === 'stacks:n'), 'curated scope keeps the note');
assert.ok(!cur.items.some((i) => i.id === 'fh'), 'curated scope drops the firehose article');

// ── facet-match bonus: at equal tier + lexical, the item whose facet has the term ranks higher ──
const fr = await t.search({ q: 'kriging' });
const fac = fr.items.find((i) => i.id === 'fac'), nofac = fr.items.find((i) => i.id === 'nofac');
assert.ok(fac && nofac, 'both kriging items found');
assert.ok(fac.score > nofac.score, 'facet-match (kriging in the entity facet via its tag) lifts it above the plain lexical hit');

// ── per-call weight override + explain (ephemeral tuning) ──
// crank firehose ABOVE curated and the firehose item should now outrank the note
const flip = await t.search({ q: Q, weights: { curated: 1, firehose: 5 }, explain: true });
assert.deepEqual(flip.weights, { curated: 1, neutral: 1.0, firehose: 5, facet: 0.2 }, 'explain echoes the (clamped) weights used');
const fn = flip.items.find((i) => i.id === 'fh'), nn = flip.items.find((i) => i.id === 'stacks:n');
assert.ok(flip.items.indexOf(fn) < flip.items.indexOf(nn), 'override flips the order (firehose boosted over curated)');
assert.ok(typeof fn.lex === 'number' && fn.score >= fn.lex, 'explain surfaces the raw lexical score');
// weights are clamped (absurd values bounded, never negative)
const clamped = await t.search({ q: Q, weights: { curated: 999, firehose: -5 }, explain: true });
assert.equal(clamped.weights.curated, 10, 'curated weight clamped to 10');
assert.equal(clamped.weights.firehose, 0, 'negative weight clamped to 0');
// override does nothing when rerank is off
const off = await t.search({ q: Q, weights: { curated: 999 }, rerank: false });
assert.ok(!off.reranked && off.items.every((i) => i.tier === undefined), 'weights ignored when rerank:false');

console.log('rerank smoke ok:', JSON.stringify({ top: r.items[0].id, curated: cur.items.length, flipped: flip.items[0].id }));
