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
| `bridge-client.js` | `../bridge` repo `client/bridge-client.js` | @gcu/bridge 0.3.1 | CC0-1.0 | Page-side fetch broker. Exports `gcuFetch`, `hasBridge`, `bridgeVersion`, `clearBridgeCache`. Probed non-blockingly for status; used by the poller later. |
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
