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

## The rest of the constellation — four prior arts, four strategies

A survey of the GCU repos turned up *three more* PDF implementations beyond pdfgeologist. The ideal
toolkit converges all four — each contributes a different layer:

| where | approach | what to harvest |
|---|---|---|
| **pdfgeologist** (`personal/reference/`, gitignored) | pdfminer + geometry reasoning, relational queries, table-stitch | the **deep geometry model** — the default tier |
| **holocene** `src/holocene/research/pdf_handler.py` + `pdf_metadata_extractor.py` (Python) | **fallback chain** pypdf → pdfplumber → **pytesseract OCR**; + **LLM** metadata/summary; + (design `research_mode.md`) **vision-model figure/table** analysis | the **robustness ladder + enrichment** |
| **weir** `documents.js` | pdf.js, content-addressed blob, re-runnable `extract_algo`, catalog-card output | the **browser-native runtime + architecture** |
| **formatlegis-db** `verify.py` | pdfminer.six, **cross-checks extracted values against the source PDF** | **extraction-as-audit** |

Two findings shape the design:
- **Holocene already built the robustness pattern** (in Python): coverage-driven fallback to deeper
  parsers then OCR, LLM-extracted metadata, and overnight multimodal figure reading. We port the
  *patterns* (not the Python) — weir has the pieces (the cataloger LLM-as-service + canvas render).
- **pdfgeologist → FormatLegis are the same domain** (environmental lab data, same collaborator):
  extract analyte values from report PDFs → normalize the EDD → check against legislation limits. So
  a GCU PDF toolkit + glass cataloging could host that **whole real pipeline**, not just the CCG
  guidebooks — a much bigger payoff than a single corpus.

### External references (gaps the prior art doesn't cover)
- **pdfplumber** — the matured, open version of pdfgeologist's exact model (words/lines/rects as
  objects; **lattice** vs **stream** tables). The API + table heuristics to aim at.
- **camelot/tabula** — the ruled-vs-unruled (lattice/stream) table duality as an explicit mode.
- **Docling / marker / Nougat / GROBID** — layout-ML / math / TEI extractors. Heavy/server-ish →
  the **offline escape hatch** (run externally, ingest the markdown), *not* the in-browser default.
- **tesseract.js** (WASM) — the scanned-page OCR rung. **pdf.js `getOperatorList`** — the vector
  ops (lines/rects) for the table grid; **canvas render** — page images for OCR + annotation.

## The robustness ladder + the audit move (cross-cutting)

Beyond geometry, two things from the constellation belong in every extraction:
- **Honest robustness ladder** (holocene): per-page **coverage metric** (chars vs. area) → if sparse,
  a deeper geometry pass → if still sparse, **OCR** → else flag `text:'none'`. Emit a per-page
  `text-layer | ocr | none` signal. **No silently-empty bodies** (auditable-by-construction).
- **Extraction-as-audit** (formatlegis-db): because the binary is content-addressed and kept, an
  extracted value / quote can be **re-verified against the source** — a GCU-native quality move that
  pairs with page-bbox anchoring (`weir_quote`). "Trust, but the receipt is the binary."

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

## The bigger frame — a `@gcu/pdf` toolkit (and how to get there)

The geometry model isn't weir-specific. It wants to be a **GCU primitive** (a `@gcu/*` package,
vendored-as-source per the zero-dep ethos — pure JS over `pdf.js`, no Python/server): the
flat-element model + the relational toolkit + the reconstruction passes + the robustness ladder.

**Spec status (surveyed 2026-06-24):** *no GCU PDF toolkit is specced anywhere.* **Auditable** —
where the `@gcu/*` primitives live (vfs, librarian, …) — has **nothing PDF**; its specs are
language/geometry/crypto/UI. The only existing spec is **weir's `SPEC-documents.md`** (§3 extraction
queued) + holocene's design notes. So the toolkit is unclaimed territory; this note is the brief.

**The build path — don't spec the primitive abstractly first.** Build **§3 inside weir** (geometry
capture → reading order → robustness ladder), prove it on the CCG corpus, **then extract the reusable
core to `@gcu/pdf` in `auditable/ext/`** — exactly how cursor-scan search graduated into
`@gcu/librarian`. A real consumer (weir, then FormatLegis + the lab-data pipeline) validates the API
before it's frozen, instead of guessing it upfront.

**Consumers** (the constellation payoff): **weir §3** (first), then **FormatLegis** / the
environmental-lab-data pipeline (same domain as pdfgeologist — extract → normalize EDD → check vs
legislation limits), and any GCU surface that needs to ground answers in PDFs. Designing it as a
shared, graduated primitive — rather than weir-internal — is what makes that whole pipeline possible.
