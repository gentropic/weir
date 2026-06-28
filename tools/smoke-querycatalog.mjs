// weir_queryCatalog tests (SPEC-reference-desk §2.2): faceted INTERSECTION query —
// union within a facet, intersect across facets, vocab resolution (synonym → preferred),
// fail-loud on unknown/zero-hit terms, and free-text q composition. Run:
//   node tools/smoke-querycatalog.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { buildWeirTools } from '../src/js/webmcp.js';

const store = new Store(await VFS.create()); await store._hydrate();
await store.putFeed({ id: 'f', name: 'Geo', adapter: 'feed', url: 'http://x/f' });
await store.upsertItems([
  { id: 'i1', feed_id: 'f', type: 'paper', title: 'Ordinary kriging of iron ore', url: 'x1', published_at: 1 },
  { id: 'i2', feed_id: 'f', type: 'video', title: 'Banded iron formations explained', url: 'x2', published_at: 2 },  // 'itabirite' lives in facets, NOT the title
  { id: 'i3', feed_id: 'f', type: 'paper', title: 'Minecraft redstone computing', url: 'x3', published_at: 3 },
]);

// Injected catalog facets (as if cataloged) — the topical facets queryCatalog intersects.
const F = (o) => ({ domain: [], entity: [], process: [], method: [], scale: [], spatial: [], stance: [], form: [], provenance: [], temporal: [], ...o });
const facets = new Map([
  ['i1', F({ domain: ['geostatistics'], entity: ['kriging', 'iron-ore'], process: ['estimation'], form: ['paper'], spatial: ['tokyo'] })],
  ['i2', F({ domain: ['geostatistics', 'geology'], entity: ['itabirite', 'iron-ore'], form: ['video'], spatial: ['osaka'] })],
  ['i3', F({ domain: ['gaming'], entity: ['minecraft'], form: ['video'], spatial: ['paris'] })],
]);
store.items.get('i1').glass_id = 'g1';   // a cataloged item → glass_id surfaces in output

const tools = buildWeirTools({ store, cardFacets: () => facets });

// ── intersection across facets ──
let r = await tools.queryCatalog({ facets: { domain: ['geostatistics'], entity: ['kriging'] } });
assert.equal(r.total, 1, 'domain ∩ entity → only i1'); assert.equal(r.items[0].id, 'i1');
assert.ok(r.items[0].matchedTerms.entity.includes('kriging'), 'matchedTerms carries the why');
assert.equal(r.items[0].glass_id, 'g1', 'cataloged item surfaces its glass_id');
assert.deepEqual(r.items[0].facets.entity, ['kriging', 'iron-ore'], 'the item facets are returned');

// ── union within a facet (kriging OR itabirite), still intersected with domain ──
r = await tools.queryCatalog({ facets: { domain: ['geostatistics'], entity: ['kriging', 'itabirite'] } });
assert.equal(r.total, 2, 'entity union ∩ geostatistics → i1 + i2');
assert.deepEqual(r.items.map((x) => x.id).sort(), ['i1', 'i2']);

// ── the motivating case: found via facet though the word is absent from the title ──
assert.ok(!store.getItem('i2').title.toLowerCase().includes('itabirite'), 'precondition: itabirite not in i2 title');
r = await tools.queryCatalog({ facets: { entity: ['itabirite'] } });
assert.equal(r.total, 1, 'entity:itabirite finds i2 (what excerpt search misses)'); assert.equal(r.items[0].id, 'i2');

// ── vocabulary resolution: a synonym resolves to its preferred term ──
store.recordSynonym('entity', 'kriging', 'ok');   // 'ok' (ordinary kriging) → preferred 'kriging'
r = await tools.queryCatalog({ facets: { entity: ['ok'] } });
assert.equal(r.items[0].id, 'i1', "synonym 'ok' resolved to 'kriging' → i1");
assert.ok(r.vocabularyNotes.some((n) => n.input === 'ok' && n.resolvedTo === 'kriging'), 'resolution reported in vocabularyNotes');

// ── fail loud: an unknown / zero-hit term is reported, not silently missed ──
r = await tools.queryCatalog({ facets: { entity: ['nonsense-term'] } });
assert.equal(r.total, 0, 'no hits for a bogus term');
assert.ok(r.vocabularyNotes.some((n) => /0 items|not in the controlled/.test(n.note)), 'zero-hit / unknown term flagged');

// ── unknown facet name is flagged, not thrown ──
r = await tools.queryCatalog({ facets: { bogusFacet: ['x'] } });
assert.ok(r.vocabularyNotes.some((n) => /unknown facet/.test(n.note)), 'unknown facet flagged');

// ── compose with free-text q (AND a ranked/substring search constraint) ──
r = await tools.queryCatalog({ facets: { domain: ['geostatistics'] }, q: 'kriging' });
assert.ok(r.items.length === 1 && r.items[0].id === 'i1', 'q ANDs a search constraint (kriging → i1 only, i2 dropped)');

// ── archive visibility: archived items are included by default, excluded on demand ──
store.items.get('i1').archived = true;   // archive the kriging paper
r = await tools.queryCatalog({ facets: { entity: ['kriging'] } });
assert.ok(r.items.some((x) => x.id === 'i1'), 'archived item still found by default (reference desk sees the archive)');
r = await tools.queryCatalog({ facets: { entity: ['kriging'] }, includeArchived: false });
assert.ok(!r.items.some((x) => x.id === 'i1'), 'includeArchived:false excludes the archived item');
store.items.get('i1').archived = false;   // restore

// ── hierarchical roll-up (GLASS §7 thesaurus): a parent term catches its subtree ──
store.setVocabRelation('spatial', 'japan', 'narrower', ['tokyo', 'osaka']);   // japan ⊃ tokyo, osaka
store.setVocabRelation('spatial', 'asia', 'narrower', ['japan']);             // asia ⊃ japan (transitive)
assert.deepEqual([...store.descendantTerms('spatial', ['japan'])].sort(), ['japan', 'osaka', 'tokyo'], 'descendantTerms walks narrower');
assert.deepEqual([...store.descendantTerms('spatial', ['asia'])].sort(), ['asia', 'japan', 'osaka', 'tokyo'], 'descendantTerms is transitive');
r = await tools.queryCatalog({ facets: { spatial: ['japan'] } });
assert.deepEqual(r.items.map((x) => x.id).sort(), ['i1', 'i2'], 'spatial:japan rolls up to tokyo+osaka items (not paris)');
assert.ok(r.items.find((x) => x.id === 'i1').matchedTerms.spatial.includes('tokyo'), 'matchedTerms reports the item\'s actual child term (tokyo) that satisfied the parent query');
assert.ok(!(r.vocabularyNotes || []).some((n) => n.term === 'japan' && /0 items/.test(n.note)), 'the parent (japan), credited via its subtree, is NOT flagged zero-hit');
r = await tools.queryCatalog({ facets: { spatial: ['asia'] } });
assert.deepEqual(r.items.map((x) => x.id).sort(), ['i1', 'i2'], 'spatial:asia rolls up transitively (asia→japan→tokyo/osaka)');

// ── validation: facets is required ──
await assert.rejects(tools.queryCatalog({}), /facets/, 'missing facets throws a helpful error');

console.log('queryCatalog (facet intersection + roll-up) smoke ok');
