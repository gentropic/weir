// Glass knowledge-graph tests: facet-overlap proposals + typed `related` edges
// (GLASS §10, decides-vs-proposes). Run: node tools/smoke-relate.mjs
import assert from 'node:assert';
import { sharedTopicalTerms, relatednessScore, RELATION_TYPES } from '../src/js/glass.js';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';

// ── pure helpers ──
const A = { domain: ['geostatistics'], entity: ['kriging', 'iron-ore'], process: ['estimation'], form: ['paper'], temporal: ['2023'] };
const B = { domain: ['geostatistics'], entity: ['kriging', 'copper'], process: ['estimation'], form: ['video'], temporal: ['2025'] };
const shared = sharedTopicalTerms(A, B);
assert.deepEqual(shared, { domain: ['geostatistics'], entity: ['kriging'], process: ['estimation'] }, 'shared topical terms (form/temporal ignored)');
assert.equal(relatednessScore(shared, () => 1), 3, 'unit-idf score = shared-term count');
assert.ok(relatednessScore(shared, (f, t) => (t === 'kriging' ? 5 : 1)) === 7, 'idf weights rarer terms higher');

// ── store: cards with graded overlap ──
const card = (gid, facets, title) => ({
  dublin_core: { title }, glass: { glass_id: gid, document_ref: 'item-' + gid, related: [] },
  facets: { domain: [], entity: [], process: [], method: [], scale: [], spatial: [], stance: [], form: [], provenance: [], temporal: [], ...facets },
});
const store = new Store(await VFS.create()); await store._hydrate();
const ID = (n) => `glass-20260101-00${n}`;
await store.writeCard(card(ID(1), { domain: ['geostatistics'], entity: ['kriging', 'iron-ore'], process: ['estimation'] }, 'A — OK vs SK kriging'));
await store.writeCard(card(ID(2), { domain: ['geostatistics'], entity: ['kriging', 'copper'], process: ['estimation'] }, 'B — kriging of copper')); // shares 3 incl rare kriging
await store.writeCard(card(ID(3), { domain: ['geostatistics'], entity: ['gold'] }, 'C — gold, geostats only'));                                   // shares 1 (common)
await store.writeCard(card(ID(4), { domain: ['gaming'], entity: ['minecraft'] }, 'D — unrelated'));                                                // shares nothing

// ── proposals: ranked by IDF-weighted overlap, self/unrelated excluded ──
let props = store.proposeRelated(ID(1));
assert.equal(props[0].glass_id, ID(2), 'best match is B (most + rarest shared terms)');
assert.ok(props.find((p) => p.glass_id === ID(3)), 'C is proposed (shares geostatistics)');
assert.ok(!props.find((p) => p.glass_id === ID(4)), 'D (no shared topical terms) is not proposed');
assert.ok(!props.find((p) => p.glass_id === ID(1)), 'self is never proposed');
assert.ok(props.find((p) => p.glass_id === ID(2)).score > props.find((p) => p.glass_id === ID(3)).score, 'B outranks C');
assert.ok(props.find((p) => p.glass_id === ID(2)).shared.entity?.includes('kriging'), 'proposal carries the "why" (shared kriging)');

// ── ratify: typed edge stored on the from-card, idempotent ──
const edge = store.relateCards(ID(1), ID(2), { type: 'same-topic', source: 'human' });
assert.equal(edge.type, 'same-topic'); assert.equal(edge.target, ID(2));
const c1 = await store.getCard(ID(1));
assert.equal(c1.glass.related.length, 1, 'edge stored on the card');
store.relateCards(ID(1), ID(2), { type: 'same-topic' });
assert.equal((await store.getCard(ID(1))).glass.related.length, 1, 'idempotent per (target,type)');

// ── ratified edge is excluded from future proposals ──
props = store.proposeRelated(ID(1));
assert.ok(!props.find((p) => p.glass_id === ID(2)), 'already-related card drops out of proposals');

// ── relatedOf: outgoing + backlinks (the scan) ──
assert.equal(store.relatedOf(ID(1)).outgoing[0].glass_id, ID(2), 'outgoing resolved');
assert.equal(store.relatedOf(ID(1)).outgoing[0].title, 'B — kriging of copper', 'outgoing title resolved');
const back = store.relatedOf(ID(2));
assert.equal(back.outgoing.length, 0, 'B has no outgoing');
assert.equal(back.backlinks[0].glass_id, ID(1), 'B is back-linked from A');
assert.equal(back.backlinks[0].type, 'same-topic');

// ── validation ──
assert.throws(() => store.relateCards(ID(1), ID(1)), /itself/, 'no self-edge');
assert.throws(() => store.relateCards(ID(1), ID(3), { type: 'bogus' }), /unknown relation/, 'type is from the closed set');
assert.ok(RELATION_TYPES.includes('related') && RELATION_TYPES.includes('same-work'), 'relation vocab present');

// ── unrelate ──
assert.equal(store.unrelateCards(ID(1), ID(2)), 1, 'unrelate removes the edge');
assert.equal(store.relatedOf(ID(1)).outgoing.length, 0, 'edge gone');
assert.equal(store.unrelateCards(ID(1), ID(2)), 0, 'unrelate is a no-op when absent');

console.log('relate (glass KG) smoke ok');
