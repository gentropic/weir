# SPEC — Citation export (`weir_cite`)

> **Status: IMPLEMENTED (2026-06-22).** Design record — kept for the rationale + the
> scope decisions; the authoritative summary is GLASS.md §17.1. Originally a **librarian**
> draft (`claude:librarian`, `source:agent`) for the **dev agent** (`claude:dev`);
> direction ratified by Arthur 2026-06-22, scope expanded with him in review. The
> librarian proposes; the dev decides.

---

## Why

Grounded answers + the librarian's research briefs assert "cite item / glass-id X."
`weir_quote` **verifies** a quote and returns a locator (`glass-…#start-end`) — but there
was **no canonical citation**: a stable, formatted, resolvable reference for an item. So
the reference desk hand-typed ids. A citation primitive closes the loop: **`weir_quote`
(verify) → `weir_cite` (render).** It's the missing half of strict-grounding — weir could
*check* a quote; it couldn't yet *render the reference* for it.

## The reframe (the review)

The draft described a **formatter** (id → a metadata string). In review we reframed it as
**the primitive you write a grounded brief with** — the verb between "I found the source"
and "it's in my document, cited correctly, and the citation still works in six months."
Four upgrades fell out, all four ratified for v1:

1. **Verify-in (the enforcement point).** `weir_cite(id, {quote})` runs the same matching
   `weir_quote` does and embeds the verified verbatim span + locator in the reference — or
   returns `{cited:false}` with **no reference**, so a fabricated claim cannot get a
   citation. cite becomes where strict-grounding is *enforced*, not just decorated. (Reuses
   the existing `quote()` handler — no refactor.)
2. **Batch → a real bibliography.** `weir_cite({ids})` returns per-item entries +
   deterministic **BibTeX-style cite-keys** (disambiguated `a/b/c` within the batch) + an
   assembled, deduped **bibliography** (markdown footnotes by default; `numbered`/`plain`).
   The actual write-a-brief workflow.
3. **Markdown-native + graph-native output.** Because the consumer is markdown briefs +
   stacks notes: a `footnote` form and a `[[handle]]` **wikilink** form. The wikilink is
   the payoff from `SPEC-stacks-first-class` — a citation written into a stacks note is a
   *live graph backlink*, resolved by `wikiLinksOf`. Citing **is** relating.
4. **Honest gaps + durable handles.** Cite what's known, report `missing:[…]` rather than
   fabricate. The reference carries a durable `weir <glass_id|id>` handle (+ locator) that
   survives a dead URL — weir holds the archived copy. Plus a machine **CSL-JSON** object,
   the "don't reinvent a citation-style engine" escape hatch: we render inline /
   reference-list / footnote, and emit CSL-JSON for any house style downstream.

## What shipped

- **`src/js/cite.js`** — pure, zero-dep, deterministic (sibling to `callnumber.js`):
  `citeFields(item,{feed,card})` (pulls author/title/year/container/url/isbn/handle +
  `missing` from the item, its book `structured`, and its glass `dublin_core`), `citeKey`
  (lastname+year, caller-disambiguated via a `seen` set), `formatItem` → `{inline,
  reference, footnote, wikilink, csl, missing}`, and `buildBibliography(entries, style)`.
  CSL `type` mapped from the item type. No network, no fabrication.
- **`weir_cite({ id? | ids?, quote?, locator?, style? })`** — single mode folds
  verification in (or splices a caller-supplied `locator`); batch mode returns `entries` +
  a `keys` map + the `bibliography`. Registered read-only.
- **`store.wikiLinksOf` extended** — resolves a `[[ref]]` by uid → **glass_id** → **item
  id** → title → basename (was uid/title/basename only), and `selfKeys` gained glass_id +
  id. So a cited `[[handle]]` resolves as a live backlink for **any** item, not just notes
  — making "cite = relate" true across the corpus.
- New module registered in `main.js`; its local `yearOf` renamed `citeYearOf` to avoid a
  flat-bundle collision with `glass.js`'s `yearOf` (the build's `node --check` guards this).

## Scope decisions
- **No citation-style engine.** We emit inline + reference-list + footnote + CSL-JSON; APA/
  MLA/Chicago rendering is explicitly out — render those from the CSL-JSON downstream.
- **Pure render, no network.** cite never fetches to fill a gap (that's `weir_catalogItem`
  / biblio at catalog time); it reports `missing` and moves on.
- **Considered alternative — a `citation` field on `weir_getItem`** instead of a tool. A
  dedicated tool won (batch bibliography + verify-in + CSL export are first-class verbs);
  surfacing a citation on reads remains an easy future add if wanted.

## Tests
`tools/smoke-cite.mjs` (wired into `npm run smoke`): deterministic key + every render
form; gap honesty (no author → `missing`, no fabricated fields); verify-in cites a real
quote (locator embedded) and **refuses** one that isn't in the source; batch bibliography +
cite-keys + disambiguation; the `[[handle]]` wikilink resolves as a live backlink via
`wikiLinksOf`.

## Deferred
- A `citation` convenience field on `weir_getItem`/`getItems` output.
- Richer container/publisher metadata for feed items (currently the feed name) — would
  improve reference completeness; gated on better source metadata, not on cite itself.
