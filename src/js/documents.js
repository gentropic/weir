// Documents (PDF) — v0 spike (SPEC-documents). Load pdf.js ON DEMAND from the vendored sibling
// (vendor/pdfjs/, ~1.7 MB) and extract page text. pdf.js is deliberately NOT inlined into
// index.html — it's dynamic-imported on first document use, so it never weighs on base-app
// startup, and the cache-first service worker runtime-caches it (offline after first open).
//
// v0 reading order is NAIVE (join the text-layer items) — the column/de-hyphen/header-strip
// reconstruction (SPEC §3) is the next slice, as a re-runnable `extract_algo` layer on top.

let _pdfjs = null;

// Dynamic-import the vendored pdf.js + point its worker at the vendored sibling. Resolved against
// document.baseURI so it works under any deploy path (gentropic.org/weir/… or localhost/…).
export async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  const base = new URL('vendor/pdfjs/', document.baseURI);
  const lib = await import(/* @vite-ignore */ new URL('pdf.min.mjs', base).href);
  lib.GlobalWorkerOptions.workerSrc = new URL('pdf.worker.min.mjs', base).href;
  _pdfjs = lib;
  return lib;
}

// Extract per-page text from PDF bytes (Uint8Array). Returns
//   { pageCount, pages:[{ page, text }], text, pageOffsets:[{ page, start }] }
// pageOffsets map a char offset in `text` back to a page → the seed for page-anchored weir_quote.
export async function extractPdfText(bytes, { onProgress } = {}) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const pages = []; const pageOffsets = []; let full = '';
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => (it.str || '')).join(' ').replace(/\s+/g, ' ').trim();
      pageOffsets.push({ page: n, start: full.length });
      pages.push({ page: n, text });
      full += (full ? '\n\n' : '') + text;
      try { page.cleanup(); } catch { /* */ }
      if (onProgress) onProgress(n, doc.numPages);
    }
  } finally {
    try { await doc.destroy(); } catch { /* */ }
  }
  return { pageCount: pages.length, pages, text: full, pageOffsets };
}

// Ingest a picked PDF File → a first-class, searchable `document` item (SPEC-documents v0 §2a):
// read bytes → extract text → store.addDocument (content-addressed blob + item + searchable text).
// Returns { id, pageCount, ... } from the extraction. The binary is the source of truth; the text
// is a re-runnable derived layer (the column/de-hyphen reconstruction is the next slice).
export async function ingestPdfFile(file, store, { onProgress } = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const extracted = await extractPdfText(bytes, { onProgress });
  const title = (file.name || 'document').replace(/\.pdf$/i, '');
  const id = await store.addDocument({
    bytes, ext: 'pdf', title, text: extracted.text,
    pageCount: extracted.pageCount, pageOffsets: extracted.pageOffsets, source: 'human',
  });
  return { id, ...extracted };
}
