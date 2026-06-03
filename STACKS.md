# STACKS.md — weir's knowledge stacks **[draft / for review]**

> The inbox is for *streams you process*. The catalog is *what you've kept, classified*.
> The **stacks** are *what you author and drop* — notes you write and files you send —
> living as **real files in a real folder**, filed, tagged, catalogued, and curatable
> by you and by Claude. It's the third surface, and the one that makes weir a place to
> *put things*, not just read them. (Named for the library stacks — and your holdings
> shelve there by their glass call number.)

Status: **design, nothing built.** This doc locks the model before code (the explicit
ask: don't brick the notes/file format into a shape we regret). Read after
[GLASS.md](GLASS.md) — the stacks' entries are glass holdings like any other.

---

## 1. What it is

A tree of files under `/stacks/` in the VFS:

```
/stacks/
  inbox/                     # unfiled drops land here
  specs/weir/stacks.md
  papers/kriging-notes.md
  receipts/2026/nota-fiscal.pdf
  ideas/telegram-miniapp.md
```

- **Mounted (FSA) → these are real files on disk** — open them in Obsidian, your
  editor, `git`, anything. weir *is* the stacks; it isn't a copy. This is the whole
  point, and it's only possible because the store is already filesystem-mountable.
- **Unmounted (IDB) → the same tree as blobs.** Works, but big binary drops risk
  eviction; markdown notes are tiny and fine. The Stacks settings surface a "mount for
  files" nudge.

Two entry kinds: **notes** (markdown, authored) and **files** (any dropped binary).

## 2. Relationship to the rest of weir **[settled]**

- **Stacks entries are first-class items.** `feed_id: 'stacks'`, `type: 'note' | 'file'`,
  plus a `path` (subfolder + filename). So they inherit **tags, search, routing, and
  the glass catalog** for free — a stacks note about geostatistics shows up in the
  catalog, gets a `·` call number, intersects facets. No parallel universe.
- **But the stacks are their own VIEW** (a folder tree), not the inbox. The inbox stays
  feed-shaped (process-and-clear); the stacks are browse-and-keep. A stacks item never
  sits in the inbox.
- **Content lives at the real tree path** — `/stacks/<path>`, *not* the usual
  `/content/<feed>/<itemKey>.html`. That's the one deliberate deviation from the
  normal item-content scheme, and it's what makes the files human-named and mountable.

## 3. Metadata + tags (sidecar) **[designed]**

- **Notes (`.md`)** carry **YAML frontmatter**: `uid`, `tags`, `source`, `created`,
  `glass_id?`. Portable + Obsidian-native. The `uid` is weir's stable identity for the
  entry (see §9) — stamped on first index, the anchor that lets moves and `[[uid]]`
  links survive a reorg.
- **Files** carry a **sidecar** `…​.meta.json` next to them: same fields (incl. `uid`).
  The file itself stays pristine.
- **Parsed with our own `@gcu/yaml`** (vendor `../auditable/ext/yaml`, bundled into
  `/vendor/` like vfs/librarian) — a strict YAML 1.2 subset with **no parse-time tag
  resolution / no RCE surface**, which matters because frontmatter can arrive from an
  external editor or from Claude. Tag-free docs **round-trip identically through
  vanilla YAML**, so the frontmatter stays Obsidian/standard-tooling readable. (We do
  NOT pull in a full YAML library — same zero-dep rule as everything else.)
- Tags written here are the *portable* copy; weir's in-memory index is still hydrated
  from the per-feed shard (`/items/stacks.ndjson`) like every item. **Source of truth
  in v1: the shard**; frontmatter/sidecar is the mirror weir writes on save and reads
  on (re)scan. External edits (you change frontmatter in Obsidian) sync on a **rescan**
  pass — see §9.

## 4. Filing — "ready in the right place" **[designed]**

An arriving entry's subfolder is decided by, in order:

1. **Explicit path / naming scheme.** Send `specs/weir/stacks.md` (or set frontmatter
   `folder: specs/weir`) → it files straight to `/stacks/specs/weir/`. Zero config.
   This is the path you described: write a spec in Claude web, name it sensibly, send
   it, it lands filed.
2. **Stacks routing rules.** The *same* `{ when, then }` engine as feed routing, but
   `then` yields a **folder** (+ tags): `when: n => /\bspec\b/.test(n.title), then: {
   folder: 'specs', tag: ['spec'] }`. Stored as JS, `eval`'d, applied at intake.
3. **Fallback → `/stacks/inbox/`** (unfiled), so nothing is ever lost waiting to be sorted.

## 5. The Stacks view + editor **[designed]**

- A **rail section with a folder tree** (alongside Sources / Views / Routed / Tags) —
  expand/collapse, counts, drag-to-move (later). The main pane shows the tree → a
  note/file.
- **Editor = `cm6`** (CodeMirror 6, vendored from `auditable/ext/cm6` — the bundled
  runtime is ~654 KB). It's the **heaviest single add** to the bundle (~0.8 MB →
  ~1.2 MB+) — accepted, since weir is loaded-once-local and a real editor earns it;
  flagged so it's an eyes-open choice. **Stage A ships a plain `<textarea>`** with the
  full edit/split/preview toggle + save pipeline; cm6 swaps in for the textarea as an
  isolated follow-up (a widget swap — the toggle UI and save path don't change), so the
  654 KB bundle jump lands in its own reviewable commit rather than the foundation.
- **UX = edit / split / preview *toggle***, NOT Obsidian-style inline live-preview.
  CM6 *can* do live-preview via decorations, but it's fragile/finicky to maintain;
  the toggle is robust and well-understood. (Live-preview = a maybe-later refinement,
  not a Stage-A goal.) You author specs in Claude web and *send* them anyway, so the
  in-app editor is more tweak-and-read than primary authoring.
- **Markdown render (preview pane) — renderer TBD.** `gcu-press` is **stale** (don't
  default to it); evaluate the fresher **`reader-core`** / **`docview`** for a
  CommonMark→HTML render (sanitized via weir's `sanitizeHtml`). cm6 edits+highlights
  but doesn't render-to-HTML, so a renderer is needed regardless. **Tech debt:** several
  md renderers are scattered across auditable — pick one for weir now, log the
  consolidation for the toolkit later.
- Filing UI: move an entry to another folder; create folders; the routing-rules editor
  (reusing the feed-rules editor).

## 6. MCP adapters — Claude curates the stacks **[designed]**

So "write a spec, send it, I help file/link it" works end-to-end:

- `weir_stacksList(path?)` — the tree (or a subtree): folders + entries with tags.
- `weir_stacksRead(path, {content?})` — a note's body / a file's metadata.
- `weir_stacksWrite({path, markdown, tags?, folder?})` — create/update a note (I can
  draft a note straight into your stacks).
- `weir_stacksMove(path, toFolder)` — file/refile an entry.
- `weir_stacksTag(path, {add?, remove?})` — tag it.

(All reuse the existing tag/route/store machinery; they're stacks-pathed wrappers.)

## 7. Inflows **[designed]**

- **Telegram** (already capturing): notes → markdown in the stacks; **files** → fetched
  via `getFile` (≤20 MB Bot API cap) → the stacks; both filed by §4. The pending
  `/telegram-notes.ndjson` stash is the *first thing the stacks ingest* when built.
- **In-app**: new-note button; drag-drop a file onto weir.
- **Claude** via `stacksWrite` (above).
- **Mount**: drop a file in the folder from your OS → weir picks it up on rescan.

## 8. Cataloging the stacks **[designed]**

A stacks entry is a holding, so it can be **cataloged like anything** → glass facets +
description + a `·` call number, searchable alongside feeds. Markdown notes catalog
trivially (the text is the content). **PDFs/docs need text extraction** first (the
roadmap's "extract at import" stretch) — until then they catalog from filename +
sidecar, or stay Stage-0. Cataloging the stacks is **opt-in per entry / folder**, not
automatic (your notes aren't feed slop to auto-classify).

## 9. Decisions **[settled]** + remaining detail

- **Name: Stacks.** ✅ (was "vault" — too Obsidian; "stacks" is the library shelving
  your holdings live in, and ties to the glass call number.)
- **Files unmounted: allowed.** ✅ The stacks work without FSA — markdown notes +
  lighter file drops live as IDB blobs; surface a gentle size/eviction nudge on big
  drops, and the "mount for the full filesystem experience" hint. Lightweight use
  shouldn't need a mount.
- **Sync: refresh + best-effort detection, no live two-way.** ✅ A **"rescan"** button
  (and per-folder refresh) re-reads from disk. **Detection where feasible**: on rescan /
  tab-focus, compare each file's `lastModified` (FSA `getFile().lastModified`) against
  the indexed mtime and flag what changed externally (a "3 changed on disk" badge →
  review/accept). No file-watcher exists in the browser, so it's poll-on-focus +
  manual, not live — but enough to notice Obsidian edits. Reconcile: frontmatter wins
  for tags, newer mtime for body.
- **Missing entries: flag, never auto-delete — but one-click to clear.** ✅ A file gone
  from disk on rescan → the entry is marked **missing** (never silently tombstoned;
  "never really delete"). To avoid being *haunted by ghosts of reorgs past*, the Stacks
  view surfaces missing entries with a **"forget missing"** affordance (review list +
  bulk-clear, or per-entry dismiss) — a reorg/rename flags ghosts you sweep in one click
  rather than letting cruft accumulate forever. (A rename = delete-old + add-new; v1
  treats it as missing-old + new-entry; content-hash rename-detection is a later nicety.)
- **Stacks entries are items.** ✅ Confirmed — the unification stands.
- **Identity survives moves — id is a stable `uid`, not the path.** ✅ *(reopened &
  resettled — the path-hash model lost state on reorg.)* On first index, weir stamps a
  stable **`uid`** into the entry's frontmatter (notes) / `.meta.json` (files); the item
  **id = `stacks:<uid>`**. The **path is just the entry's current address**, not its
  identity. So **moving/renaming a note keeps the same id** → its tags, read-state,
  catalog card, and inbound links all ride along; a reorg costs you nothing. Match-on-
  rescan is **by uid** (path changed, uid same → it moved), making rename-detection
  mostly free and demoting the §-missing "delete-old+add-new" path to the genuinely-new
  case. **Fallback** for an entry with no uid yet (a raw file dropped into the mount
  externally): `stacks:<path-hash>` until weir stamps it on next write/scan.
- **Conflict / dedup**: a re-send or external edit at the **same uid** (or same path,
  pre-stamp) **updates**, never duplicates. A genuinely new file at a taken path →
  version (`name (2).ext`).
- **Links — notes are connective tissue over the whole catalog.** ✅ Reserve **`[[uid]]`**
  (and `[[glass-id]]`) wiki-link syntax now, resolving **by uid** so links survive moves
  (the payoff of the stable-id decision above). Because **entries are items**, a note can
  cite *any* holding — a feed article, a book, another note — and "what links here" falls
  out for free. v1 reserves the syntax + the by-uid resolver; **rendering/editing links
  (autocomplete, backlink panel) is later** — the cheap, must-not-rot part is the id
  contract, which we're settling now.
- **Git-friendly mount.** ✅ The stacks **ignore dotfiles/dotfolders** (`.git`, `.obsidian`,
  etc.) on scan and never write into them — so pointing the mount at a **git repo** gives
  full version history for free, zero-dep, with weir managing nothing. This honors "never
  really delete" at the *content* level (not just at the entry level), without us building
  a snapshot system.
- **Folder moves don't touch call numbers** — the glass call number is from facets, not
  the stacks path. File by folder *and* wander by subject; independent axes.

## 10. Staging (build order)

- **A — Foundation. ✅ SHIPPED.** `/stacks` store (`stacks.js` — uid-keyed identity,
  scan/stamp, move-keeps-state, missing/forget, frontmatter via `@gcu/yaml`), stacks
  items (`feed_id:'stacks'`, `uid`, `path`, `content_path`), a **Stacks rail tree** +
  markdown reader (`ui/markdown.js`) + a textarea **note editor** (edit/split/preview)
  + file preview/download. Telegram drops notes (stash ingest) **and files** (getFile
  download) into `/stacks/inbox/`. Palette "Stacks"/"New note", `n` to jot. Covered by
  `tools/smoke-stacks.mjs`. *(Remaining within A: swap the textarea for cm6.)*
- **B — Filing.** Naming-scheme (path/frontmatter) + stacks routing rules → auto-subfolder.
  *Ships: the "lands in the right place" magic.*
- **C — Metadata + MCP.** Frontmatter/sidecar tags + the `weir_stacks*` tools (so Claude
  reads/writes/files/tags). Opt-in cataloging of stacks entries. *Ships: co-curation.*

Later: drag-to-move UI, external-edit rescan/sync, PDF text-extraction → catalog,
**wiki-link rendering** (autocomplete + a "what links here" backlink panel — the `[[uid]]`
syntax + by-uid resolver are reserved in Stage A per §9, only the UI is later),
Mini-App remote browse.
