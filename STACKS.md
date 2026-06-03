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

- **Notes (`.md`)** carry **YAML frontmatter**: `tags`, `source`, `created`,
  `glass_id?`. Portable + Obsidian-native.
- **Files** carry a **sidecar** `…​.meta.json` next to them: same fields. The file
  itself stays pristine.
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

## 5. The Stacks view **[designed]**

- A **folder tree** (rail or main) — expand/collapse, item counts, drag-to-move
  (later). Distinct from the Sources rail.
- A **note reader/editor** — render markdown; edit in place (saves to the file +
  frontmatter). Files get a preview/download/open-original.
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
- **Stacks entries are items.** ✅ Confirmed — the unification stands.
- **Conflict / dedup**: stable **id = `stacks:<path-hash>`**, so a re-send or external
  edit at the same path **updates** (never duplicates). A genuinely new file at a taken
  path → version (`name (2).ext`).
- **Folder moves don't touch call numbers** — the glass call number is from facets, not
  the stacks path. File by folder *and* wander by subject; independent axes.

## 10. Staging (build order)

- **A — Foundation.** `/stacks` store (real files when mounted; IDB blobs otherwise),
  stacks items (`feed_id:'stacks'`, `path`), a **Stacks tree view** + a markdown
  reader/editor + file preview. Telegram drops notes+files into `/stacks/inbox/`.
  *Ships: a working stacks you can put things in and browse.*
- **B — Filing.** Naming-scheme (path/frontmatter) + stacks routing rules → auto-subfolder.
  *Ships: the "lands in the right place" magic.*
- **C — Metadata + MCP.** Frontmatter/sidecar tags + the `weir_stacks*` tools (so Claude
  reads/writes/files/tags). Opt-in cataloging of stacks entries. *Ships: co-curation.*

Later: drag-to-move UI, external-edit rescan/sync, PDF text-extraction → catalog,
backlinks/wiki-links between notes (Obsidian-style), Mini-App remote browse.
