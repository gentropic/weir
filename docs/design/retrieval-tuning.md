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
