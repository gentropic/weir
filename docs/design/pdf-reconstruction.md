# PDF reconstruction — geometry-aware text + tables (design)

**Status:** design / direction. Feeds **SPEC-documents §3** (the extraction-quality slice) and a
prospective **GCU PDF processing toolkit**. Not yet built — `documents.js` currently does naive
text-layer join (`pdfjs-naive-v0`); this note is the plan to do it right.

## The problem

A PDF is a *presentation* format — positioned glyph runs, not logical text. Naive
`getTextContent()` → concatenate yields interleaved columns, missing spaces, broken hyphens,
header/footer pollution, and no table structure. For grounded retrieval + page-anchored quoting
(and any real *data* extraction), the post-processing **is** the feature. The CCG guidebooks are
two-column; naive order shuffles them into nonsense.

## Prior art — `pdfgeologist` (the base to build on)

An earlier, *working* geometry-extraction toolkit by the author + a collaborator (a COVID-era
project pulling analyte data out of **thousands of environmental-lab-report PDFs**, where the tables
and numbers were the whole point). Python, `pdfminer`-based, with geometry reasoning over the page.
Stowed (gitignored, not public) at **`personal/reference/pdfgeologist.py`** as the reference.

Its architecture is the right one, and we adopt the model (re-implemented in browser-native JS over
`pdf.js`, not Python — the GCU runtime is the browser):

1. **Geometry as a flat, queryable table.** Collapse the page into rows of positioned elements:
   `element_type (text_line | rect | curve) · x0,y0,x1,y1 · page · text`. Every later step is then a
   *spatial query* over this table. (weir today **discards** the bbox — capturing it is step 0.)
2. **Drawn rules are the grid.** Table row boundaries come from the **y-positions of the `rect`/
   `curve` elements** (the ruled lines), not from guessing text gaps — `cut(text.y, rect_ys)` bins
   lines into rows. The lines the PDF *draws* tell you the cells.
3. **A spatial relational toolkit** — `right/left/above/below`, `clip(box)`, `merge_lines(x_tol,
   y_tol, align)`, and a fluent `Document → Page → Element` API (`page.element_right(text="pH")`).
   This is how you read *labeled fields* ("value to the right of 'Sample ID'") and walk a layout.
4. **Multi-page table stitching** — follow a table across pages until the **header changes** or a
   **y-gap** signals the end (`stop_criteria = header | gap`, with header-matching). The genuinely
   hard real-world part — already solved here.
5. **Visual bbox-overlay debugging** — render the page to an image and draw the element boxes over
   it. Indispensable for *developing* geometry logic — and the **same substrate as PDF
   highlight/annotation** (the roadmapped S-Pen feature). Build it once, use it twice.

### Honest caveat
`pdfgeologist` is **semi-supervised / per-template** — the table extractor is *told* the table's
`y_top`, `columns`, and `stop_keyword` per report layout. It worked because the lab reports came in
a handful of templates you could script against. It is **not** fully-automatic table detection. So
the **geometry-as-table model + the relational toolkit are the reusable gold**; arbitrary-PDF
auto-tables stay hard (hence the spec's stance: rule-based column pass for *search*, and *show the
page-image region* where text fails rather than fabricate structure).

## Mapping into weir §3 (sequence)

1. **Step 0 — capture geometry in `extractPdfText`.** Per-item bbox + font from `getTextContent`
   (pdf.js gives `transform` / `width` / `str` / `fontName`). Emit the flat positioned-element model
   instead of a joined string. Cheap; **everything** below depends on it. Bump `EXTRACT_ALGO`.
2. **Reading order (the two-column win)** — x-clustering / XY-cut to detect columns, order L→R, lines
   top→bottom within each; insert spaces on x-gaps; de-hyphenate line-end breaks; strip repeating
   headers/footers. This is what makes CCG-guidebook search text coherent.
3. **The relational toolkit in JS** — `right/left/above/below/clip/merge_lines` over the element
   table → labeled-field extraction + assisted tables.
4. **Table grid** — drawn lines/rects from pdf.js's **operator list** (harder than pdfminer's
   `LTRect`; later tier) → the rule-based aligned-column pass.
5. **Debug overlay** — pdf.js canvas render + bbox boxes (dev tool now; annotation layer later).

Because extraction is a **re-runnable derived layer** stamped with `extract_algo` (the binary is the
source of truth), the corpus can be ingested now (naive) and re-extracted in place as each step lands.

## The bigger frame — a GCU PDF processing toolkit

The geometry model isn't weir-specific. It wants to be a **GCU primitive** (a `@gcu/*` package,
vendored-as-source per the zero-dep ethos — pure JS over `pdf.js`, no Python/server): the
flat-element model + the relational toolkit + the reconstruction passes. **weir's §3 is the first
consumer; FormatLegis** (the same collaborator's legislation-extraction project — `formatlegis-db`
already uses pdfminer) is a natural **second consumer**. Designing the reconstruction as a shared
toolkit rather than weir-internal pays off across the constellation.
