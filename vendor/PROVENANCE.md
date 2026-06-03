# Vendored dependencies

Everything here is vendored **as source** from the sibling repo
[`@gcu/auditable`](https://github.com/endarthur/auditable) — fully ours, no npm
install. Re-vendor by running **`node tools/sync-vendor.mjs`** (auto-locates
`../auditable`) and updating the rows below. Per the librarian vendoring contract
(`auditable/ext/librarian/SPEC.md` § Vendoring): **never hand-edit a vendored
file** — fix upstream in canon, then re-sync.

Source snapshot: `auditable@bba50e15`, vendored 2026-05-30.

| Path | Source in auditable | Version | License | Notes |
|------|---------------------|---------|---------|-------|
| `vfs.js` | `ext/vfs/index.js` | @gcu/vfs 0.1.0 | MIT | Built single-file ESM bundle. Exports `VFS`, `IDBBackend`, `OPFSBackend`, `FSAABackend`, `MemoryBackend`, `path`, … Storage backbone (backend-swappable IDB / OPFS / FSA). |
| `bridge-client.js` | `../bridge` repo `client/bridge-client.js` | @gcu/bridge 0.3.6+ (gentropic/bridge@6c56584) | CC0-1.0 | Page-side fetch broker. Exports `gcuFetch`, `hasBridge`, `bridgeVersion`, `clearBridgeCache`. Re-vendored 2026-06-03 for the detectBridge marker-re-check fix (no sticky false-negative stranding the session on direct fetch). Probed non-blockingly for status; the poller's transport. |
| `librarian.js` | `ext/librarian/index.js` (built bundle) | @gcu/librarian 0.2 (v2 CSR) | MIT | BM25F full-text search engine (unified typed-array CSR; lean folded mode, fuzzy/prefix, incremental addDoc/removeDoc, pack/unpack, scan). Vendored via `tools/sync-vendor.mjs` (never hand-edit — upstream-first per the librarian vendoring contract). Consumed by `src/js/search.js` (search v2). |
| `webmcp-shim.js` | `../webmcp` repo `shim.js` | @gcu/webmcp 0.1.0 | MIT | WebMCP client shim. Plain IIFE — installs `window.gcuWebMCP` + a `navigator.modelContext` polyfill, relays tool calls to the @gcu/webmcp bridge over localhost. Consumed by `src/js/webmcp.js` (weir's tool adapter). Injectable fetch (set to `gcuFetch`) routes the HTTP transport through the bridge extension for the public-origin PWA. |
| `yaml.js` | `ext/yaml/index.js` | @gcu/yaml 0.1 | MIT | Strict, no-RCE YAML 1.2 subset (quoted scalars, local tags only — no anchors/aliases/global tags). Built single-file ESM. Exports `parse`, `emit`, `check`, `format`, `scalar`, `mapNode`, `seqNode`, `YamlParseError`. Consumed by `src/js/stacks.js` for note/sidecar frontmatter (canonical, Obsidian-readable, round-trips through vanilla YAML). |
| `cm6.min.js` | `ext/cm6/cm6.min.js` (rollup IIFE of @codemirror/*) | CodeMirror 6 | MIT | CodeMirror 6 editor, bundled as a single IIFE → global `CM6` (NOT an ESM — side-effect `import` in main.js; the build inlines the IIFE, `var CM6` becomes the bundle global). Exposes `EditorView`, `EditorState`, `keymap`, `minimalSetup`, `markdown`, `history`, `indentWithTab`, … (see `ext/cm6/entry.mjs`). The stacks note editor (`src/js/ui/app.js`). ~640 KB — the bundle's heaviest single dependency. |
| `LICENSE-codemirror.txt` | `ext/cm6/LICENSE-codemirror.txt` | — | MIT | CodeMirror 6 license text (attribution travels with the vendored bundle). |
| `switchboard/tokens.css` | `src/style.css` (token layers 1–3) + `ext/switchboard` | Switchboard 1.0 | MIT | `--sw-*` / `--au-*` / `--ui-*` token system, basalt dark theme, plus `@font-face` for the fonts below. |
| `switchboard/fonts/barlow-{400,500,600,700}.woff2` | `ext/switchboard/fonts/` | Barlow | OFL 1.1 | UI typeface. |
| `switchboard/fonts/space-mono-{400,400i,700}.woff2` | `ext/switchboard/fonts/` | Space Mono | OFL 1.1 | Metadata / mono typeface. |
| `switchboard/fonts/OFL.txt` | `ext/switchboard/fonts/OFL.txt` | — | OFL 1.1 | Font license text (required attribution). |

## License notes

- Vendored **code** (VFS, token CSS) is MIT, matching weir's own MIT license.
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
