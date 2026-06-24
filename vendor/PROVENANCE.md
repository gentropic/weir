# Vendored dependencies

Everything here is vendored **as source** from the sibling repo
[`@gcu/auditable`](https://github.com/endarthur/auditable) — fully ours, no npm
install. Re-vendor by running **`node tools/sync-vendor.mjs`** (auto-locates
`../auditable`) and updating the rows below. Per the librarian vendoring contract
(`auditable/ext/librarian/SPEC.md` § Vendoring): **never hand-edit a vendored
file** — fix upstream in canon, then re-sync.

Source snapshot: `auditable@bba50e15`, vendored 2026-05-30. `vfs.js` re-vendored from
`auditable@4f202b8` (2026-06-24, vfs 0.7.0→**0.7.1**) — **escape `Dropbox-API-Arg` (non-ASCII →
`\uXXXX`)**, fixing upload *and* download of paths with accented/unicode characters (a malformed
ASCII-only header was failing the request, surfacing as a bogus CORS error; confirmed live via
`__weir.dbxDiag`). Earlier: re-vendored from
`auditable@2bb73b5` (2026-06-24, vfs 0.6.0→0.7.0) — **plumb the optimized backend API through
the VFS router + cache/overlay composers** (capability-detect + fallback): `writeFiles`/`deleteBatch`/
`listTree`/recursive-remove now work at the *facade* level, and `vfs.rm({recursive})`/`rmdir` use the
backend's one-shot path instead of re-walking. (weir reaches concrete backends directly today, so this
is mainly correctness-through-composition + future-proofing if the Dropbox remote is ever cache-wrapped.)
Earlier: re-vendored from `auditable@e06a0ee` (2026-06-24, vfs 0.5.0→0.6.0) for **IDBBackend transaction batching** —
one tx per compound op (writeFile 3 tx→1, atomic), `writeFiles`/`deleteBatch` bulk in one tx/chunk,
native recursive `rmdir` + atomic dir `rename` via `IDBKeyRange`. The mobile-store (IndexedDB) twin
of the Dropbox/FSA batching — directly speeds up weir on the phone. Earlier: re-vendored from
`auditable@7b4429a` (2026-06-24, vfs 0.4.0→0.5.0) for `HandleBackend` **native recursive
`removeEntry`** (folder delete/rename = one call, not an O(subtree) walk) + **`createReadStream`**
implemented to match `streamable` (`vfs-handle-followups.md`). Earlier: re-vendored from
`auditable@cf3b684` (2026-06-24, vfs 0.3.0→0.4.0) for the **`HandleBackend` directory-handle
cache** (fast FSA on Android/SAF + DeX — `vfs-handle-cache-spec.md`; helps desktop/DeX FSA +
Auditable, weir keeps mobile on IDB). Earlier: re-vendored from
`auditable@7c9e8cf` (2026-06-24, vfs 0.2.0→0.3.0) for **DropboxBackend efficiency + rate-limit
citizenship** (`listTree`/`writeFiles`/centralized 429+`Retry-After` backoff; spec
`auditable/spec_inbox/vfs-dropbox-efficiency-spec.md`) — the sync engine rewire to use them is the
weir-side follow-up. Earlier: re-vendored from `auditable@1d8fed4` (2026-06-09) for `DropboxBackend`. `webmcp-fs-channel.js` + `webmcp-shim.js` re-vendored from `numen@587f7ce` (2026-06-23) for the fs
**`offline`** state — a stale `bridge.live` (> `LIVENESS_MS`) now reads as bridge-down, not an
eternal `connecting` (numen `tools/smoke-fs-offline.mjs`). `librarian.js` re-vendored from
`auditable@e9bb47b` (2026-06-22) for **diacritic-fold tokenization + fuzzy-match gating**
(retrieval-precision fixes — `geoestatística` now tokenizes whole, `sondagem`↛`soldagem`).
NB the tokenizer change alters token shapes → consumers reindex; weir's search index is
in-memory (rebuilt at startup from items), so a deploy + reload reindexes automatically.

| Path | Source in auditable | Version | License | Notes |
|------|---------------------|---------|---------|-------|
| `vfs.js` | `ext/vfs/index.js` | @gcu/vfs 0.7.1 | MIT | Built single-file ESM bundle. Exports `VFS`, `IDBBackend`, `OPFSBackend`, `FSAABackend`, `MemoryBackend`, `FetchBackend`, `RESTBackend`, `OverlayBackend`, `CacheBackend`, **`DropboxBackend`**, `path`, … Storage backbone (backend-swappable + mount table). **Re-vendored 2026-06-09 (`auditable@1d8fed4`, vfs 0.1.0→0.2.0) for `DropboxBackend`** — the cloud-sync backend (SYNC.md; spec'd via `spec_inbox`), mounted secondary + `cache`-wrapped, with `getToken` injected by weir's `src/js/dropbox.js`. Vendored separately (direct copy of the built bundle), not via `sync-vendor.mjs`. |
| `bridge-client.js` | `../bridge` repo `client/bridge-client.js` | @gcu/bridge 0.3.6+ (gentropic/bridge@6c56584) | CC0-1.0 | Page-side fetch broker. Exports `gcuFetch`, `hasBridge`, `bridgeVersion`, `clearBridgeCache`. Re-vendored 2026-06-03 for the detectBridge marker-re-check fix (no sticky false-negative stranding the session on direct fetch). Probed non-blockingly for status; the poller's transport. |
| `librarian.js` | `ext/librarian/index.js` (built bundle) | @gcu/librarian 0.2 (v2 CSR) | MIT | BM25F full-text search engine (unified typed-array CSR; lean folded mode, fuzzy/prefix, incremental addDoc/removeDoc, pack/unpack, scan). Vendored via `tools/sync-vendor.mjs` (never hand-edit — upstream-first per the librarian vendoring contract). Consumed by `src/js/search.js` (search v2). |
| `webmcp-shim.js` | `../numen` repo `shim.js` | @gcu/numen 0.1.3 | MIT | WebMCP client shim. Plain IIFE — installs `window.gcuWebMCP` (alias `gcuMCP`) + a `navigator.modelContext` polyfill, relays tool calls to the @gcu/numen bridge. Transports: WS / HTTP-long-poll over localhost (injectable `gcuFetch` routes HTTP through the bridge extension for the public-origin PWA), and **`fs`** — set `gcuWebMCP.folder = <FileSystemDirectoryHandle>` and connect with a bare token to relay over a shared (optionally synced) folder, no port/extension (uses `webmcp-fs-channel.js`). **Re-vendored 2026-06-20 (numen 0.1.3) for fs MULTICHANNEL** (SPEC-numen-multichannel.md): `gcuMCP.addFolder({id,handle,token,identity})` runs N fs channels at once (one per folder = one agent), all sharing the tool registry; replies route to the calling channel and its `identity` is carried into `tool.execute(input, client)` (`client.identity`) — the SPEC-librarian §2 provenance hook. `connectFolder`/`wm.folder`+`connect` remain the single-channel ('default') path. Consumed by `src/js/webmcp.js`. |
| `pdfjs/pdf.min.mjs` + `pdfjs/pdf.worker.min.mjs` | npm `pdfjs-dist@6.0.227` (`build/*.min.mjs`) | Mozilla pdf.js 6.0.227 | Apache-2.0 | PDF text extraction for the **documents** feature (SPEC-documents). **NOT inlined** into `index.html` — a ~1.7 MB vendored *sibling* (448 KB lib + 1.25 MB worker), **dynamic-imported on first document use** (`src/js/documents.js` → `loadPdfjs`), so it never weighs on base-app startup; the cache-first SW runtime-caches it (offline after first open). `LICENSE` kept alongside. Served from `vendor/pdfjs/` (the Pages root); no build inlining/copy. |
| `webmcp-fs-channel.js` | `../numen` repo `fs-channel.js` | @gcu/numen | MIT | The `fs`-transport protocol core (TRANSPORTS.md §3) — formerly `@gcu/webmcp`, now consolidated into `@gcu/numen` (the vendored filename keeps the legacy `webmcp-` prefix; "webmcp" survives only as the protocol/global name). A `FsChannel` pure over injected dir/hmac/now/randomId adapters, attaches `globalThis.GcuFsChannel` in the browser. Signed-sentinel framing (sync-safe atomicity + per-frame HMAC), per-connection epochs, in-order exactly-once delivery. The shim drives it with an FSA dir-adapter + `crypto.subtle` HKDF/HMAC. Loaded before `webmcp-shim.js` in main.js. |
| `yaml.js` | `ext/yaml/index.js` | @gcu/yaml 0.1 | MIT | Strict, no-RCE YAML 1.2 subset (quoted scalars, local tags only — no anchors/aliases/global tags). Built single-file ESM. Exports `parse`, `emit`, `check`, `format`, `scalar`, `mapNode`, `seqNode`, `YamlParseError`. Consumed by `src/js/stacks.js` for note/sidecar frontmatter (canonical, Obsidian-readable, round-trips through vanilla YAML). |
| `cm6.min.js` | `ext/cm6/cm6.min.js` (rollup IIFE of @codemirror/*) | CodeMirror 6 | MIT | CodeMirror 6 editor, bundled as a single IIFE → global `CM6` (NOT an ESM — side-effect `import` in main.js; the build inlines the IIFE, `var CM6` becomes the bundle global). Exposes `EditorView`, `EditorState`, `keymap`, `minimalSetup`, `markdown`, `history`, `indentWithTab`, … (see `ext/cm6/entry.mjs`). The stacks note editor (`src/js/ui/app.js`). ~640 KB — the bundle's heaviest single dependency. |
| `LICENSE-codemirror.txt` | `ext/cm6/LICENSE-codemirror.txt` | — | MIT | CodeMirror 6 license text (attribution travels with the vendored bundle). |
| `rails.js` | `ext/rails/index.js` (built bundle) | @gcu/rails 0.1.0 | MIT | Docked tabbed-workspace layout engine — rails/stacks/tabs/floats, splitters, drag. **Panels never reparent**, so canvases / iframes / focused CM6 editors survive every drag (its reason to exist; proven against AW's live notebook editors). Built single-file ESM → exports `createRails`, `findTab`, `findStack`, `findRail`, `emptyState`, `validateState`, `freshId`. **Prototype only so far** (`proto/rails-notes.html`) — the go/no-go for the notes-pane workspace shell (ROADMAP "UI architecture"); not yet wired into the build/`main.js`. ~85 KB. |
| `rails.css` | `ext/rails/rails.css` | @gcu/rails 0.1.0 | MIT | Structural CSS for rails (unstyled — the consumer themes the `.rails-*` classes; the proto themes them with `--sw-*` tokens). |
| `switchboard/tokens.css` | `src/style.css` (token layers 1–3) + `ext/switchboard` | Switchboard 1.0 | MIT | `--sw-*` / `--au-*` / `--ui-*` token system, basalt dark theme, plus `@font-face` for the fonts below. |
| `switchboard/fonts/barlow-{400,500,600,700}.woff2` | `ext/switchboard/fonts/` | Barlow | OFL 1.1 | UI typeface. |
| `switchboard/fonts/space-mono-{400,400i,700}.woff2` | `ext/switchboard/fonts/` | Space Mono | OFL 1.1 | Metadata / mono typeface. |
| `switchboard/fonts/OFL.txt` | `ext/switchboard/fonts/OFL.txt` | — | OFL 1.1 | Font license text (required attribution). |

## License notes

- Vendored **code** (VFS, token CSS) is MIT, matching weir's own MIT license.
- **pdf.js** is Apache-2.0 (permissive, MIT-compatible for redistribution); `vendor/pdfjs/LICENSE`
  travels with it.
- Vendored **fonts** are under the SIL Open Font License 1.1. The OFL requires the
  license text to travel with the fonts; `switchboard/fonts/OFL.txt` satisfies that.
  When the single-file `weir.html` build inlines the fonts (base64), it must also
  surface this attribution (e.g. an embedded licenses note, mirroring auditable's
  `vendor-licenses.json` → `__BUILD_LICENSES__` mechanism).

## Candidates not yet vendored

Identified as useful during the auditable survey; pull in when the relevant
milestone arrives:

- `ext/menu` + `ext/dialog` — context menus, modals (add-feed / OPML / confirm). v0.1 UI.
- `ext/sideact` — signals + `h` templates for the reactive two-pane UI. v0.1 UI (optional).
- `ext/librarian` — BM25 inverted-index search. v0.2. **Sync pipe is set up**
  (`tools/sync-vendor.mjs`, verified end-to-end against current librarian) but the
  `FILES` row is commented out and it is **not yet wired into the build** — we're
  waiting on **librarian v2** (lean CSR engine; see
  `auditable/spec_inbox/librarian-search-spec.md` + `…/ext/librarian/SPEC.md`
  § v2-direction, and the weir requirements at
  `auditable/spec_inbox/weir-search-requirements.md`). When v2 ships: uncomment the
  `FILES` row, `node tools/sync-vendor.mjs`, add `vendor/librarian.js` to
  `src/js/main.js`, and add a row above.
- `ext/reader-core` — architecture reference for the render/state pipeline; adapt, don't copy wholesale.
- `vendor/worldmap.js` — Natural Earth **110m land** (PUBLIC DOMAIN, naturalearthdata.com),
  pre-projected to a compact equirectangular SVG path (`viewBox "0 0 360 180"`, so
  `(lon,lat) → (lon+180, 90-lat)`). For the offline card mini-map / map view (gauge
  events with coords). Regenerate: `curl …/ne_110m_land.json` → `node tools/prep-worldmap.mjs`.
  ~53 KB raw / ~20 KB gz. The heavier interactive GIS (pan/zoom, basemaps) is the
  lazy-loaded `@gcu/spinifex` layer (ROADMAP), not this.
