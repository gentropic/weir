// Glass call number — faceted shelf address from a card. Run: node tools/smoke-callnumber.mjs
import assert from 'node:assert';
import { callNumber, renderCoded, renderReadable, sortKey, DOMAIN_CODES } from '../src/js/callnumber.js';

const card = (facets, dc = {}) => ({ facets, dublin_core: dc });

// ── a geostatistics book: subject-first, curated domain code, author cutter, year ──
const geo = callNumber(card(
  { domain: ['geostatistics', 'mining'], entity: ['kriging'], form: ['book'] },
  { creator: ['Silva, Marcelo'], date: '2023-06-15' },
));
assert.equal(geo.domain, 'GST', 'curated domain code (geostatistics → GST)');
assert.equal(geo.form, 'B', 'form code for a book');
assert.equal(geo.cutter, 'SIL', 'author cutter from surname');
assert.equal(geo.year, '2023', 'year extracted');
assert.equal(renderCoded(geo), 'GST·KRI·B·SIL·23', 'coded rendering (spine)');
assert.equal(renderReadable(geo), 'Geostatistics : Kriging · book Silva 2023', 'readable rendering (UI)');

// ── a paper on the same shelf-spot: subject leads, form differs → they neighbor ──
const paper = callNumber(card({ domain: ['geostatistics'], entity: ['kriging'], form: ['paper'] }, { creator: ['Journel, A G'], date: '2021' }));
assert.equal(renderCoded(paper), 'GST·KRI·P·JOU·21', 'paper coded');
assert.ok(sortKey(geo) < sortKey(paper), 'book sorts before paper at the same subject (B < P) — they shelve together');

// ── derived code for an unmapped domain; subdomain from process when no entity ──
const misc = callNumber(card({ domain: ['underwater-basketweaving'], process: ['tutorial'], form: ['video'] }, {}));
assert.equal(misc.domain, 'UND', 'derived 3-letter code for unmapped domain');
assert.equal(misc.terms.sub, 'tutorial', 'subdomain falls back to process when no entity');
assert.equal(misc.form, 'V', 'video form');

// ── graceful when sparse: unclassified still produces a sortable address ──
const bare = callNumber(card({}, {}));
assert.equal(bare.domain, 'GEN', 'no domain → GEN');
assert.equal(renderReadable(bare), 'Unclassified', 'readable handles empty');
assert.ok(sortKey(bare).startsWith('GEN'), 'sortable even when bare');

// ── sort wanders by subject: a linear browse groups the shelf by topic ──
const cards = [
  callNumber(card({ domain: ['music'], entity: ['synthesis'], form: ['article'] }, { creator: ['Bo'], date: '2020' })),
  callNumber(card({ domain: ['geology'], entity: ['kriging'], form: ['book'] }, { creator: ['Ali'], date: '2019' })),
  callNumber(card({ domain: ['geology'], entity: ['basalt'], form: ['paper'] }, { creator: ['Cox'], date: '2022' })),
];
const order = cards.map(sortKey).sort().map((k) => k.slice(0, 3));
assert.deepEqual(order, ['GEO', 'GEO', 'MUS'], 'the two geology items shelve adjacent, music apart');

assert.equal(DOMAIN_CODES.geology, 'GEO', 'curated map is exported + extensible');
console.log('callnumber smoke ok:', JSON.stringify({ geo: renderCoded(geo), readable: renderReadable(geo) }));
