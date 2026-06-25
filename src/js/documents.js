// Documents (PDF) — v0 spike (SPEC-documents). Load pdf.js ON DEMAND from the vendored sibling
// (vendor/pdfjs/, ~1.7 MB) and extract page text. pdf.js is deliberately NOT inlined into
// index.html — it's dynamic-imported on first document use, so it never weighs on base-app
// startup, and the cache-first service worker runtime-caches it (offline after first open).
//
// Reconstruction (SPEC §3 / docs/design/pdf-reconstruction.md) is layered as a re-runnable
// `extract_algo` step over the geometry model. THIS slice — the base — captures per-item geometry
// (the pdfgeologist/pdfplumber flat positioned-element model) and rebuilds reading order from it
// (line grouping + x-gap spaces + paragraph breaks). Column detection (XY-cut), de-hyphenation, and
// header-strip are the NEXT slices — so two-column pages still interleave until then.

// Bump when the extraction pipeline changes — stamped on each document so a later re-extract pass can
// find + re-process the stale ones (the binary is the source of truth).
export const EXTRACT_ALGO = 'pdfjs-geom-v1';

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

// Extract the flat positioned-element model from PDF bytes (Uint8Array) — the base the whole
// reconstruction (and the future @gcu/pdf toolkit) builds on. One row per text run, with its bbox in
// PDF user space (origin bottom-left, y INCREASES UPWARD — same convention as pdfminer/pdfgeologist):
//   { page, x0, y0, x1, y1, str, size, font }   (y0 = baseline ≈ bottom, y1 = top)
// Needs pdf.js (browser). Returns { pageCount, elements }.
export async function extractPdfElements(bytes, { onProgress } = {}) {
  const pdfjs = await loadPdfjs();
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const elements = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const tc = await page.getTextContent();
      for (const it of tc.items) {
        const str = it.str || '';
        if (!str) continue;
        const t = it.transform || [1, 0, 0, 1, 0, 0];   // [a,b,c,d,e,f]; (e,f) = baseline-left x,y
        const x0 = t[4], y0 = t[5];
        const w = it.width || 0;
        const h = it.height || Math.abs(t[3]) || Math.hypot(t[1], t[3]) || 0;
        elements.push({ page: n, x0, y0, x1: x0 + w, y1: y0 + h, str, size: h, font: it.fontName || '' });
      }
      try { page.cleanup(); } catch { /* */ }
      if (onProgress) onProgress(n, doc.numPages);
    }
  } finally {
    try { await doc.destroy(); } catch { /* */ }
  }
  return { pageCount: doc.numPages, elements };
}

// Reconstruct reading-order text from the element model — PURE (no pdf.js → node-testable). Groups
// elements into lines by baseline y, orders lines top→bottom and items left→right, inserts spaces
// across x-gaps, and breaks paragraphs on larger y-gaps. Tolerances scale to the page's median font
// size (resolution-independent). Single-column reading order; columns are the next slice.
export function reconstructText(elements, pageCount) {
  const pages = []; const pageOffsets = []; let full = '';
  for (let n = 1; n <= pageCount; n++) {
    const els = elements.filter((e) => e.page === n);
    const text = els.length ? reconstructPage(els) : '';
    if (full) full += '\n\n';
    pageOffsets.push({ page: n, start: full.length });   // where THIS page's text begins in `full`
    pages.push({ page: n, text });
    full += text;
  }
  return { pageCount, pages, text: full, pageOffsets };
}

function reconstructPage(els) {
  const sizes = els.map((e) => e.size).filter((s) => s > 0).sort((a, b) => a - b);
  const med = sizes.length ? sizes[sizes.length >> 1] : 10;
  const lineTol = med * 0.5;     // same line if baselines within half a font height
  const gapSpace = med * 0.25;   // a space across an x-gap at least this wide (PDFs omit spaces)
  const paraGap = med * 1.6;     // a blank line between lines farther apart than this
  // top→bottom (y DESC in PDF space), then left→right
  const sorted = [...els].sort((a, b) => (b.y0 - a.y0) || (a.x0 - b.x0));
  const lines = []; let cur = null;
  for (const e of sorted) {
    if (cur && Math.abs(e.y0 - cur.y) <= lineTol) cur.items.push(e);
    else { cur = { y: e.y0, items: [e] }; lines.push(cur); }
  }
  const out = []; let prevY = null;
  for (const line of lines) {
    const items = line.items.sort((a, b) => a.x0 - b.x0);
    let s = ''; let prev = null;
    for (const it of items) {
      if (prev && (it.x0 - prev.x1) > gapSpace) s += ' ';
      s += it.str; prev = it;
    }
    s = s.replace(/\s+/g, ' ').trim();
    if (!s) continue;
    if (prevY != null && (prevY - line.y) > paraGap) out.push('');   // paragraph break
    out.push(s); prevY = line.y;
  }
  return out.join('\n');
}

// Extract per-page reading-order text from PDF bytes. Returns
//   { pageCount, pages:[{ page, text }], text, pageOffsets:[{ page, start }] }
// pageOffsets map a char offset in `text` back to a page → the seed for page-anchored weir_quote.
export async function extractPdfText(bytes, { onProgress } = {}) {
  const { pageCount, elements } = await extractPdfElements(bytes, { onProgress });
  return reconstructText(elements, pageCount);
}

// Ingest PDF BYTES → a first-class, searchable `document` item (SPEC-documents v0): extract text →
// store.addDocument (content-addressed blob + item + searchable text + extract_algo stamp). The
// binary is the source of truth; the text is a re-runnable derived layer (reconstruction next slice).
// The shared core of both the human (file-picker) and agent (mount-drop) ingest paths.
export async function ingestPdfBytes(bytes, store, { title, url, author, source = 'human', added_by, onProgress } = {}) {
  const extracted = await extractPdfText(bytes, { onProgress });
  const id = await store.addDocument({
    bytes, ext: 'pdf', title: title || 'document', url, author,
    text: extracted.text, pageCount: extracted.pageCount, pageOffsets: extracted.pageOffsets,
    extract_algo: EXTRACT_ALGO, source, added_by,
  });
  return { id, ...extracted };
}

// The human path: a picked File → bytes → ingestPdfBytes (title from the filename).
export async function ingestPdfFile(file, store, opts = {}) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const title = opts.title || (file.name || 'document').replace(/\.pdf$/i, '');
  return ingestPdfBytes(bytes, store, { ...opts, title, source: opts.source || 'human' });
}
