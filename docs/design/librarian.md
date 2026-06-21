# SPEC — The Librarian (weir's curating agent + provenance)

> A companion to [reference-desk.md](reference-desk.md). That spec is the
> **read half** — retrieval tools an agent uses to do grounded reference work over
> the standing archive. This is the **write half**: the same agent, wearing the
> librarian hat, also *curates and acquires* — adds sources, links, books (incl. a
> to-buy shelf), tags, and relations — and everything it touches is stamped with
> **who did it** so a human can tell the agent's hand from weir's own cataloger
> from their own. The agent *proposes*; the human *ratifies*. Nothing files itself.

> **Status: IMPLEMENTED (2026-06-21).** Design record — kept for the rationale; the
> authoritative summary is GLASS.md §17. What shipped: the §2 provenance taxonomy
> (`source:'agent'` + identity across tags/edges/notes/feeds/books + `weir_provenanceMigrate`,
> commit `cbce8ff`) and the §3 unified review queue + `weir_ratify` (`0882c78`). The
> per-connection identity arrives via the numen multichannel work (`client.identity`,
> folder = identity — see the `numen` repo, `docs/multichannel.md`). Still deferred: the ratify
> stamp generalization beyond feeds/edges, agent-tag/book ratification in the queue,
> note-`source` migration, the to-buy wishlist promotion to a distinct state (§6).

| | |
|---|---|
| **Package** | `@gcu/weir` (webmcp surface) + a sibling consumer repo (`weir-desk`) |
| **Implements** | the curation/acquisition half of GLASS §2.1 (decides-vs-proposes) + a provenance taxonomy |
| **Status** | Implemented — see the status note above + GLASS.md §17. |
| **Audience** | weir's Claude Code (this repo) — builds the tools; and the librarian agent (sibling repo) — uses them |
| **Design language** | Switchboard — weir's |

---

## 0. Ground yourself first

Read the real surfaces; the code is the contract.

- `src/js/webmcp.js` — the write tools already exist: `weir_addFeed`, `weir_addBook`
  (fn `addBooks`), `weir_tag`, `weir_relate`, `weir_catalogItem`, `weir_reviewQueue`,
  `weir_reviewItem`, the stacks write tools. Read their `source:` stamping closely —
  it's inconsistent today (§2).
- `src/js/cataloger.js` — the internal cataloger-as-service. Stamps
  `card.glass.cataloger = "${provider}:${model}"` (line ~56). This is weir's *own*
  LLM, NOT the external agent. The distinction this spec turns on.
- `src/js/glass.js` — `provenanceFor` / the `provenance` **facet** (~line 18) is the
  *item's origin tier* (feed-derived). A DIFFERENT axis from authorship `source`.
  Don't conflate them.
- `src/js/ui/app.js` — the UI stamps `source:'human'` (tags ~2430, ratify ~2195).
  This is the human tier.
- `src/js/courier.js` — the FS exchange surface. Identity is **config**, never
  hardcoded; dispatches arrive as **proposals the user ratifies**. The librarian's
  write-back path and the model for "propose, don't decide."
- GLASS §2.1 (decides-vs-proposes), §10 (the knowledge graph), CLAUDE.md ("build
  capabilities, not one-offs").

If anything here contradicts the code, the code wins — note the divergence.

---

## 1. Why this exists — the objective

The motivating realization: **NotebookLM (and Open Notebook) are the wrong tool.**
Their ceiling is the throwaway notebook — sources dragged in by hand, capped,
ephemeral. weir is the opposite: a durable, deduped, cataloged library that grows
on a schedule, with a controlled vocabulary and a knowledge graph. Pointing an
agent (Claude, over webmcp + the Courier) at *that* standing corpus is strictly
more powerful for our purposes — the agent reads the whole library, cites back to
exact items, and can also *grow and tend* it.

So the agent has two hats over one corpus:

- **Reference desk** (read) — retrieve, rank, relate, quote. SPEC-reference-desk.md.
- **Librarian** (write) — acquire sources/books/links, tag, relate, catalog,
  triage the review queue. This spec.

Both run from a **sibling repo** (private; a public GH *template* can be extracted
later), not from inside `gentropic/weir`. The agent talks to the *running* weir over
the `numen-weir` MCP bridge and the Courier folder — it never edits weir's source
tree. See §5.

### 1.1 The boundary — decides vs. proposes (GLASS §2.1)

The librarian writes, but it does not *decide catalog truth*. Everything it adds is
a **proposal** stamped with its identity, landing in a tray the human ratifies
(`weir_reviewQueue` / the Courier `in/` gate). This is the same line the reference
tools hold from the other side: reference proposes rankings, the librarian proposes
records; the human decides. weir stays "dumb pipes, smart service" (GLASS §1.1).

---

## 2. The provenance taxonomy **[the net-new capability]**

This is the load-bearing piece and the reason the spec exists. Today authorship is
stamped **inconsistently**, and the two things we most want to add carry no
provenance at all:

| Artifact | Path | Stamped today | Correct under this taxonomy |
|---|---|---|---|
| tag | `weir_tag` (MCP = the agent) | `source:'llm'` (webmcp.js:228/237) | **`agent`** (it's Claude, not the cataloger) — *bug* |
| tag | UI | `source:'human'` | `human` ✓ |
| edge | `weir_relate` (MCP) | `source:'claude'` | `agent` ✓ (unify with the tag value) |
| edge | UI ratify | `source:'human'` | `human` ✓ |
| note | agent (MCP) | `source:'claude'` | `agent` ✓ |
| catalog card | `cataloger.js` | `glass.cataloger = provider:model` | `cataloger` tier ✓ (card-level, already finer-grained; not a tag/edge source) |
| **feed** | `weir_addFeed` | **nothing** | `agent` / `human` — *gap* |
| **book** | `weir_addBook` | **nothing** | `agent` / `human` — *gap* |

The fix is **not** "collapse to one source." It's a clean, three-valued
**authorship tier** plus an optional finer attribution string:

- **`source` ∈ `{ human, cataloger, agent }`** — the coarse tier.
  - `human` — Arthur, via the UI. The ground truth.
  - `cataloger` — weir's *internal* LLM-as-service (the bounded `cataloger.js`
    call). It authors **card** metadata only — `card.glass.cataloger = provider:model`
    — and **never stamps an item-tag/edge `source`**. So per-field, **tags and edges
    only ever carry `human` or `agent`**; `cataloger` lives on the card. (Verified:
    the only writers of tag/edge `source` are the UI → `human`, and the MCP tools →
    today `'llm'` (tags, webmcp.js:228/237) + `'claude'` (edges/notes) — *both the
    agent*. There is no `'llm'`→`cataloger` migration; the earlier draft had this
    backwards.)
  - `agent` — an *external* agent over MCP/Courier (Claude as librarian). **Both**
    current MCP values — `'llm'` (tags) and `'claude'` (edges/notes) — migrate to
    `agent`, so the tier name is role-not-vendor and a future second agent fits. The
    `weir_` tools, being the MCP surface, stamp `agent` by default.
- **finer attribution** — parallel to how the cataloger already records
  `provider:model`, the `agent` tier carries an **identity string** (e.g.
  `claude:opus-4.8`). **DECIDED:** identity is **per-connection, declared by the MCP
  client**, falling back to a weir setting when absent — most correct when more than
  one agent connects, each its own identity. So `cataloger` → its model, `agent` →
  its connection identity; both answer "*which* machine, exactly."

**Do not touch the `provenance` facet** (`provenanceFor`, glass.js). That's the
item's *origin* (its feed), an orthogonal axis. Authorship `source` is "who wrote
this metadata"; the `provenance` facet is "where the item came from." Keep them
separate and say so in any doc, because the word collision invites exactly the bug.

**Why one capability, not five hand-stamps** (CLAUDE.md, the `renameFeed`
precedent): every write tool funnels through one provenance helper that stamps
`{ source, by }` consistently, and every read/query tool can *filter and report* by
it. Then "show me everything the agent added this week, unratified" is one query,
the review tray groups by tier, and the UI can render the agent's hand distinctly —
all from a single source of truth instead of three ad-hoc string literals.

### 2.1 What this unlocks

- **Trust & audit.** You can always see what Claude touched vs. what you did vs.
  what weir's cataloger inferred. Nothing the agent does is silently indistinguishable
  from your own curation.
- **Reversible bulk.** "Undo everything the agent added in this session" becomes a
  scoped query, not archaeology.
- **The ratification queue** (§3) is just a view over `source:'agent', ratified:false`.

---

## 3. The propose → ratify loop

The librarian never commits catalog truth directly. Reuse what exists:

- `weir_reviewQueue` / `weir_reviewItem` — the catalog review gate (cards needing
  human confirmation). **DECIDED: one unified queue.** Generalize it to "pending
  human attention" with a **`kind` discriminator** (`low-confidence-catalog` |
  `agent-proposal`), filterable — so cataloger low-confidence cards *and* agent-added
  records (feeds, books, relations) triage in one place, one ratify gesture. Agent
  records surface filtered by `source:agent`.
- The **Courier** `in/` gate — dispatches that change structure arrive as proposals.
  The librarian's write-back (synthesized notes, proposed feeds/relations) can flow
  through here when the agent is running async/disconnected, and through the MCP
  tools when it's live.
- **Ratify gesture** is the human's: confirm → `source` stays `agent` but a
  `ratified_by:'human'` / `at` is stamped (the edge already records `{source, at}`;
  generalize). Dismiss → the proposal is dropped/archived (never a hard delete —
  weir's never-delete rule).

The agent should be able to *see its own unratified proposals* (a read filter) so a
fresh session picks up where the last left off without re-proposing duplicates.

---

## 4. Acquisition — the write verbs (mostly shipped, + provenance)

What the librarian does, and the tool behind each. The work here is mostly
**threading provenance through** + the to-buy decision; the verbs exist.

- **Add a source.** `weir_addFeed` — stamp `source:agent` + identity. **DECIDED:
  ratify by default** (the agent's proposed feed waits in the tray before the poller
  adopts it), **except** a configured **trusted-domain allow-list auto-adopts +
  flags** — so "follow this blog" is frictionless for sources you've pre-blessed,
  everything else waits. The allow-list is config (shape → §6).
- **Add a link / relation.** `weir_relate` (already `agent`-tier). Plus body links
  `[[ref]]` in agent-authored notes — already resolved by `getItem`. The citation
  chain and the relatedness graph both grow from the agent's reading.
- **Add a book (owned).** `weir_addBook` — stamp `source:agent`. Re-imports already
  merge `structured` (so series/seq survive); provenance must survive the same way.
- **Add a book (to-buy / wishlist).** *New surface, small.* A wanted-but-unowned
  book is **not a holding** — `weir_addBook` sets `structured.shelved` for *owned*
  physical books. Options (decide in §6):
  - (a) a holding with `tags:['to-buy']` + `shelved:false` — reuses everything,
    overloads "holdings" to mean owned+wanted.
  - (b) a distinct `acquire`/wishlist state on the book record — cleaner semantics,
    a touch more schema.
  **DECIDED: (a)** — a holding with `tags:['to-buy']` + `shelved:false`. Zero new
  schema; the shelf-list/labels tooling already keys off `shelved`, so a to-buy book
  won't print a shelf label. Revisit only if the wishlist grows its own needs
  (price, source, priority) → then promote to (b).
- **Tag.** `weir_tag` — fix the tier to `agent`. Bulk-tag a research result set as
  the agent's working set, visibly the agent's.
- **Catalog.** `weir_catalogItem` — note this triggers the *cataloger* tier
  (`provider:model`), distinct from the agent asking for it. The agent *requesting*
  a catalog is an `agent` action; the resulting facets are `cataloger`-authored.
  Both facts are true and both should be recorded.

All read-back through the reference tools (SPEC-reference-desk.md) so the librarian
verifies its own additions landed and cites them.

---

## 5. The agent's home — the sibling repo

A **separate, private repo** beside `gentropic/weir` (e.g. `weir-desk/`), NOT a
subfolder of this one — Claude Code reads `CLAUDE.md` up the tree, so a subfolder
would inherit weir's *dev* orientation (build.js, smoke tests, single-file ethos).
The librarian needs the opposite charter.

- **Its `CLAUDE.md` is the librarian's charter**, roughly: *"weir is your corpus,
  reached over the `numen-weir` MCP tools (and the Courier folder for async
  write-back). You are reference desk + librarian. Cite everything to item/glass
  ids; in strict-grounding mode assert nothing the tools didn't return. You
  propose, Arthur ratifies — every record you add is stamped `source:agent`. Your
  research output lands in THIS repo; structural changes flow back to weir as
  proposals. Never edit weir's source tree."*
- **Connection is over MCP, not the filesystem.** The repo location is independent
  of corpus access — the live weir is reached through the bridge to the running PWA
  (the live store is FSA-mounted at `Documents\weir`, separate from both repos).
- **Two Claude Codes, one machine, is fine.** This repo's agent (builds weir) and
  the sibling's agent (uses weir) keep separate working dirs → separate CLAUDE.md →
  separate memory, so roles don't bleed. They share the *running corpus*, not a tree.
- **Public template later.** Extract a sanitized `weir-desk` template repo (no
  personal corpus, no identity config) once the charter + tool conventions settle,
  so anyone with a weir can stand up their own librarian.

---

## 6. Decisions + remaining open questions

**Decided (this round):**

- **Authorship tier = `{ human, cataloger, agent }`.** Tags/edges carry only
  `human`|`agent`; `cataloger` is card-level (`glass.cataloger`). Migrate both MCP
  values — `'llm'` (tags) and `'claude'` (edges/notes) — to `agent`.
- **Rename `claude`→`agent`** (role-not-vendor; vendor/model rides the identity str).
- **Identity = per-connection, declared by the MCP client**, default to a weir
  setting when absent.
- **to-buy = (4a)** tag + `shelved:false`.
- **Feeds = ratify by default + trusted-domain allow-list auto-adopt.**
- **One unified review queue** with a `kind` discriminator.

**Still open (implementation detail, decide when building):**

- **Migration safety.** Before the `'llm'`/`'claude'`→`agent` rewrite, confirm no
  reader keys on the literal old values (UI rendering, the `entity`-facet feed,
  smoke tests). Build it as a capability (store method + a tool), not a hand-fix.
- **How the MCP client declares identity.** Does the `numen-weir` bridge / webmcp
  handshake already carry a client id we can adopt, or do we add an identity field
  to the connection/registration? (Falls back to the weir setting if not.)
- **Trusted-domain allow-list shape.** A weir setting (list of domains)? Per-folder?
  Does an auto-adopted feed still drop a flag/notice in the unified queue so it's
  *visible* even though it wasn't gated?
- **Ratify stamp.** On confirm, the record keeps `source:agent` but gains
  `ratified_by:'human'` + `at` (generalize the edge's existing `{source, at}`).
  Confirm one shape works across feeds/books/edges/cards.

---

## 7. Non-goals

- No prose generation/synthesis *inside weir* (SPEC §8) — the agent synthesizes in
  the sibling repo; weir stores the result as a note, doesn't author it.
- No agent *deciding* catalog truth — propose→ratify, always (§3).
- No hard deletes from any librarian tool — archive/dismiss, never delete.
- No new runtime dependencies in weir; `node build.js` stays zero-dep, single-file.
- The sibling repo is a *consumer*; it does not fork or vendor weir's code.

---

## 8. Done means

- One provenance helper in `webmcp.js`/store stamps `{ source ∈ {human,cataloger,
  agent}, by }` on every write tool; `weir_addFeed`/`weir_addBook` carry it; the MCP
  tag/edge/note values `'llm'`+`'claude'` migrated to `agent` (both were the agent).
- Read/query tools can filter + report `source`; "everything the agent added,
  unratified" is one query.
- The review/ratify gate covers agent-added records, not just cataloged cards.
- to-buy books expressible (whichever §6 path), and excluded from shelf-label output.
- A smoke test per new/changed capability; `npm run smoke` green; `node build.js`
  produces a working single-file `index.html`.
- The sibling repo exists with a librarian `CLAUDE.md`; the §5 connection works
  end-to-end (the agent queries + proposes against the live weir over MCP).
