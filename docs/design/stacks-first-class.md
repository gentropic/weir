# SPEC — Stacks as first-class corpus (knowledge-graph + foldering + partial edit)

> **Status: IMPLEMENTED (2026-06-22).** Design record — kept for the rationale +
> alternatives + deferred work; the authoritative summary is GLASS.md §17.5 and
> STACKS.md §6. Originally a **librarian** draft (`claude:librarian`, `source:agent`)
> for the **dev agent** (`claude:dev`) to build; direction ratified by Arthur 2026-06-22.
> The librarian proposes; the dev decides. This spec is the **prerequisite for
> `SPEC-repos-as-source`** (a dive-map must be a graph citizen before a repo can hang
> its docs off it) — that one stays staged for review.

---

## Problem

The stacks vault holds the librarian's real work product — dive-maps, the constellation
map (`gcu/README.md`), briefs. But stacks notes were second-class in three concrete ways:

1. **They didn't participate in the knowledge graph.** A note couldn't `relate` to an
   item or another note, and nothing surfaced backlinks — so the constellation the
   librarian built (auditable ↔ bma ↔ hopper ↔ capsule/cradle/numen ↔ press …) lived as
   *prose cross-references*, not a navigable graph.
2. **Bare-path writes silently routed to `inbox/`.** `weir_stacksWrite('gcu-constellation.md', …)`
   landed at `inbox/gcu-constellation.md` with no signal — a surprising place for a
   permanent doc.
3. **No partial edit.** `weir_stacksWrite` only *overwrites* a whole note, so a one-line
   change meant rewriting the entire note (and tripping the "one stacks write per message"
   index-race workaround).

(Notes were *already* searchable — `SearchIndex.build()` indexes every item including the
`stacks` feed — and *already* quotable/citable — they're items with ids and `weir_quote`
reads their bodies. So "searchable/citable/quotable" needed nothing; the gap was the
graph, the foldering signal, and partial edit.)

## The design fork — and why stub cards

The knowledge graph is **edges-on-cards**: an edge lives on `card.glass.related`, keyed by
`glass_id` (GLASS §10). Every read/write path — `proposeRelated` (facet co-occurrence),
`relatedOf` (+ the backlink scan), `pendingProposals`, `ratifyEdge`, the app review UI,
persistence (card shards) — is defined over cards. A note only *has* a `glass_id` once
cataloged. So "relate accepts note uids" forced a choice:

- **A — catalog-first:** require a note be cataloged before relating. Minimal, but a fresh
  dive-map can't relate without a manual catalog step.
- **B-awful — a second edge store:** store edges on item records *too*, keyed by item id,
  merged with card edges at read time. This is the trap: two id-spaces, "is X related to Y"
  depends on which address you used, the backlink scan walks two stores and normalizes ids,
  every read path forks. **Rejected.**
- **B-clean (chosen) — graph membership mints a card.** When `relate` is given an item with
  no `glass_id`, auto-create a deterministic **Stage-0 stub card** (`buildCard`, no LLM),
  marked `glass.via:'relate'`. From that point the *entire existing pipeline works
  unchanged* — the node has a card like everything else. An uncataloged note becomes
  relatable immediately; a later full catalog **reuses the same card** (`catalogStoreItem`
  keys on `item.glass_id`), so the edges are preserved.

Why B-clean over rewriting the substrate to be item-keyed (the "purest" form): in a mature
app with **live graph data**, reusing the proven, tested edge+review path beats migrating
every existing edge and changing the persistence location — far less risk of orphaning live
edges. The one honest cost is contained and flagged below.

## What shipped

### Part A — notes in the graph
- **`store.ensureCard(itemId)`** — idempotent; returns the existing `glass_id` or mints a
  Stage-0 stub (`glass.via:'relate'`). The single new graph-membership primitive.
- **`store.wikiLinksOf(itemId)`** — the soft link layer: resolves the item's `[[ref]]`
  out-links (by stacks **uid → exact title (ci) → file basename**, with/without extension)
  and its W3C-annotation `target`, plus inbound backlinks (items whose `[[ref]]`/`target`
  resolves to this one). Unresolved out-links stay **dangling markers** (ref only), not
  errors. This is *not* the ratified graph — it surfaces the prose cross-references the
  librarian already writes by convention.
- **`weir_relate`** — `from`/`to` accept item id, glass_id, **or stacks path**; an
  uncataloged endpoint is auto-carded (`toGlassId(ref, {create:true})`). `remove:true`
  resolves without creating (nothing to remove if uncataloged). Edge still stamped
  `source:agent` + identity, still a `relation` proposal in the review queue.
- **`weir_relatedTo`** — accepts path/id/glass_id; **no longer throws** on an uncataloged or
  unknown ref (returns an empty graph + an explanatory `note`); always attaches the
  `wikilinks` layer when present.

### Part B — foldering signal
- **`weir_stacksWrite`** reports its destination: a bare write (no folder, no folder in the
  path, not an update) returns `folder`, `routedToInbox:true`, and a `note`. The `inbox/`
  default is now explicit triage, never silent. (Behavior unchanged — only the report is
  new; `weir_stacksList` already exposed the folder tree, `weir_stacksMove` already relocates.)

### Part C — partial edit
- **`StacksStore.editNote(item, {find, replace, replaceAll?} | {append})`** — exact-string
  find/replace (unique unless `replaceAll`) or append a trailing block; rides on `saveNote`
  so uid/created/title/tags/source are preserved. Explicit errors (not-found / not-unique),
  mirroring the agent `Edit` tool.
- **`weir_stacksEdit`** — the MCP wrapper (notes only; files rejected). Returns the updated
  note + its (capped) body.

## The honest cost (flagged for review)

A stub is a card with no real catalog content, so the invariant "a card = a fully
cataloged item" is now "a card = a catalog node, possibly a Stage-0 stub." Mitigations
in place: the stub carries deterministic Stage-0 facets (so it isn't blank), is marked
`glass.via:'relate'` for audit, and is `needs_review` so a real pass can enrich it. The
catalog **review queue is unaffected** — its catalog half reads the app-only `_cardReview`
cache (populated by the live cataloger), which stubs never enter. If stub leakage into the
coverage stat / faceted browser ever bites, the `glass.via` marker is the hook to exclude
them; not done now (the Stage-0 card is a legitimate catalog state, and bulk `buildCatalog`
already cards everything at Stage-0).

## Tests
`tools/smoke-stacks-graph.mjs` (wired into `npm run smoke`): bare-path write reports
`routedToInbox`; relate-by-path auto-cards two uncataloged notes and the edge + backlink
are navigable from either end; `ensureCard` idempotent; `[[Title]]` and `[[uid]]` resolve,
a dangling `[[ref]]` stays a marker, the target shows the wiki-backlink; `weir_stacksEdit`
find/replace + append + replaceAll, with not-found / not-unique errors. The existing
`smoke-webmcp.mjs` assertion that `relatedTo` *throws* on an unknown id was updated to the
new return-a-note behavior.

## Deferred
- **Batch `weir_stacksEdit`** (`edits:[…]` applied atomically) — would also retire the
  "one stacks write per message" workaround via a documented transaction guarantee. Single
  op + append shipped; batch left for when the need is concrete.
- **Item-keyed graph substrate** (the "purest" B): not pursued — stub cards reuse the live
  pipeline with far less risk. Revisit only if the card-invariant tax becomes painful.
- **Stub exclusion** from coverage/browser/works — deferred (see "honest cost").
