# SPEC — Repos as a first-class source (dives into the corpus)

> **Status: IMPLEMENTED (2026-06-22).** Design record — kept for the rationale +
> the architecture correction + deferred work; the authoritative summary is GLASS.md
> §17.6. Originally a **librarian** draft (`claude:librarian`, `source:agent`) for the
> **dev agent** (`claude:dev`); direction + granularity ratified by Arthur 2026-06-22,
> reviewed with weir-dev. Built on `SPEC-stacks-first-class` (notes had to be graph
> citizens first). The librarian proposes; the dev decides.

---

## Why

The librarian dives sibling repos (auditable, BMA, hopper, capsule/cradle/numen, press,
…) and writes maps — but the repos and maps weren't corpus items: they couldn't be
`weir_search`ed, `weir_relate`d, or *cited* the way items are. They lived as `research/`
files + stacks notes, *beside* the catalog. This makes a **repo a first-class source**
whose items are its own docs + the librarian's dive-map, commit-anchored and in the
knowledge graph — so the constellation becomes a **queryable subgraph in weir**
(`weir_search "totality security boundary"` → hopper's actual docs *and* the hopper map,
related).

## The architecture correction (the heart of the review)

The draft assigned the load-bearing mechanic to weir: *"Bridge reads the local repo dir…
`weir_repoll` extended to diff-and-reingest at the anchor."* That doesn't survive contact
with weir's runtime:

- **bridge = fetch**, a CORS broker. It cannot read a local directory. "Bridge reads the
  repo dir" is a category error.
- weir *can* read a folder, but only via an **FSA mount** (`fsmount.js`, same as the store
  + Courier folders) — that yields file *bytes*, never **`git`**. There is no process, no
  `git diff`, no commit SHA in a browser tab. The dive-ledger is un-implementable *inside*
  weir.

But it doesn't need to be — **the agent already has git and the files.** So the
responsibility flips: **the agent reads + diffs; weir stores + catalogs.** This lands on
an existing seam — `weir_addLink` → `importLinks` already does "agent hands weir
structured items, weir stores + stamps provenance" — and on the synthetic-feed precedent
(`stacks`, `saved`, `books` are all non-polled feeds). No new I/O surface; the
browser-as-runtime ethos holds.

The two design forks were settled with Arthur: **(1)** repo docs live as a **synthetic
per-repo source (feed)**, not stacks notes — keeping the project's words grouped + separate
from the user's personal stacks; **(2)** provenance reuses **`human` + a repo flag**
(`feed.config.kind === 'repo'`), not a new `source:repo` tier — no change to the closed
provenance vocabulary.

## What shipped

### `store.ingestRepo({ repo, name?, anchor?, docs, removed?, category?, … })`
- Creates/updates a synthetic source: `id: repo:<slug>` (slug = repo basename),
  `adapter:'repo'`, `next_poll_at: 8.64e15` (poller skips it), `retention: forever`,
  `config: { kind:'repo', repo, anchor }`. First creation stamps `source:'agent'` +
  identity, so it lands in `weir_reviewQueue` as a ratifiable feed proposal
  (decides-vs-proposes).
- Upserts each doc as a **`doc` item** (new `ITEM_TYPES` entry), stable id
  `repo:<slug>:<hash32(path)>`, body as lazy per-feed content, tagged with the repo slug,
  `structured:{repo,path}`. Rides `upsertItems` → dedup + **never resets read/saved/tags**;
  re-ingest is idempotent.
- `removed[]` paths are **archived, never deleted** (a file gone from the repo stays in the
  standing archive).
- Advances + persists the `anchor`. Returns `{ source, inserted, updated, removed, anchor }`.

### `weir_ingestRepo` (the agent's verb)
The MCP wrapper. The agent calls it; **weir never touches git**. Refresh recipe documented
in the tool description: read the stored anchor from `weir_listSources` (now surfaced on
repo sources via `projFeed`), run `git diff --name-only <anchor> HEAD -- <globs>` (+
`--diff-filter=D`) locally, call `weir_ingestRepo` with only the changed docs + the new
HEAD + deleted paths in `removed`. "re-dive" and "re-poll" unify — on the agent's side,
the only side that can diff. `weir_repoll` is deliberately **not** extended (it's
fetch-only; a repo source isn't fetchable).

### Free from prior work
Doc-items are items, so they're already `weir_search`able, `weir_quote`able, and — since
`SPEC-stacks-first-class` — `weir_relate`able by id (auto-carded on relate). The dive-map
stays a **stacks note** related into the doc-items (`source:agent`); that relation is the
synthesis layer, cleanly distinct from the project's words. `recomputeHealth` now skips
never-polled sources (`next_poll_at >= 8.64e15`), so repo/stacks/saved/books sources don't
show fetch-health noise.

## Granularity (settled, unchanged from the draft)
- **Docs + the dive-map, NOT code.** weir is a library, not a code-search engine. The
  agent owns the glob set (`README*`, `SPEC-*.md`, `docs/**/*.md`, `ROADMAP`/`DECISIONS`,
  `CLAUDE.md`); weir stores whatever's handed in — so "docs not code" and the gitignored
  `CLAUDE.md` (local read by the agent) need *zero* weir support.
- Repo docs are "the project's words" (`kind:'repo'`); the dive-map relation is
  `source:agent`. Kept distinct on the cards.

## Decisions / notes
- **Auto-catalog is opt-in**, not automatic (stacks ethos — a repo's docs aren't feed slop
  to auto-classify). The agent triggers `weir_catalogItem` if wanted.
- **Source key = repo basename.** Two repos with the same basename in different orgs would
  collide on `repo:<slug>`; pass a distinct `name`/repo path if that ever bites. (Noted,
  not handled — no GCU collision today.)
- **Re-added-after-removed**: `upsertItems` skips archived ids (resurrection guard), so a
  doc deleted-then-re-added stays archived until explicitly unarchived. Acceptable; flagged.

## Deferred
- **`url` permalinks per doc** to a GitHub blob at the anchor — supported (the agent can
  pass `url`), not required; nice for click-through citations.
- **Non-markdown docs** (e.g. a roadmap `.csv`) — supported as text if the agent hands them
  in; no special handling.
- A repo source's **own in-app browse affordance** beyond `listSources` grouping — the
  source shows in the tree under `repos/`; richer UI is a later nicety.

---

## Pilot fixes (2026-06-22) — from first contact (BMA ingest)

The first live `weir_ingestRepo` (BMA's README → `repo:bma`) proved the flow and produced
a punch-list (`SPEC-repos-as-source-fixes`), all addressed:

1. **Refresh updates `rationale` in place** (+ name/category) — a poor first blurb on the
   still-pending proposal was previously unfixable short of remove+re-add.
2. **Rationale clamped at the MCP boundary** (`clampRationale`, ≤500 ch, ellipsized,
   applied to `ingestRepo`/`addFeed`/`relate`/`addBook`) — a malformed 4 KB blob can no
   longer wall the review queue.
3. **Repo docs get their own `form`** — `TYPE_TO_FORM` maps `doc → 'doc'` (was `'article'`),
   so `weir_queryCatalog({facets:{form:['doc']}})` scopes to project documentation
   (`weir_queryItems({type:'doc'})` already did the simple filter).
4. **Repo sources self-summarize in the review queue** — `pendingProposals`/`reviewQueue`
   carry `{repo, docs:N, anchor}`, so the queue reads "N docs from `<repo>` @ `<anchor>`"
   without leaning on rationale text (subsumes #2's blast radius).
5. **Path-based ingest from a read-only repos mount — the conduit unlock (the big one).**
   The agent was a *verbatim conduit*: every doc's full text went through the MCP-call
   tokens (the librarian had to *abridge* hopper's README). Now `weir_ingestRepo` accepts
   **`paths:[…]`** alongside `docs:[…]`; weir reads each named file from a **read-only FSA
   mount** of the repos parent folder (`fsmount` gained a `mode` param; `app.reposVfs` +
   `app.readRepoDoc` + a boot reconnect + a Settings affordance). The agent still owns the
   `git diff` (which paths) and never carries content; weir reads **only the named files**
   (`..` traversal blocked, ≤1 MB, UTF-8), never walking the tree, and can never write
   (read-only grant). **Transport decision (with Arthur):** weir reads the repos **in
   place** (5a) rather than via a Courier copy (5b) — simplest, and on a single-user
   machine where the Claude Code agents already have full FS access, a read-only weir mount
   adds no exposure within the trust domain. The junction/symlink route was considered and
   dropped (a junction'd folder = the same access, gated on fragile FSA-follows-symlink
   behavior). Caveat: weir reads the **working tree**, so ingest assumes a clean tree at the
   anchor. Setup is a one-time human gesture in the weir tab (+ a permission re-grant on
   launch); an unmounted `paths:` call fails with a clear message and `docs:` still works.

## Tests
`tools/smoke-repos.mjs` (wired into `npm run smoke`): first ingest creates the source +
`doc` items (proposal, never-polled, searchable); refresh re-ingests the delta, advances
the anchor, and never resets state; `removed` archives without deleting; `weir_listSources`
surfaces the anchor; a stacks dive-map relates to a repo doc by id; a metadata-only doc is
flagged `bodyless` (below).

## Bodyless-ingest signal (2026-06-22, from the cataloger-gap report)
A repo-doc catalog pass left 60 docs at `skipped:thin-metadata` — diagnosed via the dev bridge
as **no stored body** (`has_content` false; `getContent` empty): they'd been ingested
metadata-only (no `markdown`/`paths` content), and weir accepted that silently. Fix:
`ingestRepo` now returns **`bodyless: [paths]`** for any doc handed in without a body, so a
metadata-only ingest is visible. The cure for the existing items is re-ingesting with `paths:`
(mount granted) — stable ids (`repo:<slug>:<hash(path)>`) make `upsertItems` *update in place*,
writing the bodies — then `weir_catalogControl recatalog category:"repos"` re-cataloging the
scope from the now-present bodies.

**Correction (confirmed on deploy, librarian's `…-CONFIRMED` note):** `recatalog:true`
**discards the whole scope's cards first** — *including* hand-authored ones (it calls
`uncatalogScope` → `cleared: N`; the tool schema says so: "DISCARD that scope's existing cards
first"). Earlier guidance here that it "keeps hand-authored cards" was **wrong**. The right rule
with repo docs: once bodies are present, **let `recatalog` redo from the bodies — don't
pre-hand-author** (the body-fed cards, conf 0.7, beat terse hand facets anyway). The standing
footgun — `recatalog` silently clearing genuinely-authored cards (e.g. metadata-only book
holdings where the cataloger can only abstain/fabricate) — is noted for a possible future
safeguard (preserve `reviewer`-stamped cards, or require an explicit `includeAuthored`), not yet
built.

**Then the `paths:` read itself was broken** (the librarian's re-ingest came back all-bodyless):
`app.readRepoDoc` fed the string from `vfs.readFile` (no-encoding → `file.text()`) into
`new Uint8Array(str)` — which is **length 0** — so every mounted doc decoded to `""`. (The
read/slug-prepend was correct; only the byte handling was wrong.) Fixed by extracting a pure
`readMountedDoc(vfs, repoDir, path)` (in `fsmount.js`) that reads as UTF-8 **text** — and is
node-tested against a memory VFS, which the earlier smoke missed by *mocking* `readRepoDoc`
instead of exercising it. The handler also now returns **`bodylessReason`**
(`not-found | read-error | empty | no-path`) per the librarian's ask, so a failed read
self-diagnoses. Paths stay repo-relative (weir prepends `<mount>/<repo>/`), so re-ingest updates
the same items in place.
