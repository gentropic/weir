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

// ── a numbered series (YKK): seq keeps the set together + in VOLUME order ──
// All volumes share author/subject/form, so before `seq` they'd sort by year and a
// reprint (shared year) would scramble. With seq they group + order by volume.
const ykk = (n, date) => callNumber(
  card({ domain: ['manga'], entity: ['slice-of-life'], form: ['book'] }, { creator: ['Ashinano, Hitoshi'], date }),
  { series: 'YKK', seq: n },
);
const v3 = ykk(3, '1996'), v10 = ykk(10, '2001'), v1 = ykk(1, '1994');
assert.equal(v3.seq, 3, 'seq carried onto the call number');
assert.equal(v3.series, 'YKK', 'series carried onto the call number');
assert.equal(v3.domain, 'MGA', 'manga is curated to MGA, not the word-like MAN');
assert.equal(renderCoded(v3), 'MGA·SLI·B·ASH·YKK·v.03', 'series volume coded: set code + zero-padded volume, no year');
assert.equal(renderReadable(v10), 'Manga : Slice-Of-Life · book Ashinano · YKK vol. 10', 'series volume readable');
// Volume order holds even when years are out of sequence (reprints): v1 < v3 < v10.
assert.ok(sortKey(v1) < sortKey(v3) && sortKey(v3) < sortKey(v10), 'volumes sort by seq, not year');
// A same-year reprint of two different volumes still sorts by volume, not by title.
assert.ok(sortKey(ykk(2, '2010')) < sortKey(ykk(11, '2010')), 'shared-year reprints still order by volume');
// A standalone book by the same author shelves with — and BEFORE — that author's series.
const ashSolo = callNumber(card({ domain: ['manga'], entity: ['slice-of-life'], form: ['book'] }, { creator: ['Ashinano, Hitoshi'], date: '2008' }));
assert.ok(sortKey(ashSolo) < sortKey(v1), 'standalone (no series) sorts before the author’s numbered series');
// Non-series rendering is untouched by the new fields.
assert.equal(renderCoded(ashSolo), 'MGA·SLI·B·ASH·08', 'standalone coded unchanged (ends in year)');
assert.equal(DOMAIN_CODES.manga, 'MGA', 'curated manga code'); assert.equal(DOMAIN_CODES.comics, 'CMX', 'curated comics code');

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
