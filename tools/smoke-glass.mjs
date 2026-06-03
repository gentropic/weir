// Glass Stage-0 catalog tests (deterministic cards, no LLM). Run: node tools/smoke-glass.mjs
import assert from 'node:assert';
import { buildCard, nextGlassId, provenanceFor, TYPE_TO_FORM, FACETS } from '../src/js/glass.js';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';

// ── nextGlassId / provenance ──
assert.equal(nextGlassId('2026-04-04', 1), 'glass-20260404-001', 'glass_id format');
assert.equal(nextGlassId('2026-04-04', 42), 'glass-20260404-042');
assert.equal(provenanceFor({ adapter: 'youtube' }, { type: 'video' }), 'video-platform');
assert.equal(provenanceFor({ adapter: 'github' }, { type: 'release' }), 'code-host');
assert.equal(provenanceFor({ adapter: 'feed' }, { type: 'article' }), 'web-feed');
assert.equal(provenanceFor(null, { type: 'note' }), 'self', 'notes are self-provenance');

// ── buildCard: maps weir metadata onto the card, language facets left empty ──
const item = {
  id: 'arxiv:2306.001', feed_id: 'arx', type: 'paper',
  title: 'OK vs SK kriging of Fe grade', author: 'Silva, M.A.',
  url: 'https://arxiv.org/abs/2306.001', excerpt: 'Compares OK and SK estimators.',
  published_at: Date.UTC(2023, 5, 15), tags: ['Kriging', 'kriging', 'iron-ore'],
};
const feed = { id: 'arx', name: 'arXiv geo', adapter: 'feed' };
const card = buildCard(item, feed, { glass_id: 'glass-20260404-001', cataloged: '2026-04-04' });

assert.equal(card.dublin_core.title, 'OK vs SK kriging of Fe grade');
assert.deepEqual(card.dublin_core.creator, ['Silva, M.A.'], 'creator is an array');
assert.equal(card.dublin_core.date, '2023-06-15', 'date from published_at');
assert.equal(card.dublin_core.identifier, 'https://arxiv.org/abs/2306.001');
assert.equal(card.dublin_core.source, 'arXiv geo');
assert.deepEqual(card.facets.form, ['paper'], 'form ← type');
assert.equal(TYPE_TO_FORM.book, 'book', 'book type maps to book form (not the article fallback)');
assert.deepEqual(card.facets.provenance, ['web-feed'], 'provenance ← feed');
assert.deepEqual(card.facets.temporal, ['2023'], 'temporal ← year');
assert.deepEqual(card.facets.entity, ['kriging', 'iron-ore'], 'entity ← deduped lowercased tags');
assert.deepEqual(card.facets.domain, [], 'language facets empty (await cataloger)');
assert.equal(card.glass.document_ref, 'arxiv:2306.001', 'pairs back to the item');
assert.equal(card.glass.cataloger, 'stage0-rules');
assert.equal(card.glass.needs_review, true, 'metadata-only card wants the LLM pass');
// every facet present
for (const f of FACETS) assert.ok(card.facets[f] !== undefined, `facet ${f} present`);

// ── store.buildCatalog: emits files, stamps glass_id, idempotent ──
const store = new Store(await VFS.create()); await store._hydrate();
await store.putFeed({ id: 'arx', name: 'arXiv geo', adapter: 'feed', url: 'http://a/f' });
await store.upsertItems([
  { id: 'p1', feed_id: 'arx', type: 'paper', title: 'Paper one', tags: ['kriging'] },
  { id: 'v1', feed_id: 'arx', type: 'video', title: 'A talk' },
]);
const r1 = await store.buildCatalog({ cataloged: '2026-04-04' });
assert.equal(r1.created, 2, 'cataloged both');
assert.ok(store.getItem('p1').glass_id, 'item stamped with glass_id');
assert.equal(await store.catalogCount(), 2, 'two cards on disk');
const c1 = await store.getCard(store.getItem('p1').glass_id);
assert.equal(c1.glass.document_ref, 'p1', 'card round-trips and pairs');

// idempotent: re-run skips already-cataloged items
const r2 = await store.buildCatalog({ cataloged: '2026-04-05' });
assert.deepEqual({ c: r2.created, s: r2.skipped }, { c: 0, s: 2 }, 're-run skips existing');

// survives reload (glass_id persisted in the shard, cards on the backend)
await store.flush();
const re = new Store(store.vfs); await re._hydrate();
assert.equal(re.getItem('p1').glass_id, store.getItem('p1').glass_id, 'glass_id survived reload');
assert.equal(await re.catalogCount(), 2, 'cards survived reload');

// ── review-queue verbs: markCardReviewed(facets) approves+corrects; uncatalogItem discards ──
const p1gid = store.getItem('p1').glass_id;
const reviewed = await store.markCardReviewed(p1gid, { facets: { domain: ['geostatistics'], stance: [] } });
assert.equal(reviewed.glass.needs_review, false, 'approve clears needs_review');
assert.equal(reviewed.glass.reviewer, 'human', 'stamps human reviewer');
assert.deepEqual(reviewed.facets.domain, ['geostatistics'], 'facet correction applied');
assert.deepEqual(reviewed.facets.form, ['paper'], 'untouched facets preserved');
// discard (reject): card gone, item un-stamped, re-cataloguable
const before = await store.catalogCount();
const disc = await store.uncatalogItem('v1');
assert.ok(disc && disc.discarded, 'uncatalogItem reports the discarded card');
assert.equal(store.getItem('v1').glass_id, undefined, 'item un-stamped after discard');
assert.equal(await store.catalogCount(), before - 1, 'one card removed');
assert.equal(await store.uncatalogItem('v1'), null, 'discarding an uncataloged item is a no-op');

console.log('glass smoke ok:', JSON.stringify({ created: r1.created, cards: await store.catalogCount() }));
