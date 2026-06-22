# SPEC — Retrieval tuning (the cheap precision wins, before embeddings)

> **Status: IMPLEMENTED (the cheap tier, 2026-06-22)** — #1 curation weighting + #2 metadata
> rerank (shipped as one reranker) + #4 curated/source scoping. **Deferred:** #3 graph-expansion
> retrieval mode, and the dense multilingual lane (behind this, per the spec). Authoritative
> summary: GLASS.md §17.1. Originally a **librarian** draft (`claude:librarian`, `source:agent`)
> from the repo-ingest pilot; direction ratified by Arthur 2026-06-22. The librarian proposes;
> the dev decides.

---

## Why

Ingesting the constellation exposed a retrieval **precision** failure, not a recall one: a broad
query (`"single-file offline-first browser-as-runtime owned not rented"`) was swamped by generic
feed matches (an NYT op-ed, a shapefile browser) while the signal — books, notes, repo `doc`
items, saved links, the *owned/curated minority* — ranked no higher. The corpus is ~20k items,
~80% auto-ingested feed/video firehose. So the highest-leverage fixes are **ranking + scoping**,
no ML — and they recover most of what looked like "we need embeddings."

## What shipped — one reranker + a scope (in `weir_search` / `webmcp.search`)

#1 and #2 are the same mechanism (curation weighting *is* the source-class component of a
metadata reranker), so they shipped as **one post-hoc rescore of the lexical top-k**:

- **Pool, rescore, slice.** Fetch a larger lexical pool from the librarian index (≈5× the
  requested limit, capped 200), multiply each hit's BM25 score by a `rankFactor`, re-sort, slice
  to `limit`. A reranker can only reorder what it sees, hence the larger pool.
- **`rankFactor` = curation tier × facet-match.** `curationTier(item)`: `curated` (books, notes,
  `doc` items, and the `stacks`/`saved`/`books`/`repo:*` sources) ×2.5; `firehose` (feed/youtube
  adapters) ×0.6; `neutral` ×1.0. Facet-match: ×(1 + 0.2·min(overlap,5)) when query terms ∈ the
  item's facet terms — this pulls the "the term is in the facets, not the title" recall (the
  `entity:"itabirite"` case) into *ranking*, not just `queryCatalog`.
- **On by default for the reference desk**, with escape hatches: `rerank:false` (raw BM25),
  `curated:true` (#4 — hard-scope to the curated tier; the feed firehose excluded). Each hit
  carries its `tier`, so the ranking is inspectable (weir's auditable ethos).

## Tuning — per-call weight override (added 2026-06-22)

The default weights are a **commit-reviewed constant** (the persistent policy). For tuning,
`weir_search` accepts an **ephemeral per-call** `weights:{curated,neutral,firehose,facet}`
override (clamped 0–10) + `explain:true` (surface each hit's raw `lex` score + the `weights`
used). This collapses the eval loop from multi-deploy to one session: the librarian sweeps
weights against its pinned queries live, finds the set that flips the failing case without
burying good feed hits, and reports it — then the winner is baked into the constant in one
change. On-ethos: **unbounded experimentation, zero persistent consequence** until a human
ratifies the new default into code (mirrors the librarian's "bounded in consequence" posture).
A persistent default *outside* code — a human-set Settings field the agent proposes values for
— is the deferred option if weights ever need to live there; an *agent-writes-the-default*
tool is deliberately **not** offered (it's policy, a decides-vs-proposes line).

## Scope decisions
- **MCP-search only.** The rerank lives in `webmcp.search` (the reference desk), not the in-app
  search path — the inbox UI sometimes genuinely wants the feed firehose, and it has its own
  view scoping. Same `SearchIndex`, different wrapper.
- **Recency omitted.** The spec listed it ("mild"); deliberately dropped — a reference corpus
  wants the canonical *old* source (a 1963 paper) to keep ranking, not be demoted for age. It's
  a tunable that can be added if the eval ever wants it.
- **Conservative weights** (curated 2.5×, firehose 0.6×) — strong enough to flip the failing
  case, gentle enough not to bury a genuinely relevant feed hit. The eval set keeps it honest.

## Evaluation set (the acceptance test — runs against LIVE weir, not a node smoke)
The eval needs the real ~20k corpus (the FSA-mounted store), so it can't run in CI. The **smoke**
(`tools/smoke-rerank.mjs`) proves the *logic* on synthetic items (curated outranks an
equal-lexical firehose hit; `rerank:false` disables; `curated:true` scopes; facet-match lifts a
non-title hit). The **librarian re-runs the pinned queries against the deployed build**:
- **Broad/curated** — `"single-file offline-first browser-as-runtime owned not rented"`: curated
  items rank above feed slop. *(The target case for the rerank.)*
- **Specific** — `"block model atelier streaming web worker"`: the repo README **and** its
  dive-map surface together. *(Must not regress.)*
- **Cross-lingual** — EN↔pt-BR: a **known gap**, the residual for the deferred dense lane — not a
  regression.

## EVAL2 follow-up — accented-term expansion (2026-06-22)

The librarian validated #3.5 live but found an asymmetry: `geoestatística` (pt-BR) didn't expand
to `geostatistics` while ASCII terms (`krigagem`) did. Cause was weir-side: the query tokenizer
in `webmcp.search` was `[^a-z0-9]`, splitting accented terms *at the accent*
(`geoestatística`→`geoestat`+`stica`) so they never reached `expandTerms`. Fixed: tokenize on
`\p{L}\p{N}` (NFC), and `expandTerms` NFC-normalizes the synonym ring — accented terms now stay
whole and bridge to their EN synonyms (which are ASCII and match the index cleanly, even before
the engine's diacritic-tokenizer fix lands).

## Eval outcome + #3.5 vocab-synonym expansion (2026-06-22)

The librarian ran the pinned eval against the deployed build (`retrieval-tuning-EVAL.md`):
**cheap tier validated** — ① broad/curated FIXED (the Hopper dive-map went from buried-#3 to
**#1 curated**; the op-ed + shapefile dropped out of the top 12), ② specific improved (BMA map
#1 + its repo doc #2), ③ cross-lingual still the expected gap. No weight tuning was requested
(2.5/0.6 held). It surfaced one cheap next-knob, now **shipped**:

- **Vocab-synonym query expansion (`store.expandTerms` + `weir_search` `expand`, default on).**
  The seeded `weir_vocab` alt pairs (kriging↔krigagem, mining↔mineração) did **not** bridge
  `weir_search` — a pt-BR query stayed inside pt-BR content. Now a query term that is a
  concept's prefLabel or altLabel (any facet) is expanded with the rest of that concept's
  **synonym ring** (prefLabel + altLabels) before BM25 — so the seeded pairs pay off
  *lexically*, delivering much of the EN↔pt-BR win **with no embeddings**, and finally making
  the vocab-seeding visible in retrieval. Ring only (not broader/narrower → no over-broadening);
  capped per term; `expanded:{term→[syns]}` surfaced for transparency; `expand:false` for the
  literal query. This is the librarian's "#3.5" — cheaper than, and ahead of, the dense lane,
  which now narrows to the true residual (untranslated paraphrase, terms not in the vocab).

Also flagged by the eval, **not yet done** (low priority): repo `doc` items rank below Saved
Links in the broad query because they're *uncataloged* (no facet-match bonus) — fixable with a
small repo-doc/notes sub-boost (testable via the per-call `weights` override) or by cataloging
the ingested docs (opt-in). The target fix holds regardless.

### EVAL3 precision findings (2026-06-22) — saved-tier fix shipped; two routed upstream

A deeper eval (`retrieval-tuning-EVAL3-precision.md`) surfaced two precision issues. The
diagnosis corrected the note's framing:

- **Curated-tier junk → FIXED (weir-side).** Shopping bookmarks (a soldering kit, a
  picture-frame shop, an S Pen page — all *Saved Links*) were riding the full curated ×2.5 and
  topping geology queries. Fix: Saved Links get their **own softer tier** (`saved` ×1.4) —
  above the firehose, well below authored/owned content (books/notes/repo docs ×2.5). The
  `curated:true` *scope* still includes them (`isCuratedScope`); only the *weight* drops. This
  also **defuses the visible symptom of the fuzzy finding below** — the kit topped at 70.7
  *because* it was boosted ×2.5; at ×1.4 it falls below the real BMA drillhole docs (52.8). The
  librarian/Arthur triaging genuine commerce bookmarks is the complementary curation step (his
  links, his call).
- **"Stemmer collision" → actually FUZZY matching (routed upstream).** `sondagem` (drilling)
  matching `soldagem` (welding) is **not** a stemmer — there's no stemmer; it's
  Damerau-Levenshtein typo tolerance (`fuzzy:1`), and the two words are edit-distance 1.
  `nearTerms` has no length/ratio gate and doesn't down-weight fuzzy vs exact. Root fix is in
  the **vendored `@gcu/librarian` engine** (auditable), not weir.
- **Diacritic split (routed upstream).** The engine tokenizer `/[a-z0-9']+|[^\x00-\x7f]+/`
  splits accented Latin *at the accent* (`geoestatística` → `geoestat` + `í` + `stica`), so
  accented pt-BR words never form a clean token — this, not a general alt-as-query gap, is why
  `geoestatística`↛`geostatistics`. Fix = fold accented Latin to ASCII in `tokenize` (+ a
  reindex). Engine-level (auditable).

Both engine findings were **routed back to the librarian** (`_inbox`) to carry to the
`@gcu/librarian`/auditable side — they touch the shared search primitive + need a reindex, so
they're not weir-local edits.

## Deferred
- **#3 graph-expansion retrieval ("synthesis-first, sources-by-edge").** Return a synthesis note
  (a dive-map) as the entry hit, then expand along `related`/`same-topic` edges to the primary
  docs. Partly doable today by composition (`weir_search` → `weir_relatedTo`); a dedicated mode
  is a convenience worth its own pass. Noted in ROADMAP.
- **The dense multilingual lane** (the semantic-search brief / a future `SPEC-hybrid-retrieval`)
  — deferred *behind* this cheap tier, scoped to the curated layer, for the true residual
  (cross-lingual + paraphrase). Order: curation-weighting → metadata rerank → graph expansion →
  facet scoping → *then* dense, if still needed.

## Tests
`tools/smoke-rerank.mjs` (wired into `npm run smoke`) — the rerank logic, `rerank:false`,
`curated:true`, and the facet-match bonus. Live eval: the librarian's three pinned queries.
