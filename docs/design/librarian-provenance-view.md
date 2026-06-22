# SPEC — Librarian provenance view (`weir_listMine`)

> **Status: IMPLEMENTED (2026-06-22).** Design record — kept for the core fork + the
> resolving reframe + the deferred upgrade; the authoritative summary is GLASS.md §17.2.
> Originally a **librarian** draft (`claude:librarian`, `source:agent`) for the **dev
> agent** (`claude:dev`); direction ratified by Arthur 2026-06-22, scope settled in review.
> The librarian proposes; the dev decides.

---

## Why

The librarian adds a lot — notes, tags, typed edges, feeds, books, authored cards — all
stamped `source:agent` + identity. But there was **no way to see "what have I added,"** what's
pending vs ratified, or to audit prior additions. That blocked the memory-hygiene pass
(verifying past contributions still hold), the propose-not-ratify accounting, and
multichannel hygiene (which agent — librarian vs dev — added what).

## The core fork (the review)

**Is `weir_listMine` a query over *current state*, or a *historical audit trail*?** The draft
asked for both, and they conflict:
- Its Notes wanted *"pure query over the existing provenance. No new data model."* →
  current-state.
- But `status:'corrected'` + *"verifying my past contributions still hold / audit and clean
  prior additions"* are historical — they ask what happened to a contribution *after* it was
  made.

And they conflict for a concrete, verified reason: **weir's stamps are *attribution*, not a
*ledger* — every undo/correct path is provenance-destructive.**
- A human correcting an agent-authored card **deletes** the original author:
  `if (opts.by) card.glass.by = opts.by; else delete card.glass.by;` (`store.markCardReviewed`).
- Removing a tag deletes its `tag_by` entry; dismissing an edge unrelates it; dismissing a
  feed removes it. Tags carry **no timestamp** (so `since` can't even filter them).

So from current state you can **never** see "corrected" or "I added this and it's gone now" —
the act you'd audit is the one that erased its own evidence. `status:'corrected'` is
unimplementable as a pure query.

## The resolving reframe

You don't need weir to keep that history — **it already lives in the agent's own memory
files.** So `weir_listMine` is reframed from "an audit log weir maintains" to **"the
ground-truth provenance lens"**: it reports what the footprint *currently is*; the agent
reconciles that against its memory (which holds "what I thought I did"). Memory says *"I tagged
X"* but listMine doesn't show it → drift caught. That delivers all three uses (propose/ratify
ledger, cross-channel, memory-hygiene-by-comparison) with a **pure current-state query** —
exactly the spec's Notes — and `corrected` is dropped (unknowable, and unnecessary under
comparison). This is the on-ethos answer: an auditable-by-construction system offers a lens
onto the truth on the records, rather than growing a parallel event-sourcing layer.

## What shipped

- **Note-identity stamp (the one real prerequisite).** Agent-authored notes carried
  `source:'agent'` but not *which* agent (`stacksWrite` passed only `agentProv().source`). Fixed:
  `writeNote` takes `addedBy` → emits `by` in the note frontmatter (survives a rescan via
  `_scanNote`) + sets `item.added_by`; `saveNote` preserves it; `syncStacksEntry` carries it;
  `stacksWrite` passes `agentProv(client).by`. Human (UI) notes pass nothing and stay
  unattributed — consistent with books/feeds.
- **`store.listMine({ identity, kinds, status })`** — the current-state oracle: a cross-kind
  union (tag · note · edge · feed · book · catalog) of contributions whose stamp matches
  `identity` (or any agent if omitted), each with a per-kind `status`, plus `counts`
  (byKind/byStatus). Pure read over existing stamps.
- **`weir_listMine`** — defaults to the calling channel's identity; `identity:"*"` = any agent
  (cross-channel view); `kinds`/`status` filters; capped output.
- **Status is per-kind, only where a gate exists:** edge/feed/book → `pending | ratified`
  (book also `dismissed` when archived); agent-authored catalog card → `authored`; tag/note →
  `applied`. No `corrected`.

## Scope decisions
- **`since` omitted.** Not all stamps carry a timestamp (tags don't), so a time window would be
  silently partial. Dropped rather than half-delivered.
- **Distinct tool, not folded into `weir_reviewQueue`.** They pair but differ in intent:
  reviewQueue is *the pending tray*; listMine is *the whole footprint, any status*. listMine is
  the cross-kind union neither `weir_queryItems` (items only) nor `weir_reviewQueue` (pending
  only) gives in one lens.

## Deferred — the someday upgrade
- **An append-only contribution log.** If "what I did that was later undone/corrected" ever
  becomes worth surfacing, the way to get it is a new persistent log: every agent write appends
  an entry; `listMine` reads `log ⋈ current state` to compute `corrected`/`removed`. That's a
  real new data model + an append at every agent mutation — deliberately deferred (the
  comparison-with-memory model covers today's needs). A lighter middle path — making the few
  destructive mutations provenance-*preserving* (tombstone `tag_by`, keep the original author on
  card correction) — would surface `corrected` incrementally without a full log. Both noted in
  ROADMAP. Chosen now: the current-state oracle.

## Tests
`tools/smoke-listmine.mjs`: a note carries its identity (frontmatter + `added_by`, surviving a
rescan) while a human note stays unattributed; listMine returns all six kinds for the calling
channel with correct per-kind status; ratify flips pending→ratified; `identity:"*"` is the
cross-channel view and an explicit identity scopes precisely; `kinds`/`status` filters; counts.
