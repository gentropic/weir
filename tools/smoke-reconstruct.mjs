// reconstructText (SPEC-documents §3 base) against a synthetic element model (node, no pdf.js — the
// reconstruction is a PURE function over positioned elements). Verifies reading order (top→bottom,
// left→right), x-gap space insertion, paragraph breaks, and the page-offset map. The pdf.js geometry
// capture (extractPdfElements) is browser-only — proven via __weir.testPdf, not here.
// Run: node tools/smoke-reconstruct.mjs
import assert from 'node:assert';
import { reconstructText } from '../src/js/documents.js';

// y INCREASES UPWARD (PDF space). size=12 → gapSpace=3, lineTol=6, paraGap=19.2.
const els = [
  // page 1, line A (y=700): "Hello" [10..40], "World" [50..90] — gap 10 > 3 → a space between them
  { page: 1, x0: 10, y0: 700, x1: 40, y1: 712, str: 'Hello', size: 12 },
  { page: 1, x0: 50, y0: 700, x1: 90, y1: 712, str: 'World', size: 12 },
  // line B just below (y=686, gap 14 > lineTol but < paraGap) → next line, same paragraph
  { page: 1, x0: 10, y0: 686, x1: 60, y1: 698, str: 'next line', size: 12 },
  // line C far below (y=650, gap 36 > paraGap) → a paragraph break before it
  { page: 1, x0: 10, y0: 650, x1: 60, y1: 662, str: 'new para', size: 12 },
  // deliberately OUT OF ORDER in the array + a same-line fragment to prove sorting + x-order
  { page: 2, x0: 40, y0: 500, x1: 70, y1: 512, str: 'second', size: 12 },
  { page: 2, x0: 10, y0: 500, x1: 35, y1: 512, str: 'first', size: 12 },   // gap 35→40 = 5 > 3 → space
];

const r = reconstructText(els, 2);

assert.equal(r.pageCount, 2, 'page count');
assert.equal(r.pages[0].text, 'Hello World\nnext line\n\nnew para', 'page 1 reading order + space + paragraph break');
assert.equal(r.pages[1].text, 'first second', 'page 2 sorted left→right despite array order, with x-gap space');
assert.equal(r.text, 'Hello World\nnext line\n\nnew para\n\nfirst second', 'full text joins pages with a blank line');
assert.deepEqual(r.pageOffsets, [{ page: 1, start: 0 }, { page: 2, start: 'Hello World\nnext line\n\nnew para\n\n'.length }], 'page offsets point at each page text start (after the separator)');
assert.equal(r.text.slice(r.pageOffsets[1].start, r.pageOffsets[1].start + 5), 'first', 'offset[1] lands exactly on page 2 text');

// no elements on a page → empty text, still offset-mapped
const r2 = reconstructText([{ page: 1, x0: 0, y0: 10, x1: 5, y1: 22, str: 'x', size: 12 }], 3);
assert.equal(r2.pages.length, 3, 'all pages present');
assert.equal(r2.pages[1].text, '', 'empty page → empty text');

console.log('reconstruct (geometry → reading-order text) smoke ok');
