// Bibliographic enricher — detect arXiv/DOI/ISBN + fetch authoritative metadata
// (mock responses) + overlay onto a card. Run: node tools/smoke-biblio.mjs
import assert from 'node:assert';
import { detectBiblio, fetchBiblio, applyBiblio } from '../src/js/biblio.js';

// ── detection ──
assert.deepEqual(detectBiblio('https://arxiv.org/abs/2401.12345'), { kind: 'arxiv', id: '2401.12345' }, 'arxiv abs');
assert.deepEqual(detectBiblio('https://arxiv.org/pdf/2401.12345v2'), { kind: 'arxiv', id: '2401.12345' }, 'arxiv pdf + version stripped');
assert.equal(detectBiblio('https://arxiv.org/abs/math.GT/0309136').kind, 'arxiv', 'old-style arxiv id');
assert.deepEqual(detectBiblio('https://doi.org/10.1038/nature12373'), { kind: 'doi', id: '10.1038/nature12373' }, 'doi.org');
assert.equal(detectBiblio('https://www.nature.com/articles/10.1038/s41586-021-03819-2').kind, 'doi', 'bare DOI in path');
assert.deepEqual(detectBiblio('https://openlibrary.org/isbn/9780262033848'), { kind: 'isbn', id: '9780262033848' }, 'isbn-13');
assert.equal(detectBiblio('https://example.com/book?isbn=0262033844').kind, 'isbn', 'isbn-10 in query');
assert.equal(detectBiblio('https://hackaday.com/2026/05/29/a-thing/'), null, 'a normal article is not bibliographic');
assert.equal(detectBiblio(''), null, 'empty → null');

// ── fetch + normalize (mock fetch per host) ──
const mkRes = (body, ok = true) => ({ ok, status: ok ? 200 : 404, async text() { return body; } });
const fetch = async (url) => {
  if (url.includes('export.arxiv.org')) return mkRes(`<feed><entry>
    <title>Attention Is All You Need</title>
    <summary>The dominant sequence transduction models are based on complex recurrent networks.</summary>
    <published>2017-06-12T17:57:34Z</published>
    <author><name>Ashish Vaswani</name></author><author><name>Noam Shazeer</name></author>
  </entry></feed>`);
  if (url.includes('api.crossref.org')) return mkRes(JSON.stringify({ message: {
    title: ['A Crispr Tale'], author: [{ given: 'Jane', family: 'Doe' }, { given: 'R', family: 'Roe' }],
    issued: { 'date-parts': [[2013, 8, 25]] }, abstract: '<jats:p>We show <b>a thing</b>.</jats:p>',
    'container-title': ['Nature'], publisher: 'Springer', type: 'journal-article' } }));
  if (url.includes('openlibrary.org')) return mkRes(JSON.stringify({ 'ISBN:9780262033848': {
    title: 'Introduction to Algorithms', subtitle: 'Third Edition', authors: [{ name: 'Thomas H. Cormen' }],
    publish_date: '2009', publishers: [{ name: 'MIT Press' }], cover: { medium: 'https://covers/x.jpg' } } }));
  return mkRes('', false);
};

const ax = await fetchBiblio({ kind: 'arxiv', id: '1706.03762' }, { fetch });
assert.equal(ax.title, 'Attention Is All You Need', 'arxiv title');
assert.deepEqual(ax.creators, ['Ashish Vaswani', 'Noam Shazeer'], 'arxiv authors');
assert.equal(ax.date, '2017-06-12', 'arxiv date');
assert.match(ax.abstract, /sequence transduction/, 'arxiv abstract');

const cr = await fetchBiblio({ kind: 'doi', id: '10.1038/nature12373' }, { fetch, mailto: 'me@x.com' });
assert.equal(cr.title, 'A Crispr Tale'); assert.deepEqual(cr.creators, ['Jane Doe', 'R Roe']);
assert.equal(cr.date, '2013-08-25', 'crossref date zero-padded'); assert.equal(cr.abstract, 'We show a thing.', 'jats stripped');
assert.equal(cr.publisher, 'Nature', 'container-title preferred as publisher');

const ol = await fetchBiblio({ kind: 'isbn', id: '9780262033848' }, { fetch });
assert.equal(ol.title, 'Introduction to Algorithms: Third Edition'); assert.deepEqual(ol.creators, ['Thomas H. Cormen']);
assert.equal(ol.cover, 'https://covers/x.jpg', 'cover captured');

// not-found → null, never throws
assert.equal(await fetchBiblio({ kind: 'doi', id: '10.0/nope' }, { fetch: async () => mkRes('', false) }), null, 'http error → null');
assert.equal(await fetchBiblio(null, { fetch }), null, 'no detection → null');
assert.equal(await fetchBiblio({ kind: 'arxiv', id: 'x' }, {}), null, 'no fetch → null');

// ── applyBiblio overlays authoritative DC, leaves description/identifier ──
const card = { dublin_core: { title: 'wrong title', creator: [], date: '2099', identifier: 'https://arxiv.org/abs/1706.03762', description: 'llm summary' }, facets: {}, glass: { confidence: 0.7 } };
const merged = applyBiblio(card, ax);
assert.equal(merged.dublin_core.title, 'Attention Is All You Need', 'title overwritten from source');
assert.deepEqual(merged.dublin_core.creator, ['Ashish Vaswani', 'Noam Shazeer'], 'creators from source');
assert.equal(merged.dublin_core.date, '2017-06-12', 'date from source');
assert.equal(merged.dublin_core.description, 'llm summary', 'LLM description left alone');
assert.equal(merged.dublin_core.identifier, 'https://arxiv.org/abs/1706.03762', 'identifier (url) left alone');
assert.equal(merged.glass.biblio, 'arxiv', 'source stamped in glass.biblio');

console.log('biblio smoke ok:', JSON.stringify({ arxiv: ax.title, doi: cr.date, isbn: ol.creators[0] }));
