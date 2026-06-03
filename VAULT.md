# VAULT.md — weir's knowledge vault **[draft / for review]**

> The inbox is for *streams you process*. The catalog is *what you've kept, classified*.
> The **vault** is *what you author and drop* — notes you write and files you send —
> living as **real files in a real folder**, filed, tagged, catalogued, and curatable
> by you and by Claude. It's the third surface, and the one that makes weir a place to
> *put things*, not just read them.

Status: **design, nothing built.** This doc locks the model before code (the explicit
ask: don't brick the notes/file format into a shape we regret). Read after
[GLASS.md](GLASS.md) — the vault's entries are glass holdings like any other.

---

## 1. What it is

A tree of files under `/vault/` in the VFS:

```
/vault/
  inbox/                     # unfiled drops land here
  specs/weir/vault.md
  papers/kriging-notes.md
  receipts/2026/nota-fiscal.pdf
  ideas/telegram-miniapp.md
```

- **Mounted (FSA) → these are real files on disk** — open them in Obsidian, your
  editor, `git`, anything. weir *is* the vault; it isn't a copy. This is the whole
  point, and it's only possible because the store is already filesystem-mountable.
- **Unmounted (IDB) → the same tree as blobs.** Works, but big binary drops risk
  eviction; markdown notes are tiny and fine. The Vault settings surface a "mount for
  files" nudge.

Two entry kinds: **notes** (markdown, authored) and **files** (any dropped binary).

## 2. Relationship to the rest of weir **[settled]**

- **Vault entries are first-class items.** `feed_id: 'vault'`, `type: 'note' | 'file'`,
  plus a `path` (subfolder + filename). So they inherit **tags, search, routing, and
  the glass catalog** for free — a vault note about geostatistics shows up in the
  catalog, gets a `·` call number, intersects facets. No parallel universe.
- **But the vault is its own VIEW** (a folder tree), not the inbox. The inbox stays
  feed-shaped (process-and-clear); the vault is browse-and-keep. A vault item never
  sits in the inbox.
- **Content lives at the real tree path** — `/vault/<path>`, *not* the usual
  `/content/<feed>/<itemKey>.html`. That's the one deliberate deviation from the
  normal item-content scheme, and it's what makes the files human-named and mountable.

## 3. Metadata + tags (sidecar) **[designed]**

- **Notes (`.md`)** carry **YAML frontmatter**: `tags`, `source`, `created`,
  `glass_id?`. Portable + Obsidian-native.
- **Files** carry a **sidecar** `…​.meta.json` next to them: same fields. The file
  itself stays pristine.
- Tags written here are the *portable* copy; weir's in-memory index is still hydrated
  from the per-feed shard (`/items/vault.ndjson`) like every item. **Source of truth
  in v1: the shard**; frontmatter/sidecar is the mirror weir writes on save and reads
  on (re)scan. External edits (you change frontmatter in Obsidian) sync on a **"rescan
  vault"** pass — see open questions.

## 4. Filing — "ready in the right place" **[designed]**

An arriving entry's subfolder is decided by, in order:

1. **Explicit path / naming scheme.** Send `specs/weir/vault.md` (or set frontmatter
   `folder: specs/weir`) → it files straight to `/vault/specs/weir/`. Zero config.
   This is the path you described: write a spec in Claude web, name it sensibly, send
   it, it lands filed.
2. **Vault routing rules.** The *same* `{ when, then }` engine as feed routing, but
   `then` yields a **folder** (+ tags): `when: n => /\bspec\b/.test(n.title), then: {
   folder: 'specs', tag: ['spec'] }`. Stored as JS, `eval`'d, applied at intake.
3. **Fallback → `/vault/inbox/`** (unfiled), so nothing is ever lost waiting to be sorted.

## 5. The Vault view **[designed]**

- A **folder tree** (rail or main) — expand/collapse, item counts, drag-to-move
  (later). Distinct from the Sources rail.
- A **note reader/editor** — render markdown; edit in place (saves to the file +
  frontmatter). Files get a preview/download/open-original.
- Filing UI: move an entry to another folder; create folders; the routing-rules editor
  (reusing the feed-rules editor).

## 6. MCP adapters — Claude curates the vault **[designed]**

So "write a spec, send it, I help file/link it" works end-to-end:

- `weir_vaultList(path?)` — the tree (or a subtree): folders + entries with tags.
- `weir_vaultRead(path, {content?})` — a note's body / a file's metadata.
- `weir_vaultWrite({path, markdown, tags?, folder?})` — create/update a note (I can
  draft a note straight into your vault).
- `weir_vaultMove(path, toFolder)` — file/refile an entry.
- `weir_vaultTag(path, {add?, remove?})` — tag it.

(All reuse the existing tag/route/store machinery; they're vault-pathed wrappers.)

## 7. Inflows **[designed]**

- **Telegram** (already capturing): notes → markdown in the vault; **files** → fetched
  via `getFile` (≤20 MB Bot API cap) → the vault; both filed by §4. The pending
  `/telegram-notes.ndjson` stash is the *first thing the vault ingests* when built.
- **In-app**: new-note button; drag-drop a file onto weir.
- **Claude** via `vaultWrite` (above).
- **Mount**: drop a file in the folder from your OS → weir picks it up on rescan.

## 8. Cataloging the vault **[designed]**

A vault entry is a holding, so it can be **cataloged like anything** → glass facets +
description + a `·` call number, searchable alongside feeds. Markdown notes catalog
trivially (the text is the content). **PDFs/docs need text extraction** first (the
roadmap's "extract at import" stretch) — until then they catalog from filename +
sidecar, or stay Stage-0. Cataloging the vault is **opt-in per entry / folder**, not
automatic (your notes aren't feed slop to auto-classify).

## 9. Open questions / decisions to make

- **Mount required for files?** Proposal: vault works unmounted (IDB blobs), but warn
  on large file drops; markdown always fine. Or: gate *file* drops on a mount.
- **Sync / source-of-truth** when files are edited externally (Obsidian) *and* in weir.
  Proposal: shard is truth; a manual/periodic **rescan** reconciles from disk
  (frontmatter wins for tags, mtime for body?). Real two-way live sync is a later, hard
  problem — don't promise it in v1.
- **Conflict / dedup**: same path twice → overwrite, or version (`name (2).md`)?
  Idempotent re-send should update, not duplicate (stable id from path).
- **Item id**: `vault:<path-hash>` (stable across re-sends/edits at the same path).
- **Does moving a folder rewrite call numbers?** No — the glass call number is from
  facets, not the vault path; the vault tree and the catalog shelf are independent axes
  (you can file by folder *and* wander by subject).

## 10. Staging (build order)

- **A — Foundation.** `/vault` store (real files when mounted; IDB blobs otherwise),
  vault items (`feed_id:'vault'`, `path`), a **Vault tree view** + a markdown
  reader/editor + file preview. Telegram drops notes+files into `/vault/inbox/`.
  *Ships: a working vault you can put things in and browse.*
- **B — Filing.** Naming-scheme (path/frontmatter) + vault routing rules → auto-subfolder.
  *Ships: the "lands in the right place" magic.*
- **C — Metadata + MCP.** Frontmatter/sidecar tags + the `weir_vault*` tools (so Claude
  reads/writes/files/tags). Opt-in cataloging of vault entries. *Ships: co-curation.*

Later: drag-to-move UI, external-edit rescan/sync, PDF text-extraction → catalog,
backlinks/wiki-links between notes (Obsidian-style), Mini-App remote browse.
