# SPEC — Librarian-authored catalog cards (skip / override the cataloger)

> **Status: IMPLEMENTED (2026-06-21, commit `6cb59c9`).** Design record — kept for the
> rationale + the reproduced bug; authoritative summary is GLASS.md §17.4. What shipped:
> §1 authored cards (`weir_reviewItem` takes a `description` + creates a card if none,
> stamped `reviewer:agent`); §3 the cataloger abstains on thin/metadata-only input
> (`cataloger:'skipped:thin-metadata'`, never fabricates); §4 tag hygiene (`facetsOf`
> drops workflow/namespaced tags from `entity`) + the card review tier (`reviewer`+`by`).
> §2 (skip-on-add) is covered by composition — `weir_addBook` → `weir_reviewItem`.
> Decisions on the open questions: agent-authored cards are trusted on the `source:agent`
> stamp (NOT re-flagged `needs_review`); the LLM cataloger stays the default for real-body
> items. (Originally an enhancement request from the **librarian** (`claude:librarian`)
> for the **dev agent** (`claude:dev`) to build — the librarian proposes; the dev decides.)

---

## Problem (reproduced today)

`weir_catalogItem` runs the internal LLM cataloger from an item's *content*. On a
**metadata-only holding** — a book carries title/author/ISBN and no body — it has nothing
real to read, so it **fabricates**. Worked example:

- Added *The Book That Plays Back* (`book:haeb33473`, ISBN 978-65-02-14290-5) — a print
  **gamebook** (you play tic-tac-toe / nim / hexapawn / notakto against precomputed minimax
  pages; **no audio**).
- `weir_catalogItem` produced: *"A promotional piece about an interactive book from GCU that
  features audio playback capabilities."* — **hallucinated from the title word "playback."**
  It also pulled the librarian's **workflow tags** (`gcu`, `owned`, `gcu-published`) into the
  **entity** facet as if they were subjects, set `provenance: web-feed` (it is an *owned*
  book), and `stance: promotional`.
- `weir_reviewItem` let me correct the **facets** (done — `glass-20260621-001` now carries
  accurate subjects), **but there is no way to fix the `description` via MCP**, and re-running
  the cataloger would only re-hallucinate from the same thin metadata.

So a **pointed add** — the agent deliberately adding *one* item it knows well — is stuck with
either a sub-par auto-card or a known-wrong blurb that becomes catalog truth.

## What's missing

1. **No way to set/override the `description`** (or anything else the cataloger writes) by
   hand — `weir_reviewItem` covers facets only.
2. **No way to skip the cataloger** and author the card directly on a deliberate add.
3. **The cataloger fabricates on thin input** instead of abstaining.

## Proposed (priority order)

**1. Agent-authored cards — write what the cataloger would, by hand.**
Let the librarian author a full card (`description` + the glass facet set), stamped
`source:agent` (`claude:librarian`), creating the glass card if none exists. Either:
- extend **`weir_reviewItem`** to also accept a `description` (and to *create* a card, not
  only confirm an existing one), **or**
- a dedicated **`weir_setCard`** / **`weir_catalogItem({ manual: { description, facets } })`**
  that writes an authored card and **never calls the LLM**.
This is the core ask: *the agent should be able to fill the card itself.*

**2. Skip-the-cataloger on a pointed add.**
Let `weir_addBook` (and adds generally) optionally carry `description` + `facets`, and/or a
`catalog: "manual" | "auto" | "skip"` flag — so a deliberate add lands **fully formed** and
never touches the LLM. The agent often knows the item far better than a title-only cataloger
can guess; let it say so at creation.

**3. Cataloger guardrail — abstain, don't fabricate.**
When body text is absent or below a threshold (metadata-only), the cataloger should either
**skip and flag `needs_review`** for human/agent authoring, or **draw from a real source**
(e.g. the Open Library description the ISBN already resolves) — never invent from the title.

**4. Provenance + tag hygiene (smaller).**
- An authored card stamps `source:agent` + identity — distinct from a `cataloger`
  (`provider:model`) card and a `human` one (the three-tier taxonomy already in flight).
- The cataloger should not promote librarian **workflow tags** (`gcu` / `owned` / `brief:*`)
  into the **entity** facet as subjects.

## Why it matters

The library's value is a *trustworthy* card. An autonomous-but-wrong description is worse
than none — it reads as authority. For pointed adds (the agent curating something it knows),
authored cards are both more accurate and cheaper than an LLM round-trip. This is the
propose/ratify model working as intended: the agent fills the tray precisely; Arthur ratifies.

## Open questions / risks

- Should an agent-authored card still be markable `needs_review` (so Arthur confirms it), or
  trusted on the `source:agent` stamp alone?
- This rides on the three-tier provenance work — sequence accordingly.
- Keep the LLM cataloger the **default for bulk/feed items** (it's good with real body text);
  the manual path is for pointed adds + metadata-only holdings, **not a replacement**.

— the librarian (`claude:librarian`)
