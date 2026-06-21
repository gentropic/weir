# SPEC — The Reference Desk (webmcp retrieval tools)

> Expose weir's existing retrieval intelligence — BM25F search, faceted
> intersection, the controlled vocabulary, and the facet-overlap relatedness
> signal — as **read-only MCP tools**, so an external agent can stand at the
> counter and do grounded reference work over the standing archive. weir does
> not generate; the agent does, and is forced to cite because everything it
> learns arrives as a discrete tool result.

> **Companion:** this is the **read half**. The agent's *write half* — curating and
> acquiring sources/books/links/tags, and the provenance taxonomy that marks who
> added what — is [librarian.md](librarian.md). Same agent, same corpus.

> **Status: IMPLEMENTED (2026-06-21).** Design record — kept for the rationale; the
> authoritative summary is GLASS.md §17. What shipped: `weir_queryCatalog` (§2.2,
> commit `2ff00f2`), `weir_quote` (§3.2b, `40d5c8d`), **archive-visibility on
> `weir_search` + `weir_queryCatalog`** (§2.1, `2c21322` — index holds archived; default
> include, `includeArchived:false` to limit; the inbox UI stays archived-free via its
> view filter), and **batch `weir_getItems`** (§3.3, `2c21322`). The other "core" tools
> were already shipped (`weir_search` = §2.1, `weir_vocab` = §2.3, `weir_relatedTo` = §3.1).
> Facet-filtered search was **subsumed by `weir_queryCatalog({facets,q})`** — not built
> separately (avoids a redundant verb). Still deferred: semantic recall (§3.4, gated),
> full-body indexing (§2.1; excerpt-ranked for now), and a separate archived index if the
> all-items index grows costly at scale.

| | |
|---|---|
| **Package** | `@gcu/weir` (webmcp surface) |
| **Implements** | the reference half of GLASS.md §8 (query / reference interview) |
| **Status** | Implemented — see the status note above + GLASS.md §17. |
| **Audience** | weir's Claude Code |
| **Design language** | Switchboard — weir's |

---

## 0. Ground yourself first

This spec was written from a shallow clone and partial reads. Before implementing,
read the real surfaces — they are the contract, not my paraphrase of them:

- `src/js/search.js` — `SearchIndex` (build / scheduleRebuild / **search**). Already
  BM25F, title-boosted, fuzzy+prefix, over the in-memory corpus.
- `vendor/librarian.js` — `Librarian.index(...)` / `Librarian.search(...)` → hits
  `[{ id, score, doc, snippet, hits }]`. Also a substring `scan(...)` path.
- `src/js/glass.js` — `FACETS`, `TOPICAL_FACETS`, `facetsOf`, `sharedTopicalTerms`,
  `relatednessScore`, `RELATION_TYPES`. The facet-overlap *proposer* lives here.
- `GLASS.md §3` — the `/glass-index/` layout: `facets/<facet>.json` (inverted
  `term → [glass_id]`), `vocabulary.json`, `relations.json`. Derived, rebuildable.
- `src/js/webmcp.js` (~line 840+) — the tool registration shape: objects with
  `{ name, fn, description, inputSchema }`. Mirror it. Read `weir_queryItems` and
  `weir_getItem` closely; the new tools sit beside them, same conventions.
- `tools/smoke-*.mjs` — the node smoke-test convention (`smoke-search`, `smoke-glass`,
  `smoke-webmcp`, `smoke-relate` already exist). Every new tool gets one.

If anything below contradicts the code, the code wins — note the divergence and
proceed.

---

## 1. Why this exists

The reference desk is **not built into weir**. GLASS.md §1.1 already drew the line:
dumb pipes, smart service. weir is a clean deterministic interface over structured
data; the intelligence lives on top via webmcp and is "not the core." This spec
just sharpens the pipes so the agent at the counter is sharper.

The motivating exercise was NotebookLM. The conclusions worth carrying in:

- **The corpus is the advantage.** NotebookLM's ceiling is the friction of
  assembling a throwaway notebook (sources dragged in, capped, ephemeral). weir's
  archive is durable, deduped, cataloged, and grows on a schedule. The reference
  desk queries the *standing library*, not a hand-built folder. Lean into that —
  these tools operate over the whole corpus, archive included (see §2.1 caveat).
- **Grounding with provenance is the whole product.** Every useful thing
  NotebookLM does reduces to: answer only from the sources, cite back to the exact
  span. Our tools must return enough locating information that an agent can cite
  precisely and a human can open the source and check. Provenance is structural
  here, not bolted on — the agent only knows what a tool handed it.
- **Strict-grounding is a mode, not the default.** An agent over webmcp blends the
  catalog with its own world knowledge — better for "help me think," worse for
  "tell me strictly what my corpus says." That distinction is a *prompt/usage*
  convention, not code; but the tools must make strict mode *possible* by always
  carrying provenance, so an agent told "sources only" can refuse to exceed what
  the tools returned. Build for that discipline; don't enforce it in weir.
- The studio glitz (video, kawaii slides, flashcards) is noise. Ignore it.

### 1.1 The boundary this must respect — decides vs. proposes (GLASS §2.1)

These are **reference** tools: they retrieve, rank, and relate. None of them
*decides* anything that becomes catalog truth. Ranking, similarity, and relatedness
are *proposals* — fuzzy as they like — because the agent or a human ratifies
downstream; nothing files itself. So:

- **No generation inside weir.** SPEC §8 keeps opaque synthesis a non-goal. These
  tools return cards, spans, ranked ids, vocabulary — never prose answers.
- **No embeddings as the retrieval substrate.** BM25F + facet intersection + the
  relation graph are the spine. If semantic recall is ever added, it enters only
  as a *proposer* widening the candidate set fed into the ranked list (§3.4),
  never replacing it, never auto-filing. This is the §2.1 line, held exactly.
- **No agentic composite tool.** Ship primitives; let the agent orchestrate the
  reference interview (§4). A `weir_reference` god-tool that does
  decompose→retrieve→synthesize in one call would pull intelligence back into the
  core. Don't. (If you think a *thin* composite that only chains the read
  primitives — no LLM — earns its keep, make the case in §6.)

---

## 2. Core tools (the three)

All read-only. All return provenance (item/glass id + locating info) on every
result. Namespace `weir_` per the existing convention.

### 2.1 `weir_searchRanked` — ranked relevance search **[core]**

The gap that motivated this: `weir_queryItems`'s `q` is substring-only. weir
*has* ranked BM25F (`SearchIndex.search`) but never exposed it. Wrap it.

- **Wraps:** `SearchIndex.search(q, opts)` → librarian hits
  `[{ id, score, doc, snippet, hits }]`.
- **Inputs:** `q` (required), `limit` (default 20, cap 100), and — composing with
  the catalog — optional facet/type/view filters passed through as the librarian
  `filter(docId)` predicate (reuse the `weir_queryItems` filter vocabulary:
  `feed`, `category`, `type`, `view`, `saved`, plus facet filters once §2.2 lands).
- **Returns:** ranked `[{ id, score, title, snippet, feed, published, glass_id?,
  facets? }]`. Include `glass_id` and cataloged facets when the item is cataloged,
  so one call gives both relevance and classification.

Two real limitations in the current index — decide and document how you handle each:

1. **It indexes title + excerpt, not full bodies.** Ranking over excerpts is
   shallow for reference depth. Indexing `/content` bodies is heavier but is what
   makes "find the source that actually discusses X" work. Recommend: add an
   opt-in full-body index path (or a second index), gated, with the RAM cost noted
   the way `search.js` already notes corpus size. At minimum, expose whether a hit
   matched on body vs excerpt.
2. **It excludes archived items.** weir never deletes — it archives. A reference
   desk that can't see the archive is half-blind. Add an `includeArchived` input
   (default true for this tool; the inbox UI's exclusion is a UI concern, not a
   reference concern).

### 2.2 `weir_queryCatalog` — faceted intersection **[core]**

Ranganathan's whole point (GLASS §2): interdisciplinary material is an
*intersection query*, not a filing problem. Expose the facet inverted index.

- **Reads:** `/glass-index/facets/<facet>.json` (inverted `term → [glass_id]`).
  Intersect across facets; union within a facet's term list.
- **Inputs:** a facet→terms map, e.g.
  `{ domain: ["geostatistics"], entity: ["kriging","itabirite"], process: ["estimation"] }`,
  plus `limit` and an optional free-text `q` to AND a ranked-search constraint
  (compose with §2.1). Terms should be matched against the *controlled* vocabulary
  — if a passed term isn't a preferred term, resolve it via §2.3 and say so in the
  result (don't silently miss; fail loud, per §2.1).
- **Returns:** `[{ glass_id, title, facets, matchedTerms, document_ref }]`, plus a
  `vocabularyNotes` block when input terms were non-preferred or unknown.

### 2.3 `weir_vocab` — controlled-vocabulary lookup **[core]**

The reference interview is "what they *need* vs. what they *asked*" (GLASS §2, §8).
Mechanically that's: take the agent's loose term, resolve it to the catalog's
actual vocabulary before searching. This tool is what lets an agent decompose a
query well instead of guessing the corpus's words.

- **Reads:** `/schema/vocab/<facet>.json` (preferred terms, scope notes,
  thesaurus relations) and `/glass-index/vocabulary.json` (occurrence counts).
- **Inputs:** `term` (required), optional `facet` to scope, optional
  `mode: "resolve" | "browse"` (resolve = "what's the preferred term + relations
  for this"; browse = "list terms under this facet / near this term").
- **Returns:** `{ input, preferred, facet, scopeNote?, broader[], narrower[],
  related[], useFor[], count }`. This is the thesaurus *failing loudly* — synonyms
  resolve to a preferred term, unknown terms come back unmatched with near-misses,
  nothing silently collapses (the explicit contrast with embeddings, GLASS §1).

---

## 3. Candidate tools — "whatever you think is worth"

Build the ones that earn their keep; argue down the ones that don't.

### 3.1 `weir_related` — facet-overlap neighborhood **[strong candidate]**

glass.js already has the proposer: `sharedTopicalTerms` + `relatednessScore`
(IDF-weighted shared topical-facet terms) over `TOPICAL_FACETS`. That *is* a
"what else is near this" reference verb, with zero embeddings — exactly the §2.1
proposer and ROADMAP's "UMAP on facet vectors, no embedding model needed" lineage.

- **Inputs:** `id` or `glass_id`, `limit`, optional `minScore`.
- **Returns:** `[{ glass_id, title, score, sharedTerms }]` ranked by relatedness.
- Also surface the card's *declared* graph edges (`card.glass.related`,
  `RELATION_TYPES`) distinctly from the *proposed* facet-overlap neighbors — the
  agent should see which links a human ratified vs. which the signal suggests.
  (`weir_getItem` already returns `links`/`backlinks`; keep that the citation-chain
  path and let this be the relatedness path.)

### 3.2 Span-level provenance — the one genuinely new bit **[candidate, scope it]**

NotebookLM-grade citation is "this *sentence* supports that claim." Today
`weir_getItem` returns a body capped at 8k and `search.js` runs `positions: false`,
so there are no stable offsets. Citation is currently card-level. To get
span-level, the cleanest options (pick one, or argue for card-level-is-enough):

- **(a) Locators in results.** Turn positions on (or add a locator pass) so search
  hits and getItem can return stable `glass_id#start–end` spans the agent cites.
  Cost: index size / rebuild time — measure it.
- **(b) `weir_quote` verify tool.** Given `id` + a candidate quote, return the
  surrounding context and a stable locator, or report no-match. Cheaper; turns the
  agent's citation into a checkable claim without indexing every offset. This pairs
  well with strict-grounding mode (§1) — the agent can self-verify before
  asserting.

Recommend (b) first; it's the smaller change and directly serves provenance.
Whatever you build, it's a derived/rebuildable artifact beside `/glass-index/`,
never a mutation of `/catalog/` (source of truth).

### 3.3 `weir_getItems` (batch) **[nice-to-have]**

Reference work fans out: one search → pull ten cards. A batch `getItem` (ids[],
optional `content`) saves a round-trip storm. Mirror `weir_getItem`'s shape.

### 3.4 Semantic recall as a *proposer* **[deferred — gate hard]**

Only if BM25F + facets prove insufficient in real use, and only as a recall
widener feeding §2.1's ranked list — never the substrate, never auto-filing.
Respect single-file/zero-dep: a model fetch is a runtime download, not a bundled
dep, and it stays optional. Default: don't build this yet. Lexical + faceted
retrieval over a *curated* corpus is usually enough; prove the need first.

---

## 4. Intended composition (document, don't encode)

The reference interview is the agent's job, run over these primitives:

1. `weir_vocab` to resolve the user's loose terms to preferred vocabulary
   (decompose "what they need vs. asked").
2. `weir_queryCatalog` (facet intersection) and/or `weir_searchRanked` (relevance)
   to retrieve candidates — facets for precision, BM25F for recall, composed.
3. `weir_related` to widen to the neighborhood when the direct hits are thin.
4. `weir_getItem` / `weir_getItems` to pull bodies + citation chain
   (`links`/`backlinks`); `weir_quote` to verify before asserting.
5. The agent synthesizes **with citations back to ids/spans** — in strict mode,
   asserting nothing the tools didn't return.

Put this flow in the tool descriptions and/or a short `webmcp` doc note so a fresh
agent discovers the intended path. The orchestration lives in the agent. weir just
answers.

---

## 5. Non-goals (restated, so they don't drift)

- No prose generation, summarization, or synthesis inside weir (SPEC §8).
- No embeddings as retrieval substrate (§2.1, §3.4).
- No agentic loops or composite "smart" tools in core (§1.1).
- No writes from reference tools. Curation writes (`addFeed`, `relateCards`,
  cataloging…) already exist as their own gated tools; keep reference read-only.
- No new dependencies; `node build.js` stays zero-dep, single-file output.

---

## 6. Open questions for the implementer

- **Card-level vs span-level citation** — is `weir_quote` (3.2b) enough, or does
  real use demand offsets (3.2a)? Your call after trying it.
- **One tool or two for search+facets** — `weir_searchRanked` with facet filters
  vs. a separate `weir_queryCatalog`. Spec'd as two (different mental models:
  relevance vs. intersection); collapse them if the filter composition makes one
  redundant.
- **Full-body indexing** — worth the RAM, or keep excerpt-ranked + on-demand body
  fetch? Measure against the real corpus (400+ feeds).
- **A thin no-LLM composite** (§1.1) — does chaining the read primitives into one
  `weir_lookup` call genuinely help an agent, or is it core-creep? Argue it.
- Anything you see in the code that this spec got wrong or missed.

---

## 7. Done means

- New read tools registered in `webmcp.js`, same `{name,fn,description,inputSchema}`
  shape, descriptions written so a cold agent finds the §4 path.
- Each tool has a `tools/smoke-*.mjs` matching the existing convention; `npm run
  smoke` green.
- `node build.js` produces a working single-file `index.html`; tools callable over
  the bridge/MCP channel.
- A short note (README or a `webmcp` section) describing the reference desk and the
  intended composition, plus whatever candidate tools you chose and why.
