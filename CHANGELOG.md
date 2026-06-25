# Changelog

All notable changes to `@gcu/weir` are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is described in
[SPEC.md §9](SPEC.md).

## [Unreleased]

### Responsive — in-pane reading toolbar (prev/next + actions) — 2026-06-24

- A reading toolbar at the top of the opened item: **← prev / next →** (the reading-walk —
  `moveSelection`, opens the adjacent item in place) plus **save · mark-read · note · open · close**.
  Sticky to the top of the tablet reading pane; shown in reader + tablet (touch layouts where the
  row actions/footer aren't at hand); **hidden on desktop** (it has hover row actions). Buttons are
  `data-act` → the existing `doAct` (new acts: `prev`/`next`/`collapse`); no new dispatch path.
  Playwright-verified.

### Responsive — tablet master-detail tier (list + reading pane) — 2026-06-24

- The `tablet` layout is now its **own** two-pane master-detail, not a big phone: the stream is a
  **list on the left** (~44%), the opened item reads in a **pane on the right** (~56%). Reuses the
  existing inline-expand (`expandedId`) — the expanded row's `.iexpand` is lifted out of the list
  flow into a fixed right pane (it can't be reparented — the row is `position:relative` for its
  actions — so it's fixed, cleared from the topbar via a JS-set `--content-top`, above the bottom
  nav). An empty pane shows a "Select an item to read" placeholder (`:has()` + `::after`). No render
  fork — pure CSS routing of the same content. Playwright-verified in `tools/e2e-layout.mjs`.

### Responsive — layout modes (Auto/Workspace/Tablet/Reader) + chooser + rail gear — 2026-06-24

- **Layout is now a *mode*, not just an auto-breakpoint.** A resolver in the build's `<head>` sets
  `<html data-layout>` from a **device-local** pref (`localStorage 'weir-layout'`) + viewport width,
  before paint (no flash of the wrong layout); the CSS keys on `[data-layout]` instead of a media
  query. Auto picks by width (≤700 reader · ≤1024 tablet · else workspace), but you can **override**
  it — fixes DeX/narrow-window misdetection or just preference. Per-device (phone, tablet, desktop
  each keep their own; not synced).
- **Settings → reading → Display:** a layout picker (Auto · Workspace · Tablet · Reader), applied
  live. **Plus a ⚙ gear on the rail** (a discoverable settings entry, not just the topbar).
- Foundation step: `tablet` currently shares the reader styles; the **master-detail two-pane tablet
  tier** (`[data-layout="tablet"]`, list + reading column) is the next step. Replaces the raw
  `max-width:1024px` breakpoint from earlier today.

### Responsive — fix tablet-portrait cropping (breakpoint 720 → 1024) — 2026-06-24

- The reader breakpoint was `max-width: 720px`, so a tablet in **portrait** (e.g. Galaxy Tab S10 FE,
  1440×2304 → ~800–960 CSS-wide in portrait) fell *above* it and got the desktop two-pane layout —
  which doesn't fit at that width, so the topbar's button row + panes **cropped** off the right edge.
  Landscape (~1152–1536) fit, so it looked fine. Raised the breakpoint to **`1024px`**: tablet
  portrait now gets the touch reader layout (drawer, bottom nav, single column, big reading) and
  landscape keeps the desktop workspace — a clean split regardless of the device's exact DPR, and
  the conventional tablet/desktop line. (A narrow desktop window <1024 also gets the reader — standard
  responsive behavior.)

### Sync — handle rate-limit-masked-as-CORS (back off on throw; smaller burst) — 2026-06-24

- With the unicode-path fix in, sync **works** (`[sync] ↑ 8 ↓ 1`), but a burst still tripped
  Dropbox's rate limit — and a **429 on a content endpoint omits the CORS header**, so the browser
  blocks it and `fetch` **throws** before the backend can read the `429`, meaning its `Retry-After`
  backoff never engages and weir just hammered the failed files. Now `syncRetry` treats a thrown
  **"Failed to fetch"** (the masked 429 / a network drop) as a **seconds-long, escalating backoff**
  (not the sub-second transient ramp), and **push concurrency drops 4 → 2** so we trip the limit
  less. The backlog drains gradually instead of churning; failures resume next cycle (manifest is
  checkpointed). Test: `tools/smoke-sync.mjs`.

### Sync — ROOT FIX: escape `Dropbox-API-Arg` (unicode paths) — `@gcu/vfs` 0.7.1 — 2026-06-24

- **The real cause of the "CORS" upload/download failures.** Dropbox's content endpoints carry the
  path in the **`Dropbox-API-Arg` HTTP header**, which must be ASCII — but the backend set it with
  plain `JSON.stringify`, so any path with **accented/unicode characters** (notes, accented feed
  names) made a malformed header → the request failed, and the error response (no CORS header)
  surfaced as a bogus `No 'Access-Control-Allow-Origin'`. It broke **both upload and download** for
  those paths (ASCII paths always worked — which is why the bulk of the corpus synced and only the
  unicode-named files failed, looking like flaky CORS). Confirmed live with a 3-way diagnostic
  (`__weir.dbxDiag`: ascii→200, unicode-raw→threw, unicode-escaped→200).
- Fixed upstream in **`@gcu/vfs` 0.7.1** (`auditable@4f202b8`): `DropboxBackend._apiArg` escapes
  non-ASCII as `\uXXXX` (what the Dropbox SDK does). Re-vendored. Sync now works for *all* paths.

### Sync — fix: push reverts to per-file upload (Dropbox `upload_session` is CORS-blocked) — 2026-06-24

- **Push was broken from the browser.** The batched-push path called the backend's `writeFiles`,
  which uses Dropbox `upload_session/finish_batch` — and those content endpoints are **not
  CORS-enabled**, so the browser got `No 'Access-Control-Allow-Origin'` → `Failed to fetch` on every
  upload. Reverted push to **per-file `files/upload`** (which *is* CORS-enabled). The throttle that
  batching was meant to avoid (`too_many_write_operations`) is now ridden out by the backend's
  429/`Retry-After` backoff (vfs 0.3.0 `_send`), so per-file at low concurrency is correct + resilient.
  (Pull's *local* `writeFiles` batching is unaffected — IDB, no network/CORS.) Build f0bf742.
- **Follow-on: the parent-`mkdir` storm was *causing* an upload "CORS" error.** `syncEnsureParent`
  ran `mkdir(recursive)` on the parent **per file** → ~1 `create_folder_v2` per upload (all 409
  "exists"), hammering Dropbox's rate limit; a 429 on a content endpoint comes back **without** a
  CORS header, so the browser masked it as `No 'Access-Control-Allow-Origin'` on `files/upload`. Now
  push ensures each unique parent dir **once per session** (cached — weir never deletes remote dirs;
  Dropbox upload auto-creates parents anyway). Kills the 409 spam + the rate-limit pressure → real
  uploads go through. Build f5a7301.
- Upstream: `@gcu/vfs` `DropboxBackend.writeFiles` is browser-unusable as written (upload_session);
  noted to auditable to reimplement it over parallel `files/upload`.

### Documents — v0 spike: pdf.js vendored as a sibling + text extraction — 2026-06-24

- First slice of SPEC-documents (PDF/EPUB as first-class corpus). **pdf.js (`pdfjs-dist@6.0.227`,
  Apache-2.0) is vendored as a ~1.7 MB *sibling* under `vendor/pdfjs/` — NOT inlined into
  `index.html`** (confirmed: the bundle grew ~30 KB, not 1.7 MB). It's **dynamic-imported on first
  document use** (`src/js/documents.js` → `loadPdfjs`/`extractPdfText`), so it never weighs on
  base-app startup; the cache-first SW runtime-caches it (offline after first open), no `sw.js`
  change needed. `extractPdfText(bytes)` returns per-page text + page-offset map (the seed for
  page-anchored `weir_quote`). Reading order is **naive** for now — the column/de-hyphen/header-strip
  reconstruction (SPEC §3) is the next slice, as a re-runnable `extract_algo` layer.
- Console test hook: `await __weir.testPdf()` (pick a PDF → load pdf.js → extract → log pages/chars/ms).
  No storage/item/ingest UI yet (v0 step 2+). Decision: pdf.js stays a vendored sibling (local,
  offline, auditable — no CDN), per the PWA's already-multi-file deploy.

### Storage — re-vendor `@gcu/vfs` 0.7.0 (optimized API through the router) — 2026-06-24

- Re-vendored `vfs.js` from `auditable@2bb73b5` (0.6.0→0.7.0). The 0.3–0.6 backend fast paths
  (`writeFiles`/`deleteBatch`/`listTree`/native recursive delete) are now **plumbed through the VFS
  router + cache/overlay composers** with capability-detect + graceful fallback — so they work at
  the *facade* level (`vfs.writeFiles` etc.), not only by addressing the concrete backend; and
  `vfs.rm({recursive})`/`vfs.rmdir` use the backend's one-shot path instead of re-walking the tree.
  weir reaches the concrete backends directly today (un-cached primary mounts), so this is mainly
  correctness-through-composition + future-proofing for an eventual cache-wrapped Dropbox remote
  (SYNC.md offline-first). Full smoke green on the new bundle.

### Sync — bootstrap batches local writes (`local.writeFiles`) — 2026-06-24

- A reader's first pull now commits downloaded files to the local store in **batches** via the
  local backend's `writeFiles` (one IndexedDB transaction per ~200-file chunk) instead of a
  `writeFile` per file — the local-write twin of the batched push, cashing in `@gcu/vfs` 0.6.0.
  Bounded memory (a chunk in flight), feature-detected (`_localBackend().writeFiles`) with the
  per-file path as fallback, so it activates on the phone's IDB store and no-ops on memory/FSA.
  Download still dominates a first sync — this trims the on-device write overhead on top. Bootstrap
  only (incremental deltas are small). Test: `tools/smoke-sync.mjs`. No upstream change (consumes 0.6.0).

### Storage — re-vendor `@gcu/vfs` 0.6.0 (IndexedDB transaction batching) — 2026-06-24

- Re-vendored `vfs.js` from `auditable@e06a0ee` (0.5.0→0.6.0). **`IDBBackend` now batches into one
  transaction per compound op** — `writeFile` goes 3 tx→1 (and atomic, closing a parent-check→put
  TOCTOU), and `writeFiles`/`deleteBatch` bulk in one tx per 1000-file chunk; recursive `rmdir` +
  atomic directory `rename` use `IDBKeyRange` range ops. This is the **mobile-store twin** of the
  Dropbox/FSA batching — IndexedDB is exactly what weir runs on the phone, so a ~1,500-file
  copy-in drops from ~4,500 transactions to far fewer, and every store write is now one atomic tx.
  Full smoke green on the new bundle. (Next, weir-side: have `pull` write locally via
  `local.writeFiles` to cash in the bulk path on a reader's first sync.)

### Storage — re-vendor `@gcu/vfs` 0.5.0 (native recursive delete + streamable) — 2026-06-24

- Re-vendored `vfs.js` from `auditable@7b4429a` (0.4.0→0.5.0). `HandleBackend` now uses native
  **`removeEntry(name, { recursive: true })`** for folder delete/rename — one call instead of an
  O(subtree) `stat`+delete walk (a real Android win on top of the cache; the in-app "clear a
  folder…" benefits too), and **`createReadStream`** is implemented off the file handle's `.stream()`
  so it matches `streamable`. (Auditable's side rightly rejected the `mkdir` idempotence nit I'd
  flagged — the exists-probe *is* the `EEXIST` source; dropping it would be a contract regression.)
  Full smoke green on the new bundle. Spec: `auditable/spec_inbox/vfs-handle-followups.md`.

### Storage — re-vendor `@gcu/vfs` 0.4.0 (FSA directory-handle cache) — 2026-06-24

- Re-vendored `vfs.js` from `auditable@cf3b684` (0.3.0→0.4.0). `HandleBackend` now **caches
  directory handles** (walks only from the deepest cached ancestor; invalidates on rmdir/rename;
  stale-handle safe) and trims redundant resolves (`writeFile` resolves the parent once; `stat`
  probes file-then-dir on one parent; `unlink`/`rmdir` type-check against the parent). On Android
  each `getDirectoryHandle` is a SAF IPC, so an FSA-folder store dragged on DeX (both weir + Auditable);
  this collapses per-op walks to one-per-directory. Mostly helps **desktop/DeX FSA + Auditable** —
  weir keeps the mobile store on IndexedDB. Spec: `auditable/spec_inbox/vfs-handle-cache-spec.md`.
  Full smoke green on the new bundle.

### Sync — reader can't clobber the hub (safe by construction) + clear-a-folder — 2026-06-24

- **A `reader` now pushes ONLY its own deltas (notes, `/stacks/`), never corpus.** The roles model
  ("the hub is the corpus's single writer", SYNC.md §2) is now *enforced* in `SyncEngine`
  (`role` from `sync_role`, `syncReaderWritable`) instead of relying on care — so even if a reader
  **adopts a stale store**, its push can't overwrite the hub's canon (the corpus files are held
  back; `pull` then reconciles the reader's view from the hub). Read/saved/tags state lives inside
  item shards (corpus), so it doesn't round-trip up yet — a future delta-file is the proper fix.
  Test: `tools/smoke-sync.mjs` (reader pushes the note, holds back the 2 corpus files; hub pushes all).
- **Settings → storage → "clear a folder…"** — erase a chosen folder's contents from inside weir
  (recursive), so a stale weir store can be **wiped + mounted fresh** (copy-in) instead of adopted.
  Handy on Android where file managers are clunky. Strong, folder-named confirm; touches only the
  folder you pick, never the live store. (`fsmount.clearFolder`, `app.clearStoreFolder`.)

### Responsive — phase 1: reading typography — 2026-06-24

- Comfortable article/note reading on a phone. On the `≤720px` breakpoint the body (`.icontent`)
  gets a larger font (16.5 px) + roomier line-height (1.72) and proper paragraph / heading /
  list / blockquote / code spacing; the **expanded article breaks out past the pill column to a
  full-width measure** (and the pill column slims 92→60 px so list rows give content more room).
  Desktop unchanged.

### Responsive — phase 1: mobile bottom tab bar — 2026-06-24

- First phase-1 slice: a thumb-reachable **bottom tab bar** on narrow screens —
  **Inbox · Saved · Search · Notes** — wired to `setView`/`enterStacks` (+ Search focuses the
  field). The cramped footer (status bar) is hidden on mobile and replaced by the bar; the
  top-left ≡ drawer demotes to Sources/Facets. The active tab mirrors the current view. weir now
  navigates like an app instead of a squeezed desktop. (`#botnav` in the template, `style.css`
  `@media`, `app.renderBotNav`.) Desktop unchanged.

### Sync — fast bootstrap (`listTree`) + batched push (`writeFiles`) — 2026-06-24

- The sync engine now *uses* the `@gcu/vfs` 0.3.0 fast paths (feature-detected, with the old paths
  as fallback for non-Dropbox backends / tests):
  - **Bootstrap** does ONE `be.listTree('/')` sweep — whole tree (paths + content_hash) **and** the
    cursor in a single call — instead of `syncCollectPaths`' `readdir` + a `get_metadata` per file.
    That's the "checking the cloud folder" **minutes → ~1 s**; it also reuses listTree's cursor
    instead of a separate `latestCursor`.
  - **Push** commits changed files in **batches via `be.writeFiles`** (Dropbox `finish_batch`,
    chunked at 900) instead of per-file uploads — far gentler on the write-lock, so the first push
    stops tripping `too_many_write_operations`. Checkpoints the manifest per batch (resumable).
- Tests: `tools/smoke-sync.mjs` (listTree bootstrap uses one sweep + its cursor + skips
  dirs/excluded; writeFiles batches the changed set). Closes the rewire from the 0.3.0 re-vendor.

### Sync — re-vendor `@gcu/vfs` 0.3.0 (Dropbox rate-limit citizenship) — 2026-06-24

- Re-vendored `vfs.js` from `auditable@7c9e8cf` (vfs 0.2.0→0.3.0). The `DropboxBackend` now
  **honors 429/503 + `Retry-After` internally** (centralized in `_send`, with one transparent
  401→token-refresh retry) — so *every* Dropbox call backs off politely instead of weir guessing
  the delay, and the first push rides out `too_many_write_operations` rather than aborting.
- Also lands (available, not yet wired): **`listTree(p)`** (one recursive `list_folder` sweep →
  whole tree + cursor + `contentHash`, vs ~1,500 per-file `get_metadata` calls) and
  **`writeFiles(files)`** (upload-session `finish_batch` batch). `VFSError` gained an `extra` bag
  (`retryAfterMs` on `EBUSY`). The sync-engine rewire to *use* `listTree`/`writeFiles` (fast
  bootstrap + batch push) + simplify `syncRetry` is the next step. Spec:
  `auditable/spec_inbox/vfs-dropbox-efficiency-spec.md`.

### Sync — keep the screen awake during a sync + clearer first-sync progress — 2026-06-24

- A long first (bootstrap) sync on a phone/tablet could stall when the screen auto-locked
  (the page backgrounds + throttles). weir now **holds a screen Wake Lock while a sync is
  running** (`keepAwake('sync', …)` around `syncNow`; auto-released when done, re-acquired when
  the tab returns to foreground) — so the first sync survives an idle screen. Plus a manual
  **"keep the screen awake"** toggle in Settings → connections (persisted `keep_awake`), for
  reading sessions. Best-effort: no-ops where the Wake Lock API is unavailable.
- **Clearer first-sync feedback:** the bootstrap line now shows a **percent** alongside the
  count — `first sync — downloading 312/1357 · 23% (one-time, screen kept awake)…` — so you can
  tell it's progressing, not stuck. (`pwa.js` wake-lock helper; `renderSyncStatus`.)

### Responsive — phase 0: usable on a phone (source rail → drawer) + reader spec — 2026-06-24

- weir had **zero `@media` queries** — a fixed desktop layout, so a phone was useless (the 240 px
  source rail ate a ~360 px screen; viewport meta was already correct). Phase 0: a
  `max-width: 720px` breakpoint collapses `.app` to one column, turns the source rail into an
  **off-canvas drawer** (a `≡` toggle + scrim), gives the stream the full width, hides the resizer,
  and enlarges tap targets. Reading the inbox + items + save/tag now works on a phone. A stopgap —
  the touch-first **reader layout** (list→detail→note, bottom nav) is phase 1.
- **Design spec:** `docs/design/responsive-reader.md` — the reader-surface arc. The roles model
  (SYNC.md) means narrow screens are `reader` devices, so they get a lean reader surface (not the
  keyboard-first curation workspace), **width-triggered** (DeX/landscape keep the workspace). Scope =
  reader + light capture + a PWA **Web Share Target** (the native complement to the Telegram bot).
  This reconciles the old "no mobile" stance for the reader case.

### Sync — stop the hub re-downloading its own uploads (change-feed echo) — 2026-06-23

- Dropbox's change feed (`files/list_folder/continue`) reports a folder's changes **including the
  app's own API uploads** — so right after the hub pushed N files, the next incremental pull listed
  those same N as "changed" and **re-downloaded them** (a one-cycle echo: wasteful API calls + FS
  writes + a store reload, and the confusing "downloading" on a device that only *owns* the corpus).
- Incremental pull now computes the file's **Dropbox `content_hash`** (`syncDropboxContentHash` —
  SHA-256 of 4 MB blocks, then SHA-256 of the concatenated digests) and **skips any change-feed
  entry whose hash matches the local file** — i.e. our own echo, or anything already byte-identical.
  A genuinely-changed remote file still downloads; a wrong hash only ever fails to skip (harmless
  re-download), never wrongly skips a real change. The `[sync]` console line reports `N echoes
  skipped`. Test: `tools/smoke-sync.mjs` (echo entry not re-fetched; hash verified vs node crypto).

### Sync — role sticks on connect + stop re-scanning the FS every idle cycle — 2026-06-23

- **Role no longer resets to `hub` after connecting.** `sync_role` was only persisted in the
  full settings-save, but connecting Dropbox does a PKCE redirect (page reload) that discarded an
  unsaved role pick → a tablet set to `reader` came back as `hub`. The role select (and the
  auto-sync checkbox) now **persist immediately on change**, surviving the OAuth redirect.
- **Auto-sync skips the full local FS re-scan when nothing changed.** Push walked + statted the
  whole tree (~1.5k files) every 120 s even when idle — an FS hammer (AV smell / poor citizen).
  Now the store keeps a monotonic mutation counter (`_mutations`, bumped by `flush` for corpus
  writes and by `store.touchSync()` on note writes, which bypass flush), and `syncShouldScan`
  skips the scan when the counter is unchanged since the last push. A **forced full scan every
  10th cycle** is the safety net, so correctness never depends on complete counter coverage; a
  manual "sync now" always forces. Tests: `tools/smoke-sync.mjs`, `tools/smoke-stacks.mjs`.
- **Clearer sync status labels.** Progress now names distinct phases — `checking for local
  changes…` / `checking the cloud folder…` / `uploading N/M…` / **`first sync — downloading N/M
  (one-time)…`** (the bootstrap) / `downloading N updates…` (routine incremental) — so a first-time
  bootstrap download reads as the one-time event it is, not an alarming "downloading everything."
- **Sync activity readout — direction + what kind.** push/pull now report the paths they moved;
  when settled, the sync line shows e.g. `last: ↑3 (items 2, catalog 1)  ·  ↓2 (notes 2)`, and a
  `[sync] ↑ … ↓ …` console line carries the full path samples. So you can see *what* synced and
  *which way* — not just a bare count (the flight-deck principle). `syncSummarize` buckets paths by
  kind (items/content/catalog/vocab/notes/feeds/archive). Test: `tools/smoke-sync.mjs`.

### Dropbox sync — survive the write rate-limit on a big first push — 2026-06-23

- The first full push of a large corpus (~1.5k files) tripped Dropbox's
  `too_many_write_operations` (429): `syncRetry` did only 3 quick tries (max 2.4 s) and
  ignored the throttle, so the run aborted partway. (It resumed next run via the checkpointed
  manifest, but never completed in one go — so a fresh reader device had nothing to pull.)
  Now `syncRetry` is **rate-limit-aware**: a Dropbox throttle backs off **seconds, escalating**
  (4→8→16→32→60 s, 6 tries) so a run rides it out instead of dying; transient errors keep the
  quick sub-second ramp. And the **push runs 4-wide, not 8** (`PUSH_CONCURRENCY` — writes are
  what Dropbox throttles; reads/pull stay wider). Combined with the existing resume, the first
  push now completes (turn on hub auto-sync to grind it through unattended).
- Deferred (proper fix, upstream `@gcu/vfs` `DropboxBackend` → re-vendor): surface the 429 +
  honor the exact `Retry-After` (now swallowed into a generic EIO), and **batch uploads**
  (`upload_session/finish_batch`) so 1.5k files commit in far fewer write ops. Test:
  `tools/smoke-sync.mjs`.
- **Auto-sync is responsive after a reload:** the background runner gained an opt-in
  `firstDelayMs` (one-shot lead-in), and the sync loop uses **10 s** — so after a reload it
  syncs ~10 s in instead of waiting a full 120 s interval (then the interval carries it; the
  lead-in fires once, not on every flight-deck driver switch). Test: `tools/smoke-runner.mjs`.

### Connection resilience — honest "bridge offline" status + channel reset — 2026-06-23

- After weir OOM'd, its `numen` bridge process died and `bridge.live` went stale, but weir
  sat at **"connecting" forever** — no signal that the bridge was actually down. Now weir reads
  each fs channel's `bridge.live` `ts` via its folder handle and, when the heartbeat is
  stale/absent (> 90 s, mirroring the fs-channel's `LIVENESS_MS`), shows **"bridge down — last
  seen 24h ago; restart it"** (and a `mcp off` footer chip) instead of optimistic "connecting".
  It re-checks while dialing so the status flips once past the staleness window and recovers
  when the bridge returns.
- **"reset" button** per fs channel (Settings → connections): prunes the dead bridge's transport
  scratch — a stale `bridge.live` + orphan `sessions/` dirs — via the folder handle, then re-dials.
  Touches only the exchange folder's transport files, never the data store; can't restart the
  bridge process itself (external). `app._bridgeLiveness` / `resetWebmcpChannel`.
- The deeper fix **shipped in `@gcu/numen` + re-vendored**: the fs-channel now emits a distinct
  **`offline`** state when `bridge.live` is stale (> `LIVENESS_MS`) instead of collapsing it into
  `connecting`, and the shim surfaces it per channel (auto-recovers to `open` when the bridge
  heartbeats again). Every consumer (weir, Auditable, …) gets the honest state without
  duplicating the heartbeat read; weir can later drop its own `bridge.live` poll and just render
  the channel state. (numen test: `tools/smoke-fs-offline.mjs`. Deferred there: deleting
  `bridge.live` on the bridge's *clean* exit — low value, since a crash can't, and the staleness
  check already covers that.)

### `recatalog` safe-by-default — preserves authored cards — 2026-06-22

- **`uncatalogScope`/`recatalog` now PRESERVE hand-authored / human-reviewed cards** (any card
  with a `reviewer` stamp) — only regenerable cataloger cards are discarded + redone. So a
  `recatalog` over a scope of authored **book holdings** (metadata-only — the cataloger abstains,
  nothing to regenerate them) can no longer silently destroy authored curation. Pass
  **`includeAuthored:true`** to opt into redoing authored cards (e.g. when body text has since
  arrived and the body-fed cards beat the hand facets). `recatalog` reports `preserved` (count
  kept). Greenlit by Arthur after the librarian lost 12 authored cards to the old behavior —
  upholds never-delete + decides-vs-proposes. Test: `tools/smoke-glass.mjs`.

### Doc/wording fix: `recatalog` discards authored cards — 2026-06-22

- Corrected guidance (caught by the librarian on deploy): `weir_catalogControl recatalog`
  **discards the whole scope's cards first, including hand-authored / human-reviewed ones**
  (`uncatalogScope` → `cleared: N`). Earlier docs claimed it "keeps hand-authored cards" — wrong.
  Sharpened the `recatalog` tool description with the ⚠ (don't recatalog a scope of authored
  metadata-only holdings — the cataloger abstains on thin metadata, so you'd lose the authored
  cards) and fixed `docs/design/repos-as-source.md`. Footgun (silently clearing authored cards)
  noted for a possible future safeguard. No behavior change.

### Re-vendor @gcu/librarian — engine-level retrieval-precision fixes — 2026-06-22

- **`vendor/librarian.js` re-vendored** from `auditable@e9bb47b` with the two engine fixes
  routed upstream from the librarian's eval: **diacritic-fold tokenization** (`geoestatística`
  → `geoestatistica`, so accented Latin tokenizes whole and matches its unaccented form, both
  in the index and queries) and **fuzzy-match gating** (short query terms get no fuzzy; fuzzy
  hits down-weighted 0.5@d1 / 0.2@d2 so a false-friend like `soldagem` can't outrank a literal
  `sondagem` match). The tokenizer change alters token shapes → a reindex; weir's search index
  is in-memory (rebuilt at startup from items), so a deploy + reload reindexes automatically.
- **`tools/sync-vendor.mjs` hardened** for the new bundle: it now neutralizes the bundle's
  `// ── file.js ──` section markers (they were masquerading as weir's build chunk markers and
  defeating the duplicate-decl guard's vendored-skip → a false `STOPWORDS` collision), and the
  export strip handles multiline / trailing-comma / multi-symbol `export { … }` (the wrap was
  leaving an inner `export` → invalid standalone ESM, breaking node imports). PROVENANCE updated.

### Retrieval/ingest follow-ups from the librarian's eval — 2026-06-22

- **Unicode-aware query tokenization** (`weir_search`): the query splitter was `[^a-z0-9]`,
  which split an accented term at the accent (`geoestatística` → `geoestat` + `stica`) so it
  never reached vocab expansion — breaking the pt-BR→EN synonym bridge for accented terms while
  ASCII ones (`krigagem`) worked. Now splits on `\p{L}\p{N}` (NFC-normalized), and
  `store.expandTerms` normalizes the synonym ring to NFC too, so accented terms stay whole and
  bridge (the EVAL2 asymmetry).
- **`weir_ingestRepo` reports `bodyless` docs**: a doc handed in with no `markdown` (metadata
  only) is now flagged in the result instead of stored silently empty — empty-body docs can't be
  cataloged (no text to read), which is what left 60 repo docs as `skipped:thin-metadata` (the
  bodies were never ingested). The cure is re-ingesting with `paths:` (mounted) — stable ids
  update the items in place, populating bodies — then `recatalog`.
- **FIX: `paths:` mount read returned empty bytes for every file.** `app.readRepoDoc` fed the
  string from `vfs.readFile` (no encoding → `file.text()`) into `new Uint8Array(str)`, which is
  length 0 → every mounted doc decoded to `""` → `bodyless`. The read logic is now a pure,
  node-tested `readMountedDoc(vfs, repoDir, path)` (reads as UTF-8 text). Plus `bodylessReason`
  (`not-found | read-error | empty | no-path`) in the result so a failed read self-diagnoses.
  This is what was actually blocking the whole repos-as-source content layer.

### Retrieval tuning — curation-aware ranking in weir_search (cheap, pre-embeddings) — 2026-06-22

From the librarian's repo-ingest pilot (a broad query swamped by the feed firehose):
- **`weir_search` is curation-aware by default** — a no-ML post-hoc rerank of the lexical
  top-k (pool ≈5× the limit → rescore → slice) by `curationTier × facet-match`: the curated
  minority (books, notes, repo `doc` items, saved links; the `stacks`/`saved`/`books`/`repo:*`
  sources) ×2.5, the feed/video firehose ×0.6, plus a bonus when query terms hit an item's
  facet terms (pulls the `entity:"itabirite"`-not-in-title recall into ranking). Each hit
  carries its `tier` (inspectable). `rerank:false` = raw BM25; `curated:true` = hard-scope to
  the curated tier. Reranks the **MCP reference-desk search only** (not the in-app path).
  Recency deliberately omitted (a reference corpus keeps its canonical old sources).
- **Per-call weight tuning:** `weir_search` accepts an ephemeral `weights:{curated,neutral,
  firehose,facet}` override (clamped 0–10) + `explain:true` (raw `lex` score + weights used per
  hit), so the librarian can sweep against the eval queries live in one session and report the
  winning set to bake as the default — the default itself stays a commit-reviewed constant (an
  agent-writes-the-default tool is deliberately not offered; that's policy/decides-vs-proposes).
- **Vocab-synonym query expansion** (`weir_search` `expand`, default on) — from the
  librarian's eval (cheap tier validated; this was the one cheap next-knob it found). A query
  term that is a controlled-vocabulary prefLabel/altLabel is expanded with its concept's
  synonym ring (prefLabel + altLabels, any facet) before BM25, so the seeded cross-lingual
  pairs (kriging↔krigagem) bridge **lexically** — much of the EN↔pt-BR win with no embeddings,
  and the vocab-seeding finally shows up in retrieval. Ring only (no broader/narrower), capped,
  `expanded:{term→[syns]}` surfaced, `expand:false` for the literal query. `store.expandTerms`.
- **Saved-Links softer tier** (EVAL3 #2): Saved Links rank in their own `saved` tier (×1.4) —
  above the feed firehose, below authored/owned content (books/notes/repo docs ×2.5) — so
  commerce bookmarks stop riding the full curated boost and topping reference queries. The
  `curated:true` scope still includes them; only the weight drops. (Two engine-level findings
  from the same eval — fuzzy `sondagem`≈`soldagem` collision, accented-Latin tokenizer split —
  are `@gcu/librarian`/auditable matters, routed to the librarian, not weir-local.)
- Tests: `tools/smoke-rerank.mjs`. Deferred (ROADMAP + design record): #3 graph-expansion
  retrieval and the dense multilingual lane (now only the residual untranslated-paraphrase gap).
  Record: `docs/design/retrieval-tuning.md`.

### weir_listMine — the agent's footprint as a provenance lens — 2026-06-22

- **`weir_listMine`** (GLASS §17.2) — every contribution stamped by an agent identity,
  across kinds (tag · note · edge · feed · book · catalog), with per-kind ratification
  `status` (pending|ratified|applied|authored|dismissed) + counts. Defaults to the calling
  channel; `identity:"*"` = any agent (cross-channel view); `kinds`/`status` filters. The
  unified self-audit / propose-vs-ratify lens that pairs with `weir_reviewQueue` (the pending
  tray). **Current-state, not an audit log** — undone/corrected contributions aren't shown
  (weir's stamps are attribution; the undo paths erase them), so it's the ground truth the
  agent reconciles its *memory* against. An append-only contribution log is a deferred
  upgrade (ROADMAP + `docs/design/librarian-provenance-view.md`).
- **Note-identity stamp** (prerequisite) — agent-authored notes now carry the identity (`by`
  in frontmatter + `item.added_by`, surviving a rescan), not just `source:'agent'`, so notes
  are attributable in `weir_listMine`. Human (UI) notes stay unattributed.
- Tests: `tools/smoke-listmine.mjs`. With this, the session's `spec_inbox/` is clear.

### Repos-as-source pilot fixes — path ingest kills the verbatim conduit — 2026-06-22

From the librarian's first live `weir_ingestRepo` (BMA):
- **`weir_ingestRepo` gains `paths:[…]`** — the agent names changed files; weir reads each
  from a **read-only FSA mount** of the repos parent folder (mount it in Settings → Courier),
  so a doc's full text no longer travels through the tool call. weir reads **only the named
  files** (`..` traversal blocked, ≤1 MB, UTF-8), never walks the tree, and can't write
  (read-only grant). Inline `docs:[{markdown}]` still works (gitignored/unmounted case) and
  mixes with `paths`. `skipped[]` reports unreadable paths; an unmounted `paths:` call errors
  clearly. (`fsmount` gained a read-only `mode`; `app.reposVfs`/`readRepoDoc` + boot reconnect.)
- **Refresh can fix the pending proposal** — `rationale` (+ name/category) now updatable on a
  later `weir_ingestRepo`, not just at creation.
- **Rationale clamped** (≤500 ch) at the MCP boundary (`ingestRepo`/`addFeed`/`relate`/
  `addBook`) — a malformed oversized blob can't wall the review queue.
- **Repo docs get `form:'doc'`** (was `'article'`) — `weir_queryCatalog({facets:{form:['doc']}})`
  scopes to project documentation.
- **Repo proposals self-summarize** in `weir_reviewQueue` — `{repo, docs:N, anchor}`.
- Tests: extended `tools/smoke-repos.mjs`. Record: `docs/design/repos-as-source.md` (Pilot fixes).

### Citation export — weir_cite, the grounded-writing primitive — 2026-06-22

- **`weir_cite`** (GLASS §17.1) — the companion to `weir_quote` (quote *verifies* a span;
  cite *renders* the reference). One item or a batch → every form: `inline`, a `reference`
  line with a durable weir handle (survives a dead URL), a markdown `footnote`, a
  `[[handle]]` wikilink (a **live graph backlink** once written into a stacks note), and
  `csl` (CSL-JSON). **Verify-in:** with a `quote` it folds `weir_quote` in and returns
  `cited:false` with *no reference* if the quote isn't in the source — a fabricated claim
  can't get a citation. **Batch:** stable BibTeX-style cite-keys (disambiguated) + an
  assembled `bibliography` (footnotes default; `numbered`/`plain`). Reports `missing`
  fields, never fabricates. Pure deterministic module `src/js/cite.js` (zero-dep, no
  network).
- `store.wikiLinksOf` now resolves a `[[ref]]` by glass_id + item id too (not just
  uid/title/basename), so a cited `[[handle]]` is a live backlink for any item — "cite =
  relate" across the whole corpus, not just notes.
- Tests: `tools/smoke-cite.mjs`. Full record: `docs/design/citation-export.md`.

### Repos as a first-class source — the GCU constellation as a queryable subgraph — 2026-06-22

- **`weir_ingestRepo`** (GLASS §17.6). A code repo's own docs (README / SPEC / `docs/**`
  / `CLAUDE.md` — **docs, not code**) ingest as a synthetic, non-polled source
  (`adapter:'repo'`, like `stacks`/`saved`), so `weir_search` hits a repo's actual docs
  *and* the librarian's dive-map, related. **weir never reads the repo or runs git** —
  the agent (with the files + git) hands docs in with a commit `anchor`; weir stores them
  as `doc` items (stable id `repo:<slug>:<pathhash>`, idempotent via `upsertItems`, never
  resets state). First call creates the source as a ratifiable proposal; `kind:'repo'` is
  the provenance flag ("the project's words" — no new `source` tier). **Refresh = the
  dive-ledger, agent-side:** read the stored anchor (`weir_listSources` surfaces it), `git
  diff <anchor> HEAD` locally, re-ingest the delta (`removed` paths archived, never
  deleted). The dive-map stays a stacks note related into the doc-items (`source:agent`).
- New **`doc`** item type (`ITEM_TYPES` + retention-forever + UI pill/accent). Health
  computation now skips never-polled synthetic sources (no fetch-health noise on
  repo/stacks/saved/books).
- This rewrites the librarian's `SPEC-repos-as-source` framing ("bridge reads the repo,
  `weir_repoll` diffs") to the correct side of the browser boundary ("agent diffs,
  `weir_ingestRepo` stores"). Tests: `tools/smoke-repos.mjs`. Full record:
  `docs/design/repos-as-source.md`. Built on stacks-first-class (notes-as-graph-citizens).

### Stacks as first-class corpus — notes in the knowledge graph + partial edit — 2026-06-22

- **Notes are graph citizens** (GLASS §17.5, STACKS §6). `weir_relate` /
  `weir_relatedTo` now accept a stacks **path** or note id on either end. Relating an
  *uncataloged* note auto-mints a deterministic Stage-0 **stub card**
  (`store.ensureCard`, marked `glass.via:'relate'`, no LLM call) so it can host edges —
  the whole edges-on-cards pipeline (proposals, review queue, ratify) works unchanged,
  and a later full catalog reuses that card's `glass_id`, so edges never orphan.
- **Soft wiki-link layer.** `weir_relatedTo` returns a `wikilinks` block alongside the
  ratified graph: the note's `[[name]]`/`[[uid]]` cross-references resolved to items (by
  uid → title → basename) + inbound wiki-backlinks + W3C-annotation links
  (`store.wikiLinksOf`). Unresolved refs stay dangling markers, not errors. Turns the
  librarian's prose cross-references into a navigable graph for free. `weir_relatedTo`
  no longer throws on an uncataloged/unknown ref (returns an empty graph + a note).
- **`weir_stacksEdit`** — partial edit: exact-string `find`/`replace` (unique unless
  `replaceAll`) or `append` a trailing block, mirroring the agent `Edit` ergonomics, so
  a one-line change no longer rewrites the whole note. Explicit not-found / not-unique
  errors; identity (uid/created) and `source:agent` stamp preserved.
- **Foldering signal.** `weir_stacksWrite` reports its destination — a bare write (no
  folder) is flagged `routedToInbox:true` with a note, so the `inbox/` default is never
  silent. (Notes were already searchable via `weir_search` and quotable/citable via
  `weir_quote` — those needed nothing.)
- Tests: `tools/smoke-stacks-graph.mjs`. Full record:
  `docs/design/stacks-first-class.md`. Graduated from the librarian's
  `SPEC-stacks-first-class` (prerequisite for the still-staged `SPEC-repos-as-source`).

### Glass: the webmcp agent surface — reference desk, provenance & a unified review queue — 2026-06-21

- **Reference desk (read).** Two new read-only retrieval tools complete the
  grounded-reference surface (GLASS §17.1): **`weir_queryCatalog`** — a faceted
  *intersection* query (union within a facet, intersect across facets) with
  controlled-vocabulary resolution and fail-loud `vocabularyNotes`; finds what
  excerpt search can't (e.g. `entity:"itabirite"` when the word isn't in a title).
  **`weir_quote`** — citation verification: confirm a quote is in a source, return a
  stable `glass_id#start–end` locator + context, or report no-match so the agent
  refuses to assert it. (The other reference verbs — `weir_search`, `weir_vocab`,
  `weir_relatedTo` — already shipped.)
- **Provenance taxonomy** (GLASS §17.2). Authorship unified to a three-tier `source`:
  `human` (the UI), `cataloger` (weir's internal LLM-as-service, on the card as
  `glass.cataloger = provider:model`), and `agent` (an external agent over MCP). Every
  agent write now stamps `source:'agent'` + an **identity** (`by`): tags → `tag_by`,
  edges → `by`, feeds → `source`/`added_by`, book holdings → `added_by` (new holdings
  only). Fixes the old split where the agent was labelled `'llm'` (tags) and `'claude'`
  (edges/notes) inconsistently while feed/book adds carried no marker at all.
  **`weir_provenanceMigrate`** rewrites legacy stamps → `agent` (idempotent).
- **Unified review queue** (GLASS §17.3, decides-vs-proposes §2.1). `weir_reviewQueue`
  is now ONE tray tagged by `kind` — `catalog` (cataloger low-confidence cards), `feed`
  (an agent-added feed), `relation` (an agent-proposed edge) — each carrying the
  proposer identity + a `ratifyWith` pointer. New **`weir_ratify`** blesses (→ marked
  `ratified_at`, leaves the queue) or dismisses (undo) a structural proposal; catalog
  cards keep confirming via `weir_reviewItem`.
- **`weir-desk`** — a sibling repo: a librarian + reference-desk agent (Claude Code)
  that drives the running weir over MCP and never touches its source. Full design
  records: `docs/design/reference-desk.md`, `docs/design/librarian.md`.

### webmcp/numen: fs multichannel — two agents on one weir at once — 2026-06-21

- The `fs` transport now serves **more than one bridge per page** (numen 0.1.3): one
  `FsChannel` per folder, all sharing the page's tool registry, so the **dev** agent
  (this repo) and the **librarian** (`weir-desk`) connect to one running weir at the
  same time. The bridge and wire protocol are unchanged — the change is purely
  page-side (`shim.js`: `addFolder` / `removeFolder` / `channels`). It makes
  **folder = identity** literal: the calling channel's identity rides into
  `tool.execute(input, client)` as `client.identity` — the carrier the provenance work
  consumes. weir Settings gains a second "dev folder" channel + a per-channel status
  line; boot reconnects every persisted channel. See `../numen/docs/multichannel.md`
  (TRANSPORTS §6.5); proven by `numen/tools/smoke-fs-multichannel.mjs`.

### Glass: a full call-number classification + the physical home library — 2026-06-20

- The glass **call number** grew from a loose facet projection into a complete
  **shelf address**: a curated **0–9 / 2-digit main·division class**
  (`CLASS_NAMES` / `classOf` in `callnumber.js`) now *leads*
  `class · domain · sub · form · cutter · [series·vol | year]` and the sort key, so the
  shelf wanders by discipline instead of scattering alphabetically by code. It's
  glass-native — the universal main-class *pattern*, **not** Dewey's (OCLC's) schedules.
  Curated codes where the derivation read badly (`manga→MGA`, `comics→CMX`,
  mineralogy/petrology/paleontology/geomorphology → `36` earth sciences). The eventual
  "right" home for the hierarchy is the SKOS vocab's `broader`-terms; the map is the
  pragmatic stand-in (noted in-code).
- **Series stay together.** `series` + `seq` on a book's `structured` keep a set
  contiguous and in volume order — **decimal-safe**, so a manga `1.5` sorts between `1`
  and `2` — instead of scattering by per-volume year.
- **`weir_addBook`** MCP tool — add **or update** book holdings (pass `id` to update in
  place). `structured` is **merged**, so a LibraryThing re-import no longer wipes a
  stamped series; `title` is optional on an id-update; carries `series`/`seq`/`shelved`.
- **Physical-shelf status** (`structured.shelved`) with a round-trip: the shelf-list
  export's "shelved" JSON ↔ `weir_addBook(shelved)`, so ticks survive across devices
  and regens (catalog = source of truth, not just localStorage).
- **Physical-library tooling** (`tools/`): `shelf-list.mjs` + shared
  `src/js/shelflist.js` (mobile shelf list — call-number order, per-class sections,
  tap-to-shelve checkboxes, JSON export/import) and an in-app **Export shelf list**
  (command palette + catalog facets toolbar). `shelf-labels.mjs` emits a printable
  pt-BR **ALL-CAPS Brother-label** list + a `label-placement.html` phone guide (with a
  `minBooks` threshold so tiny sections skip a divider). `shelf-label-holder.scad` is a
  parametric clip-on 3D-printed label holder. Generated `.txt`/`.html` outputs are gitignored.
- Arthur's home library — **147 books, hand-faceted** into the scheme (the LLM cataloger
  seeds, a human ratifies via `weir_reviewItem`), 136 marked shelved.

### Build: guard the two blank-screen classes — 2026-06-20

- `build.js` now **`node --check`s the whole emitted bundle** — catching a syntax error
  in *any* module (incl. `app.js`, which `npm run smoke` doesn't import) — and **rejects
  a literal `</script>`** in the inlined JS (which closes weir's single inline `<script>`
  early and orphans the rest → "Unexpected end of input", blank app). Both classes shipped
  a blank app this session before the guards: a raw `</script>` in the shelf-list HTML
  template, and an apostrophe ending a single-quoted tool-description string. Modules that
  emit HTML must escape the close tag as `<\/script>`.

### Health: "Retry flagged" — recover failing feeds after an outage — 2026-06-02

- The feed-health panel gets a **"↻ Retry flagged"** button that re-polls every
  flagged (failing / stale / suspect) feed **right now**. After a transient outage
  (e.g. the bridge cache wedging → *every* fetch failing), feeds otherwise recover
  only slowly — adaptive polling **backs failing feeds off** to long intervals. One
  click re-polls them (a successful poll resets the feed to `healthy`) and the panel
  re-renders to show the count melt away, instead of waiting out the backoff.

### PWA: "check now" is honest about an uncontrolled tab — 2026-06-02

- "Check for updates" keyed entirely off `navigator.serviceWorker.controller`,
  which is **null whenever the tab isn't currently controlled** — a *normal* state
  for an installed PWA (cold start, or the browser evicting the idle worker). So it
  wrongly reported **"no service worker (serve over https / install)"** for a
  perfectly-installed PWA. Now `checkForUpdateNow` inspects the *registration*
  directly (+ calls `reg.update()`) and reports the real state: `unsupported` /
  `none` / `waiting` (reload to apply) / `uncontrolled` / `checked`. Crucially, an
  **uncontrolled tab loaded fresh from the network, so it's already on the latest**
  — the message now says exactly that (reload only re-attaches the worker for
  offline + auto-update toasts), instead of implying the SW is missing.

### Resolver: keeps dripping in the flight-deck (backgrounded runs) — 2026-06-02

- The flight-deck already kept the **catalog + poller** alive while the tab is
  backgrounded; the saved-link **resolver** now rides the same always-visible,
  un-throttled PiP timer (`linkResolver.setKeepAlive`). So with the deck popped out,
  resolving/enriching **keeps going while you use other apps** — not just while
  weir is the focused tab. Without the deck it still pauses when hidden (the gentle
  default), and the `_busy` guard keeps the two timers from double-ticking.

### Resolver: a persistent run log (so an overnight drip is reviewable) — 2026-06-02

- The link resolver now keeps a **persistent, classified run log**
  (`/resolver-log.json`, survives reloads): **resolved** / **parked** counts,
  **failure reasons** tallied (`http-429` = share.google throttling, `no-redirect`,
  `network`), and the **recent parked links** (host + reason). So an unattended
  overnight run actually teaches us something — whether links resolved, got
  throttled, or are dead — instead of vanishing with the in-memory misses.
- `enrichOne` now returns a **classified result** (`{ ok, reason, … }`); the
  per-item "Fetch link metadata" shows the reason on failure, and **`weir_resolverLog`**
  (WebMCP) reads the whole tally so it can be reviewed from a Claude session. The
  log saves are throttled (~once/30s, forced on stop) so an all-night FSAA run
  isn't a write every tick.
- **Status-bar indicator** (`⧉ 1140✓ 60⊘ · 200…`) — resolved / parked / pending at
  a glance, **hover** for the failure-reason breakdown + recent parked links,
  **click** to jump to Saved Links. So you can just *look* in the morning instead
  of querying.

### Storage: catalog cards packed into shards (was one file per card) — 2026-06-02

- Catalog cards were **one `/catalog/glass-*.json` file per item** (~3,500+). On
  IDB invisible; on **FSAA it's death-by-papercuts** — the folder copy + every op
  paid per-file overhead, and `writeCard` did a **full-directory `readdir` for the
  seq counter on *every* card written.** Now cards live in an **in-memory index
  persisted as ~256 bucketed shards** (`cards-XX.ndjson`, hashed `glass_id`), the
  same dirty-flush model as feed items.
- **Wins:** the FSA copy / hydration / every backend op now touch **dozens of files,
  not thousands**; `writeCard` is in-memory + debounced (no per-card file write or
  dir scan); the glass-id sequence is in-memory + synchronous (**collision-safe even
  under concurrent cataloging** — clears that prerequisite for free).
- **Migration is automatic + safe:** existing per-file cards convert to shards on
  first load — **non-destructive + idempotent** (shards written *before* the legacy
  files are removed, so an interruption just re-runs). Tests: `smoke-cards`
  (sharded persistence round-trip, post-reload seq continuity, review persistence,
  legacy migration + idempotency) + headless (app facet-loading on sharded cards).

### Saved links: stash the article body during resolve (full-content catalog + inline read) — 2026-06-02

- The resolver already fetched each link's page (to find its URL + OpenGraph) and
  then **threw the body away**. Now it **extracts + stores the article text from
  that same response** (the readability extractor, injected) — *no second fetch*.
- Net: one fetch per saved link now yields **real URL + thumbnail + title +
  excerpt + full readable content + a rich catalog**. The cataloger picks the
  stored content up automatically (capped at `maxBodyChars`), and the link reads
  **inline** (expand-in-place) like a feed article. Images stay suppressed by
  default (per policy; "load images" still works per-item).
- Roadmapped: **compress stored content** (native `CompressionStream`, ~3–5×) at
  the VFS layer, since stashing bodies makes content the biggest space user.

### Cataloger: defer un-enriched saved links from the batch — 2026-06-01

- The catalog batch (`catalogVisible` / `catalogAll` / the WebMCP start) now
  **skips saved links the resolver hasn't fetched yet** — otherwise a still-wrapped
  `share.google` link would catalog from its placeholder title into facets that
  then *stick* (a `glass_id` is set, so it won't auto-recatalog once it resolves).
  A later run sweeps them up as the drip marks them `enriched`; the status reports
  how many are deferred. The per-item "Catalog with AI" / `weir_catalogItem` is
  unaffected (an explicit choice).

### Saved-link import: skip Holocene-internal hosts + one-click cleanup — 2026-06-01

- **`holo.stdgeo.com`** (Holocene's Cloudflare-tunnel remote-access host) joins the
  import skip list — those links are "view in Holocene" / magic-login pointers, not
  real content.
- **"⌦ Remove non-content links"** on the Saved Links source menu prunes any
  skipped-host links (holo.stdgeo.com / archive.org / telegram) that slipped in
  before — `prune()` tombstones them so a re-import can't resurface them; starred
  items are exempt. So you don't have to remove + re-import to clean up.

### Saved-link import: your messages only + batch direct-enrich — 2026-06-01

- **Telegram import takes links from *you* only** — the bot is identified by the
  **chat name** (in a bot/DM chat `json.name` *is* the counterparty, e.g.
  "Holocene", and equals the `from` on its messages), so the bot's "Link Added"
  confirmations are excluded even though they echo the real url (which defeats
  counting links per sender — that's now just a fallback for nameless exports).
- **"Remove non-content links"** also prunes already-imported **bot confirmations**
  (title contains "Link ID:" / "Link Added") — junk-titled dups of your own saved
  links, which keep their proper version (and resolve normally).
- **The resolver drip now enriches *all* saved links, not just wrapped ones** — so
  direct links get thumbnails too. Each link is marked `enriched` after a
  successful fetch (persisted), making it a **one-time pass that survives reloads**
  (never re-fetches a page). Wrappers resolve first (same-host → throttle-prone);
  direct links spread across many hosts. Stays gentle (~2 every 15s, idle when
  hidden).

### Saved links: a built-in "Links" view — 2026-06-01

- New built-in **Links** view in the Views list (below Articles) = your
  captured/saved links (the `saved` source now; Telegram/glean captures later).
  It's a **view, not a type** — a saved article still shows in Articles too, and
  still catalogs as an article. Hidden until you have saved links. Existing installs
  get it via a one-time migration that **respects deletion** (delete it and it
  stays gone).

### Saved links: resolve + enrich (thumbnails, titles, excerpts) + manual triggers — 2026-06-01

- The background resolver now does **both jobs from the one page fetch** it already
  makes: follows the redirect to the real URL **and** parses OpenGraph —
  **`og:image` → thumbnail**, **`og:title` → upgrades a weak (hostname) title**,
  **`og:description` → excerpt**. Saved links become real thumbnail cards instead
  of bare URLs (a meaningful message title like "… | Hackaday" is preserved).
- **Manual triggers — something to click** (for you and for Claude): **"⧉ Resolve
  links now"** on the Saved Links source menu, **"⧉ Fetch link metadata"** on a
  saved item's menu (works on any link — gives a direct link its thumbnail too),
  and **`weir_resolveLinks`** over WebMCP.
- The full-smoke runner now also includes `smoke-import` + `smoke-linkresolver`.

### Saved links: never auto-archive + background resolver drip + marker — 2026-06-01

- **Fix (data wasn't lost — auto-archived):** imported saved links carry their
  *original* publish dates (often months old), so retention treated them as
  expired and archived them the moment they landed → "Saved Links: 0 items" while
  they sat in Archived. The **Saved Links source now never expires** (forever
  retention) — a deliberately-saved link must not auto-archive on age.
- Import now **stores + flushes immediately** (no blocking inline unwrap), so an
  import can't be lost to a refresh.
- New **LinkResolver** — a gentle background drip (≈2 links / 15s, idle when
  hidden, cache-busted) that resolves share.google/shortener links to their real
  URL *over time*, dodging the burst rate-limit a one-shot import hits. Updates the
  url in place (id is hashed from the original, so identity never changes). No more
  re-import dance — import, walk away, links resolve themselves.
- **"⧉ unresolved" marker** on items still pointing at a wrapper; it disappears as
  the drip resolves each one.

### WebMCP: navigate sources — feed filter + `weir_listSources` — 2026-06-01

- `weir_queryItems` gains **`feed`** (a source by id *or* display name, e.g.
  "Saved Links") and **`category`** (folder) filters — list a whole source
  reliably instead of fighting substring `q` search.
- New **`weir_listSources`** — the source tree (feeds grouped by folder, each with
  its inbox count) so an agent can see what exists before drilling in. Makes
  driving weir from Claude Code actually navigable.

### Sources rail: filter box + collapse/expand-all — 2026-06-01

- **Filter box** in the Sources header — narrow the list by feed name *or* folder
  as you type (matching folders force-expand so hits are always visible). Much
  faster than scrolling/collapsing to find a source in a large list.
- **Collapse-all / Expand-all** buttons (▸ / ▾) in the Sources header, plus the
  same two actions on the folder context menu, the Sources-header right-click, and
  right-clicking empty rail space — no more closing folders one by one.

### Multi-format link import (Holocene/Telegram backlog → weir) — 2026-06-01

- The **Import** button / file drop now **sniffs the file** and routes it
  (`importers.js` → `detectImport`): OPML still imports feeds; **Telegram export
  JSON**, a plain **URL list**, and **JSON link arrays** import as *saved links*.
- Saved links land under a new non-pollable **Saved Links** source, ready for the
  cataloger like any item (`App.importLinks`; a far-future `next_poll_at` keeps the
  poller from ever touching it — no feed URL to fetch).
- **Share-sheet / shortener URLs are resolved** (share.google / search.app /
  bit.ly…) to their real destination via `gcuFetch` (follow redirects →
  `response.url`), **gently paced (2-wide) + retried with backoff** — share.google
  rate-limits bursts, and a transient failure shouldn't strand a link wrapped.
  In-text titles (Google Discover "Title | Source &lt;url&gt;") are kept; YouTube
  links become `video` items.
- IDs hash the **original (as-received) url, not the resolved one**, so a flaky
  unwrap never changes an item's identity: **re-importing is idempotent** — it
  reuses already-resolved links and simply **mops up stragglers**, never resetting
  read/saved. Folds in Holocene's ~1,500-link backlog across two Telegram exports.
  Tests: `tools/smoke-import.mjs` (parsers + store round-trip) + headless
  (retry-through-rate-limit, stable id, idempotent re-import).
- **Bridge fix (vendored):** `gcuFetch`-via-bridge now surfaces the final
  post-redirect `response.url` (was always `''` — a manually-constructed Response
  has no url; the bridge service worker already sent it, the client ignored it).
  This is what makes the unwrap possible — and benefits every redirect-following
  fetch in weir.

### Cataloger: stance/tone facet — 2026-06-01

- New `stance` facet (critical | promotional | explanatory | neutral | opinion) —
  a document's editorial lean, LLM-filled, browsable/queryable like any facet.

### Cataloger config + drive it from Claude Code — 2026-06-01

- New cataloger knobs (Settings → AI cataloger): **pace** (ms between calls — 400
  keeps a local NPU responsive; drop toward 0 for a cloud provider) and **max body
  chars** (how much of each doc is sent — cost/context).
- **WebMCP control:** `weir_listModels` (list the provider's available models) and
  `weir_setCatalog` (set provider / model / baseUrl / pace / maxBodyChars). The API
  **key is deliberately excluded** — it stays your UI paste into the OPFS vault.
  Changes take effect on the next cataloged item, so a running batch picks them up.
  Lets Claude pick a model and tune the cataloger from a session.

### Search v2 — ranked full-text on @gcu/librarian — 2026-06-01

- Vendored **@gcu/librarian v2** (the unified typed-array CSR engine, built *for*
  weir) and replaced the v0.1 cursor-scan with **ranked BM25F + fuzzy + prefix**.
  Title matches outrank body hits; typos (`krigging`) and partial terms (`minecr`)
  still land. The search box — and a saved smart-view's text — now returns
  **relevance-ranked** results scoped to the current view, with a graceful
  cursor-scan fallback until the index is built.
- Lean **folded** index (`storeText` off → snippets via a callback, `positions`
  off) so the whole corpus fits cheaply in RAM; rebuilt on a debounce as items
  arrive/change (`src/js/search.js`). Incremental `addDoc`/`removeDoc` +
  `pack`/`unpack` persistence are the scale follow-up (ROADMAP).
- `tools/sync-vendor.mjs` now wraps the librarian bundle in an IIFE so its generic
  internal names (`search`, `index`, `scan`…) don't collide in weir's single-file
  (flat-concat) build — only `Librarian` is exposed.

### Flight-deck: pinnable scope + smoother refresh — 2026-06-01

- The flight-deck can be **pinned to a slice** of the corpus: navigate the main
  view to a folder / saved view / type / feed, then hit **pin** in the deck header
  — it shows just that scope (label in the header, **all** button to reset),
  persisted in `flightdeck_scope`. So you can keep a deck on your fast-moving news
  folders while you work, ignoring the gaming firehose.
- **Smoother refresh:** the deck only rebuilds its list when the item set actually
  changes (preserving scroll instead of snapping to top every tick), and it now
  refreshes after each background **poll cycle** too — so newly-polled items appear
  even when only polling (no catalog running).

### Flight-deck keeps polling alive too — 2026-06-01

- While the flight-deck pop-out is open, weir now keeps **polling** alive, not just
  cataloging — a poll tick runs through the deck's always-visible (un-throttled)
  timer, overriding `pause_polling_when_hidden`. So a backgrounded "leave it
  running" session keeps **ingesting new feed items**, not just chewing the
  catalog backlog. New setting **`poll_in_flightdeck`** (default on; Settings →
  Polling). Caught because the deck's "latest items" froze for an hour while
  backgrounded — cataloging kept going (its pacing already rides the PiP timer)
  but intake had quietly paused. Now both stay live.

### Storage size-report breakdown — 2026-06-01

- **Settings → Storage → breakdown → compute…** shows a per-area byte breakdown
  (content, catalog, items, feeds, views, …), biggest first, via
  `store.storageBreakdown()` — summed from `stat()` metadata (no content reads),
  flushing pending writes first so the numbers are exact. Complements the global
  usage/quota total: shows what's actually eating space, handy right before an
  FSA folder migration.

### Glass: catalog review queue — 2026-06-01

- A **`needs_review` queue** surfaces cards the cataloger flagged low-confidence
  (its LLM output didn't parse) for human confirm/correct — closing the
  *propose → review → correct* loop. A **⚑ N to review** status-bar chip opens an
  overlay listing each flagged item with its facets + **✓ Looks good** /
  **⟳ Re-catalog** / **Open** actions; the item context menu gains **Mark
  reviewed**. `store.markCardReviewed` clears the flag, stamps the human review,
  and can overwrite specific facets.
- **WebMCP:** `weir_reviewQueue` (list flagged items + their facets) and
  `weir_reviewItem` (approve as-is, or correct facets like `{"scale":[]}`) — so
  Claude Code can triage the queue alongside you.

### Unattended catalog runs: wake lock + flight-deck — 2026-06-01

- **Screen Wake Lock** while a catalog batch runs — weir asks the browser to keep
  the display awake (`navigator.wakeLock`), released when the batch ends, re-taken
  on tab-return. No more mouse-jiggler to stop the machine sleeping mid-run.
- **Flight-deck (Document Picture-in-Picture).** A **⮬ deck** topbar button pops
  out an always-on-top mini-window showing catalog progress + the latest items
  (click one to open it). Because a PiP window stays *visible*, its timers aren't
  background-throttled — so while it's open the batch paces through *its* timer,
  and a buried main tab no longer crawls (the overnight throttle that capped the
  first run at ~580). Chromium-only; the keep-alive is best confirmed by watching
  a backgrounded run keep moving.

### WebMCP: drive weir from Claude Code — 2026-05-31

- weir now speaks **WebMCP** (`@gcu/webmcp`): Claude Code can read the corpus over
  localhost. Vendored the shim (`vendor/webmcp-shim.js`, installs
  `navigator.modelContext` + `window.gcuWebMCP`) and added an adapter
  (`src/js/webmcp.js`) registering three **read-only** tools — `weir_queryItems`
  (search/filter), `weir_getItem` (one item + glass facets + optional body text),
  `weir_listFacets` (catalog facets with counts across the corpus). Mutations come
  later, behind confirmation.
- **Transport built for the deployed PWA.** The adapter injects `gcuFetch` into the
  shim, so on a public origin (gentropic.org/weir) the WebMCP traffic rides the
  **@gcu/bridge** extension to reach `localhost` — same path as the Lemonade
  cataloger — sidestepping Chromium's public→loopback (PNA) block on `ws://`.
- **Connect once.** Settings → **Claude (WebMCP)**: paste the `port:token` from
  `node webmcp-bridge.js --app weir --port 7801 --info`, connect, and weir
  remembers it (origin-local, never in backups). A status-bar `mcp` indicator
  shows the connection. `.mcp.json` wires the bridge for the repo (port 7801).

- **Bug fix — cross-contaminated catalog cards.** `buildCard` fabricated a
  default `glass_id` of `glass-YYYYMMDD-001` whenever none was passed, so *every*
  item cataloged with the LLM on a given day collided on the same card file —
  each catalog overwrote the last and items ended up sharing/merging facets (the
  "Jack Daniel's article got the Applied Pokology facets" report). Fixed at the
  root: `buildCard` no longer invents an id; `writeCard` assigns a unique daily
  sequence (`_nextCatalogSeq`) at persist time. Each cataloged item now gets its
  own card. Regression test catalogs two items → distinct ids, no facet bleed.
- **Catalog cleanup.** **Settings → AI cataloger → clear catalog** (and
  `__weir.clearCatalog()`) deletes every card and un-files every item so you can
  re-catalog from a clean slate — items, content, reading state and the archive
  are untouched. Use it once to clear the cards corrupted by the collision above.
- **"Let it rip" safety.** Cataloging the whole corpus is the catalog view with
  no facet filter → **catalog ▸**; that batch now confirms before a long run
  (>30 items) and is cancelable mid-flight (click the button again to stop).
- **Unattended whole-corpus runs.** The batch is now genuinely set-and-forget:
  it throttles the list re-render (every 25 items instead of after each — the old
  per-item refresh was O(N²) and got janky as the catalog filled), **auto-stops
  after 8 consecutive failures** (so it doesn't churn through thousands of
  no-ops when Lemonade or the bridge goes down), and **resumes** where it left
  off — it only ever processes items without a card, so just click **catalog ▸**
  again to continue. Progress shows live in the status line (`N/total · X done`).

### Bridge-down banner — 2026-06-01

- weir now **says it out loud** when the bridge isn't brokering, instead of
  failing quietly into a console full of CORS errors. A warning toast — *"Bridge
  not active — feeds & the AI cataloger can't fetch. Enable @gcu/bridge, then
  reload."* — appears **only when fetches are actually failing AND the bridge
  isn't detected** (so a CORS-friendly setup never sees a false alarm). It clears
  the instant a fetch succeeds and re-arms for the next outage; **Re-check**
  re-probes, **dismiss** silences it for the session. Catches the case where Edge
  silently disables the unpacked extension on restart.

### Glass: catalog Stage 1 foundation — the cataloger service — 2026-06-01

- **LLM provider client** (`llm.js`, adopted from patchbay): OpenAI chat-shape for
  **Lemonade (Ryzen AI — NPU+iGPU)** / Ollama / NanoGPT / Groq / custom, one
  `chat()`; `fetch` injected so calls go through the bridge (dodging CORS).
  JSON-mode is gated per provider (`jsonMode`) so local servers that don't support
  `response_format` don't error — the parser extracts JSON from prose regardless. `fetchUsageGauge()` reads NanoGPT's
  weekly-input-token allowance, **parsed defensively** (the docs disagree on shape).
- **Key vault** (`llmkeys.js`): API keys in OPFS, **deliberately separate** from
  the VFS store — never in `exportAll` backups or the FSA-mounted folder.
- **Cataloger** (`cataloger.js`): the bounded LLM *service* (GLASS.md §6) — item +
  Stage-0 card → enriched card. Fills the language facets (domain/entity/process/
  method/scale/spatial) + abstract, **preserves** the Stage-0 facets (form/
  provenance/temporal) and adds to (never loses) tag-derived entities. Robust JSON
  parse → `needs_review` on failure. `Store.writeCard` persists + stamps the item.
- **Usage ledger** (`Store.recordUsage`/`getUsage`, `/usage.json`): per-provider
  calls + tokens; for NanoGPT the **billed input tokens (×2 on GLM-5.1 /
  DeepSeek-V4-Pro)** — the unit its subscription meters. Surfaced in Settings →
  **AI cataloger** (provider/model/base-url/key + a usage readout + a "check
  allowance" gauge).
- **Catalog UI:** a per-item **"Catalog with AI"** in the item menu, a **batch**
  "catalog ▸" button in the Facets rail (one at a time, paced ~400ms,
  click-to-stop — gentle on the NPU), and a catalog status line. The payoff: the
  **catalog browser now sources enriched facets from the cards**, so the empty
  `domain`/`method`/… facet columns **fill in live** as items get cataloged
  (Stage-0 facets for un-cataloged items, LLM facets once enriched).
- **Model pick-list:** a **↻ list** button in the AI-cataloger settings fetches
  the provider's `/models` (derived from the chat path) and fills a **dropdown**
  of the installed models (+ a "custom id" escape for anything unlisted), so you
  pick instead of typing. (A `<select>`, not a datalist — a datalist filters its
  options to the typed text, which hid the second model.) Next: a `needs_review`
  review queue, and proposed `related` edges.

### Glass: catalog Stage 0 — weir speaks the glass format — 2026-06-01

- **`GLASS.md`** — the `@gcu/glass` spec, rewritten coherent and grounded in weir
  as the home implementation (supersedes the cross-session merge that leaked into
  `SPEC.md §7`). Library-science knowledge base: faceted classification + Dublin
  Core + thesaurus, "dumb pipes / LLM-as-service," cataloging built over weir's
  own store, notes-as-items, an *emergent* knowledge graph, Ollama-first (local,
  zero-egress) cataloger. Staged 0→3.
- **Stage 0 (no LLM):** `src/js/glass.js` `buildCard()` maps metadata weir already
  has onto the glass catalog card — `form←type`, `provenance←feed`,
  `temporal←published_at`, Dublin Core ← item fields, `entity ⊇` tags; the
  language facets (domain/entity/process/method/scale/spatial) + abstract are left
  for the Stage-1 cataloger. `Store.buildCatalog()` emits `/catalog/<glass_id>.json`
  for every item and stamps each item's `glass_id` (idempotent; survives reload;
  if you're FSA-mounted, the cards are real files you can browse). Try it:
  `await __weir.buildCatalog()`.
- **Stage 0 view — the faceted catalog browser.** A **Catalog** entry in the rail
  swaps the Sources list for a **facet browser**: `form` / `provenance` /
  `temporal` / `entity` with live term counts (the empty LLM facets stay hidden
  until Stage 1). Click terms to filter the stream; intersect across facets
  (`form:paper ∩ entity:kriging`) — real LIS facet-intersection, computed live
  from items (`glass.js facetsOf`), instant, always current. This is also the
  first taste of glass's query side (GLASS.md §8). Next: the Stage-1 cataloger.

### Durability: mount weir to a folder (File System Access) — 2026-06-01

- **Settings → Storage → location: mount to a folder…** runs weir's *entire*
  store on a user-picked real directory (File System Access) instead of
  IndexedDB — immune to browser eviction, browsable + syncable with your own
  tools. Pointing at an **existing** weir folder **adopts** it (no overwrite —
  the new-machine / synced-folder case); pointing at an empty one **copies** the
  current data in (IndexedDB kept as a fallback). The directory handle persists
  in a tiny dedicated IDB so weir re-opens the folder on next launch.
- **Bulletproof boot:** if the grant has lapsed or anything goes wrong opening
  the folder, weir **always falls back to IndexedDB** and shows a *reconnect*
  toast (one gesture re-grants permission). "use browser instead…" copies the
  folder's data back to IDB; "forget" just drops the association. Migration
  reuses the proven `exportAll`/`importAll`, and mounting never deletes the IDB
  copy, so a failure can't lose data.
- `src/js/fsmount.js` (handle persistence, picker, permission, adopt-detection);
  `boot.js` selects the backend defensively. Boot-defensiveness + the UI state
  machine are headless-tested; the live picker/migration is verified interactively.

### Durability: full backup + restore — 2026-06-01

- **Settings → Storage → backup: export… / restore…** A full backup snapshots
  *every* file in the store — feeds, item shards, lazy content, tags, views,
  routing, settings, tombstones — into one downloadable JSON
  (`weir-backup-<date>.json`). Restore writes it all back (then prunes anything
  not in the backup, so it's an *exact* snapshot) and reloads. Your safety net
  against the browser evicting IndexedDB on a never-deleted corpus.
- New `Store.exportAll()` / `Store.importAll()` over a recursive VFS walk; writes
  land before any prune, so a failed restore never leaves you with less than you
  had. Verified lossless round-trip in node **and** against real IndexedDB
  (restored into a fresh database → identical corpus). The backup is
  backend-agnostic — a stepping stone to the FSA "mount to a folder" flow.

### GitHub adapter — 2026-06-01

- New `github` adapter over GitHub's native Atom feeds (no API, no auth). Add a
  friendly **`github.com/{owner}/{repo}`** and it resolves — pure string, no
  fetch — to `…/releases.atom` by default (or `…/commits.atom` / `…/tags.atom`
  by path; a bare `github.com/{owner}` → that user/org's activity feed). Releases
  and tags map to **`release`** items, commits to **`commit`** — lighting up item
  types the schema defined but nothing produced yet. Structured fields carry the
  `repo` and the `ref` (tag, or short commit SHA); content is sanitized. Resolves
  + names the feed at add-time (`owner/repo releases`); a `detectFeedUrl` safety
  net handles repo URLs that arrive via OPML. Verified against live
  `nodejs/node` releases.

### Search v2 groundwork — corpus export + vendor pipe — 2026-06-01

- **`__weir.exportCorpus()`** (dev/handoff): dumps one doc per stored item in
  librarian's field shape (`{ id, type, title, author, body }`; body = excerpt or
  the stripped full-article text) and downloads it as JSON. Used to hand a
  real-world corpus to `@gcu/librarian` v2 development. No UI surface — console
  only (`await __weir.exportCorpus()`).
- **`tools/sync-vendor.mjs`** — sync-vendoring pipe from canonical `../auditable`
  (mirrors `gcu-library`'s pattern), per the librarian vendoring contract (never
  hand-edit vendored copies; upstream-first). Verified end-to-end against current
  librarian; the `FILES` row stays commented until **librarian v2** ships, and
  it's not wired into the build yet. See `vendor/PROVENANCE.md`.
- Requirements for the engine handed to the auditable side as
  `auditable/spec_inbox/weir-search-requirements.md` (config flags, incremental +
  pack/unpack + scan API shapes, query patterns, targets, the corpus, acceptance).

### Conditional GETs — skip re-parsing unchanged feeds — 2026-06-01

- The poller now does **conditional GETs**: it stores each feed's `etag` /
  `last_modified` and sends `If-None-Match` / `If-Modified-Since` on the next
  poll (with `cache: 'no-store'` so our validators are authoritative on the
  direct-fetch path). When the feed is **unchanged** — a real `304`, or the
  bridge serving its cache (`x-gcu-bridge-cache: hit|fresh`) — weir **skips the
  whole parse/sanitize/dedup pass**, just advancing health + schedule. Gentler on
  servers *and* on weir. Guarded so a stale bridge "fresh" hit can't mask an
  empty store (only short-circuits when the feed already holds items).
- The status bar now shows a **cache ratio** (`… · N% unchanged`) once enough
  polls have run — flight-deck visibility into the savings.
- No bridge change needed: `@gcu/bridge` already brokers conditional GETs end to
  end (auto-revalidation, `304→200` masking, freshness, the cache-status header).

### Gallery thumbnails from inline content images — 2026-05-31

- The feed adapter now falls back to the **first usable `<img>` in an item's
  content** as its gallery thumbnail when the feed ships no `media:`/enclosure
  image — so the gallery is image-rich for ordinary RSS articles, not just
  videos and well-tagged feeds. Pure parse-time, **zero network**; skips data
  URIs, relative srcs, tracking pixels, avatars, and 1×1 spacers. Explicit media
  thumbnails still win. Existing items pick this up on their next re-poll (which
  refreshes `media`). List view is unchanged (it ignores thumbnails for text
  types). og:image *fetching* for the remaining thumbnail-less articles is still
  deferred.

### Gallery view — 2026-05-31

- A **list ↔ gallery** layout toggle in the topbar (`▦`). Gallery renders the
  stream as a responsive thumbnail grid: video items use their existing
  thumbnails (with play overlay + duration); items without an image get a
  colored type-tile (the monogram trick). Clicking a tile expands it full-width
  into the same inline reader; per-item hover actions and keyboard nav are
  unchanged (tiles are still `.item`, so the click/select/reflect plumbing is
  shared). Persisted as `stream_layout`. og:image fetching for thumbnail-less
  articles is deferred.

### Reorder feeds within a folder — 2026-05-31

- Folder context menu → **Reorder feeds…** opens a move-up/down list. Saving
  writes a manual `feed.order` that pins the folder's order ahead of the default
  watch-affinity → name sort (feeds without an explicit order still fall back to
  it). Persisted via `updateFeed`.

### Smart views (saved filters over items) — 2026-05-31

- A **Views** area in the rail holds saved filters. Seeded on first run with
  type smart-defaults — **Videos / Articles / Papers / Releases** — each shown
  only when items of that type exist, with a live unread count. Click to filter
  the stream by modality (great for a mixed feed + YouTube + papers set).
- **Save a search as a view**: type a search, hit **＋ view**, name it — it's
  persisted and pinned in the rail. Right-click any view to **rename** or
  **delete** (built-ins included; deletions stick and aren't re-seeded).
- Views persist to `/views.json` (`store.getViews` / `saveViews`); a view's query
  is a subset of `store.query` (type / text / saved / tag / category), filtered
  inbox-ish (excludes archived + routed).

### Adaptive poll cadence — 2026-05-31

- Polling is no longer one flat interval for every feed. `pollIntervalFor` scales
  each feed's `next_poll_at` off the `default_poll_interval_minutes` baseline by:
  **watch-affinity** (core YouTube channels ×0.4 → polled ~2.5× more often,
  barely-watched ×1.8), **observed cadence** (proven high-volume feeds ×0.7,
  proven-quiet ×2 — only once there's ≥3 weeks of history, so new feeds aren't
  starved), and **health backoff** (failing ×4, slow ×1.5). Clamped to
  [30 min, 1 week]. Makes a 1,600-channel set both fresher where it matters and
  far gentler on servers. Toggle in **Settings → Polling** (`adaptive_polling`,
  on by default); off restores the flat interval.

### Feed health: hijack / drift / stale detection — 2026-05-31

- New `health.js` `assessFeed` classifies each feed from the items already stored
  (no extra network) into **suspect**, **stale**, **failing**, or ok:
  - **suspect** (likely hijacked/drifted) is *scored* so it needs several tells,
    not one: author collapse to a generic `admin`-like name (+2), links uniformly
    pointing off the feed's own host (+1), and a repeated brand/template token
    across recent titles (+1); flagged at ≥3. This keeps legit non-English feeds
    and link blogs (offsite by nature) from false-flagging.
  - **stale** = fetches fine but no new posts in `feed_stale_days` (default 120).
  - **failing** = the poller can't fetch it (surfaces `feed_health.last_error`).
- Flagged feeds get a **rail badge + tint** and a tooltip with the reasons. A
  **status-bar chip** (`⚠ N suspect · N stale`) opens a **feed-health overlay**
  listing each flagged feed with its reasons and one-click **Edit feed…** /
  **Open site** / **Show items**. The PSF hijack from earlier today is exactly
  what this flags — automatically.

### Favicon: `<link rel="icon">` fallback — 2026-05-31

- Feeds whose `<origin>/favicon.ico` is missing now get a real icon via a second
  pass: fetch the home page, `parseIconLinks` pulls `icon` / `shortcut icon` /
  `apple-touch-icon` hrefs (resolved absolute, ranked SVG → ~32px → rest), and
  the best one or two are fetched. Same politeness throttle, only for feeds the
  `.ico` missed — so fewer feeds are stuck on a monogram. Size cap nudged 24→30KB.

### Edit / replace feed dialog — 2026-05-31

- Feed context menu → **"Edit feed…"** opens a dialog to change a feed's **name,
  URL, folder**, image + full-text flags, and — for hijacked or relocated feeds —
  **"remove stored items on save"**. Changing the URL re-points the feed (resets
  `next_poll_at`) and **re-polls the new source immediately**, so replacement
  items appear without waiting for the cycle. Replaces the old prompt-based
  Rename / Move-to-folder menu items.
- New `Store.clearFeedItems(feedId)` — drops a feed's items + their content,
  **saved items exempt**, and (unlike `prune`) writes no tombstone, so the new
  source's ids flow in freely. The motivating case: the PSF FeedBurner feed had
  been hijacked into Vietnamese shoe spam; now it's a one-dialog fix.

### Rail polish: favicons + density toggle — 2026-05-31

- **Feed favicons in the source rail.** Each feed's site icon is fetched once —
  through the bridge so cross-origin works — and cached as a `data:` URL on the
  feed record (`favicon` / `favicon_checked_at`). Fetching is lazy and polite:
  one request per origin, spaced ~1.5s, visible feeds first, de-duped, and a
  missing icon is re-tried at most monthly. Until a real icon arrives (or for
  feeds that have none) a deterministic **letter monogram** — first letter +
  a host-hashed hue — stands in, so the rail is scannable instantly and offline.
  Dead/failing feeds dim their icon. The health sparkline moved beside the count.
- **Row density toggle** (Settings → Reading): `comfortable` (default) ↔
  `compact`. Compact tightens rail + stream padding, hides item excerpts and the
  rail sparkline, and shrinks video thumbnails. Persisted as `density`, applied
  on load.
- Added `Store.updateFeed(id, patch)` — a shallow-merge persist for in-place feed
  edits; rename / move-to-folder / image+full-text toggles now use it instead of
  rebuilding the record through `putFeed`.

### SW: fix stale-README on reload; manual update check — 2026-05-31

- The service worker had cached the Jekyll README as the navigation root during the
  Pages-deploy transition, so a normal reload (Ctrl+R) served the stale README via
  the SW while a hard reload (which bypasses the SW) showed the real app. **Bumped
  the cache `weir-shell-v1 → v2`** so the new SW purges the poisoned cache on
  activate. Kept **offline-first** (cache-first) — instant load on bad connections.
- Added an ep-style **Settings → Updates**: a "check now" button (asks the SW to
  revalidate the shell; a reload toast appears if a new build is found) and an
  **auto-check** toggle (`auto_check_updates`) that turns the background shell
  re-fetch off for bad connections. SW message protocol: `weir:check-now` /
  `weir:set-auto-check`.

### Bug fixes from code review — 2026-05-31

A `/code-review` pass found and we fixed:
- **Context-menu Archive/Unarchive did nothing visible** (regression): a `reflectItem(id)`
  helper now refreshes-or-removes a row on any state change, so every action site
  (hover button, key, context menu) updates the DOM consistently — and keeps
  `this.items` + the topbar count in sync.
- **`markAllRead` scope bugs:** now reuses the `query` predicate, so "mark all read"
  on **Saved** only marks saved items (was marking the whole inbox), on an
  **ungrouped** folder only marks ungrouped (was marking everything), and on
  **Archived** actually works (was a no-op). Also fixes the `category=''`
  (ungrouped) **filter** in `query`.
- **Full-content no longer caches error pages** (checks `res.ok`), guards against a
  **stale slot / concurrent fetch** (in-flight set + only re-renders if still open),
  and **won't auto-refetch forever** when extraction fails (`_fullTried`).
- Undo now correctly **restores** an archived item; `rowEl` uses a single
  `querySelector` instead of a linear scan.

### Full-content extraction — read truncated feeds in full — 2026-05-31

- `src/js/extract.js`: lightweight readability (browser DOMParser) — pulls the
  main article from a fetched page (prefers `<article>`/`<main>`, else the densest
  low-link text block), sanitizes on the live DOM (drops scripts, event handlers,
  iframes, javascript:/data: URLs), resolves relative links/images, and applies
  the image-suppression policy.
- In the reader, a **"load full article ↡"** button fetches the item's URL through
  the bridge, extracts, and stores the result (`store.setContent`, marked `full`
  so it won't re-fetch). Feeds with **Auto-fetch full text** (per-feed toggle in
  the context menu, or the global `fetch_full_content_default`) do it automatically
  on open. Truncated feeds now read in full, images included.
- Verified in headless Chromium (full text in, nav/footer/script out, image
  suppressed, `full` persisted, button hidden after).

### UX batch — no-flicker rendering, hoisted controls, help, undo, feed management — 2026-05-31

- **Fixed hover flicker during polling:** poll inserts no longer tear the whole
  stream out from under the cursor. Counts update live; the rail+stream rebuild is
  debounced; click actions refresh just their row in place; scroll position is
  preserved across rebuilds.
- **Settings, routing.js, and ? help are now in the top bar** (no more scrolling
  the rail to the bottom to find them).
- **`?` help overlay** — keyboard cheatsheet + a note on the mouse interactions.
- **Undo toast** — archiving an item (key or button) drops it instantly with a 6s
  "Undo".
- **Middle-click / ⌘-click an item → open original** in a new tab.
- **Feed context menu** gains **Move to folder…**, **Rename…**, and an
  **Always load images / Block images** toggle — the simple, non-flaky way to
  regroup feeds (instead of drag).

### Mouse interactivity — actions + context menus — 2026-05-31

- **Per-item hover actions:** each row reveals save / read-toggle / archive /
  open-original buttons on hover or selection (mirroring the s/r/e/o keys).
- **Click a row to open it** in the inline reader (clicks inside the open article
  — links, text — are left alone).
- **Right-click context menus** (new tiny `src/js/ui/menu.js`):
  - items → open original, open/close here, save, read-toggle, archive, copy link;
  - feeds → show only, open site, mark all read, recover history, remove feed;
  - folders → view / mark all read / collapse; views → mark all read.
- `store.markAllRead({ feed_id | category | view })` bulk action.

### Resizable source rail — 2026-05-31

- Drag the divider between the rail and the stream to resize the source rail
  (clamped 170px–50vw). The width persists to settings (`rail_width`) and is
  restored on reload.

### UI polish — themed scrollbars + obvious onboarding — 2026-05-31

- Scrollbars themed to the dark surfaces (Firefox `scrollbar-color` + WebKit
  `::-webkit-scrollbar`) — no more default light scrollbar in the panels.
- Empty-state onboarding leads with a prominent **Import OPML…** button (opens the
  multi-file picker) and clearer copy, so adding your exports is obvious instead of
  hidden behind the small topbar link.

### GitHub Pages deploy — 2026-05-31

- Build output renamed `weir.html` → **`index.html`** (web-serving / Pages
  convention); SW shell, dev server, and docs updated.
- The built `index.html` is now **committed** (no longer gitignored) so GitHub
  Pages "deploy from a branch" serves it directly — no CI/source-flip needed.
  `.nojekyll` keeps Pages from rendering the README instead. To make this painless,
  the build is **deterministic**: `BUILD_DATE` is empty unless `WEIR_BUILD_DATE` is
  set, so `node build.js` produces byte-identical output and only re-diffs when
  `src/` actually changes.

### multi-file OPML import — 2026-05-31

- The import file picker now accepts **multiple OPML files at once**; they're
  combined (deduped by feed URL) into a single review, so a curated set split
  across files (active + yt-core + …) imports in one step.
- Fixed a footgun: "Feeds only" now only appears when there are actually non-YT
  feeds to separate — previously clicking it on an all-YouTube OPML imported zero.

### watch-affinity (YouTube Takeout signal) — 2026-05-31

- `src/js/affinity.js`: turns a Google Takeout watch-history digest
  (`channelId → { watches, months_since }`) into a **recency-weighted** affinity
  score — recent watches count fully, stale ones decay hard (≤6mo ×1, ≤12mo ×0.6,
  ≤24mo ×0.25, else ×0.08). So a binged-then-dropped Shorts-era fad ranks far
  below something you actually watch now.
- `Feed.affinity` + `store.applyAffinity(scoreMap)` stamp scores onto matching
  YouTube feeds (channel id extracted from the feed URL). The rail orders feeds
  within each folder by affinity (most-watched first), tooltips the score, and
  stars standouts (≥100).
- Settings → "YouTube watch data" imports the digest JSON.
- Tests: `tools/smoke-affinity.mjs` (recency weighting, id extraction, store
  stamping). Verified in-browser (import → reorder + star).

### settings panel — 2026-05-31

- A `settings ⚙` rail entry opens a panel surfacing what was console-only:
  polling (interval, concurrency, pause-when-hidden), reading (images, full
  content), **retention** (the archive-never-delete toggle, applied immediately
  on enable), **archive recovery** (drip interval, IA request spacing, max
  snapshots, optional IA keys), and **storage** (live persistence state + a
  "request persistence" button + usage). Unit conversions (min↔ms, s↔ms) handled.
- Verified in-browser (open → edit → save → persist → reopen reflects state).

### PWA — install, offline, durable storage — 2026-05-31

Adapted from `@gcu/ep`'s service-worker pattern. Being a controlled PWA is what
makes the browser readily grant persistent storage — so nothing is lost.

- `sw.js` (root): cache-first + stale-while-revalidate over the `weir.html` shell
  — instant load, full offline, and byte-comparison update detection that posts
  `weir:update-available` to the page. `manifest.webmanifest` + `icon.svg` /
  `icon-maskable.svg` (the weir glyph) make it installable.
- `src/js/pwa.js`: registers the SW (no-op on file://) and shows a "Reload to
  update" toast when a new build is detected. boot calls `initPwa()`; the build's
  `<head>` links the manifest + theme-color + icon; `serve.mjs` serves the
  manifest type.
- The single-file `weir.html` still works standalone (file://); served alongside
  these assets it becomes an installable, offline, persistent PWA.
- Verified in headless Chromium (SW registers + activates, manifest loads, no
  errors).

### retainer (archive, never delete) — 2026-05-31

- `store.runRetention()` + `src/js/retainer.js`: the retention sweep ARCHIVES
  expired, non-saved, non-routed items into the archived view — it never deletes
  (project decision: cold-store eventually, never lose). Uses the `expires_at`
  already computed at insert. Saved/routed/archived items are exempt. Runs on open
  and hourly. **Off by default** (`settings.retention_enabled = false`) so nothing
  expires until you opt in (`__weir.store.setSettings({ retention_enabled: true })`).
- Tests: `tools/smoke-retainer.mjs` (archives-not-deletes, off-switch, saved
  exempt, moves to archived view, idempotent).

### IA recovery drip — 2026-05-31

- `src/js/recovery.js`: `RecoveryDrip` — a very slow background trickle that
  recovers queued (archived/dead) feeds from the Internet Archive, making exactly
  ONE request per tick (a CDX query to start a feed, or a single snapshot fetch)
  on a long interval (`recovery_drip_interval_ms`, default 8 min). State persists
  to `/recovery.json` and resumes across restarts; pauses when the tab is hidden;
  completed feeds aren't re-queued. ~7 requests/hour max — gentle by construction.
- boot resumes the drip if there's pending work; status (`⏪ recovering n/total ·
  k waiting`) shows in the status bar. Drive from the console:
  `__weir.drip.enqueueCategory('graveyard')`.
- Tests: `tools/smoke-recovery.mjs` (one-request-per-tick, item accumulation,
  completion, persistence/resume — mock fetch).

### rail folders + ordering — 2026-05-31

- The source rail now groups feeds by `Feed.category` under collapsible folder
  headers (with per-folder unread counts), ordered by a sensible default
  (`CAT_ORDER`: active topics first, dead-heavy ones like geo sink to the bottom).
  Clicking a folder header filters the stream to that category; the caret toggles
  collapse. Feeds with no category render flat (single-feed users unaffected).
- `store.query({ category })` resolves items by their feed's folder.
- Verified in-browser (folder order, category filter, collapse).

### youtube adapter — 2026-05-31

- `src/js/adapters/youtube.js`: parses YouTube channel feeds
  (`youtube.com/feeds/videos.xml?channel_id=…`, Atom + yt:/media: extensions) into
  `video` items — thumbnail, channel, view count, `yt:videoId` stable id, watch
  URL, description. `detectFeedUrl` resolves a channel/@handle/watch page to its
  feed URL (channel id from the page), so a pasted channel URL works via the
  poller's autodiscovery. Registered before `feed` so YouTube URLs route here;
  `addFeed`/OPML pick the adapter by `match()`. (YouTube feeds carry no duration.)
- UI: video rows now render the actual thumbnail (lazy `<img>`) with a play
  overlay and a `fmtCount` view count.
- Tests: `tools/smoke-youtube.mjs` (real-structure fixture: video mapping, ids,
  thumbnail, views, match + autodiscovery, store round-trip). Verified in-browser.
  Confirmed against a live channel feed for structure.

### feed archaeology (Wayback recovery) — prototype — 2026-05-31

Recover a feed's lost/dead history from the Internet Archive. Read-only and
anonymous (no IA key required). Mirrors holocene's archive.org etiquette.

- `src/js/wayback.js`: `cdxSnapshots` (CDX API, distinct-by-digest, bounded scan,
  polite 429/503 single-retry-with-backoff) and `recoverFeed` (evenly samples the
  timeline to a hard cap, walks snapshots sequentially at ≥5s spacing, parses each
  with the feed adapter, unions items deduped by id; backs off / aborts on
  repeated failures; respects an AbortSignal). fetch + parseFeed injected.
- Settings: `wayback_min_interval_ms` (5000), `wayback_max_snapshots` (40), and
  optional `ia_access_key`/`ia_secret_key` (NOT needed for recovery — reserved for
  future Save-Page-Now).
- UI: a `⏪ recover` button appears when a single feed is selected; progress shows
  in the status bar. `__weir.recover(feedId)` from the console.
- Tests: `tools/smoke-wayback.mjs` (mock fetch: CDX dedup, snapshot walk,
  cross-snapshot dedup reconstructs history, cap honored). Live CDX confirmed
  real snapshots (QC RSS, 2008→2019); a 503 during repeated testing validated the
  need for the politeness/back-off built in. In-browser recovery routes through
  the bridge (archive.org sends no CORS headers).

### routing rules (router) — 2026-05-31

The fourth core subsystem. weir's v0.1 reader is feature-complete.

- `src/js/router.js`: `Router` compiles `routing.js` (plain-JS rules, `export
  default [...]`) and applies them to each NEW item at insert — `tag` (accumulate),
  `mark` (read/saved), `retain` (override expiry), `route` (move out of Inbox into
  a named view), `notify`. First match wins for scalars; a throwing rule is logged
  and skipped, never breaking the pipeline. `DEFAULT_ROUTING` template included.
- Store integration: `_route` applies rules + re-derives expiry on insert;
  `route` handling in `query`/`counts`; `rerunRules()` re-evaluates the ruleset
  over history (explicit, additive — rules aren't retroactive otherwise).
- UI: a `routing.js →` rail link opens a rules editor overlay (textarea, Save with
  compile-error surfacing, Re-run over history); a "Routed" rail section lists
  named routes with counts; an in-app notifications indicator in the status bar.
- Tests: `tools/smoke-router.mjs` (compile, tag/mark/retain/route/notify, error
  tolerance, store integration, rerun). Validated in headless Chromium (rule tags
  + routes an item out of the inbox, Routed section, notifications; no errors).

### OPML import/export — 2026-05-31

- `src/js/opml.js`: `parseOpml` (reuses the feed XML parser) flattens nested
  outlines, captures folder names as a feed `category`, and flags YouTube
  subscription feeds (`kind:'youtube'`); `buildOpml` writes a categorized export.
- Import flow (app): topbar import/export buttons + hidden file input. Import
  shows a review panel with the SPEC §10 separation choice — "Import all" vs
  "Feeds only" (leave YouTube subs out) — then adds feeds with spread
  `next_poll_at` so a large import polls politely. Export downloads
  `weir-feeds.opml`. Rail capped at 60 sources with a "+N more" note.
- `Feed.category` added to the schema (pass-through).
- Verified against the real 1,249-entry Inoreader export (1,088 YouTube, 161
  feeds, 6 categories) and in-browser (review → selective import → categorized
  feeds in the rail). Tests: `tools/smoke-opml.mjs`.

### poller + stream renderer — 2026-05-30

The data path now reaches the screen. weir is a usable reader.

- `src/js/poller.js`: per-feed scheduling via injected fetch (the bridge's
  gcuFetch in the app). Catch-up on open, `setInterval` ticks (paused when the
  tab is hidden, per settings), concurrency cap, feed-health bookkeeping
  (consecutive_failures, last_error, next_poll_at, state), and feed-URL
  autodiscovery retry when a site URL is pasted.
- `src/js/ui/format.js`: relative/absolute time, byte + duration formatting,
  HTML escaping, 7-day daily-count + sparkline points.
- `src/js/ui/app.js`: the two-pane controller — rail with live source sparklines
  + unread counts, view switching (inbox/saved/archived) and per-feed filtering,
  item rows by type (pills on the six accents), inline expand-to-read with lazy
  content + suppressed-image "load images" verb + podcast audio player, keyboard
  model (j/k, Enter, Esc, r/s/e/o, g i/s/a, /), add-feed box, and a first-run
  onboarding panel.
- boot now assembles store + poller + app and starts polling; status bar shows
  store/poll/bridge/persistence/storage.
- Tests: `tools/smoke-poller.mjs` (poll, dedup, failure handling, format helpers).
  Renderer validated end-to-end in headless Chromium (rows, expand, mark-read,
  keyboard nav, no JS errors) via a throwaway harness.

### feed adapter + parsers — 2026-05-30

- `src/js/parse/xml.js`: minimal, tolerant XML parser (no DOMParser dependency —
  runs in node and the browser). Handles CDATA, comments, entities, namespace
  prefixes; forgiving of malformed close tags.
- `src/js/parse/sanitize.js`: pragmatic v0.1 HTML sanitizer — strips scripts,
  event handlers, and javascript:/data: URLs; suppresses `<img src>` to
  `data-weir-src` unless the feed allows images (SPEC §2). Flagged for a
  DOM-grade replacement later.
- `src/js/adapters/feed.js`: the `feed` adapter — RSS 2.0 / RSS 1.0 (RDF) /
  Atom 1.0 / JSON Feed → raw Items. Feed-scoped stable ids (guid/id/link, hashed
  fallback), RFC822 + ISO date parsing, podcast/audio + thumbnail media, and
  `detectFeedUrl` autodiscovery.
- Console dev hook `__weir.addFeed(url)` (boot): fetch via the bridge → parse →
  store, so the whole slice is drivable from devtools before the poller/UI land.
- Tests: `tools/smoke-feed.mjs` (RSS/Atom/JSON fixtures + store round-trip);
  folded into `npm run smoke`.

### Storage layer + bridge probe — 2026-05-30

- VFS-backed store (`src/js/store/`): `schema.js` (Item/Feed/Tag/Settings, retention
  TTLs, `search_text`/`expires_at` derivation, fs-safe keys) and the `Store` class.
  Single store, backend-swappable (IndexedDB default; FSA/OPFS/memory). Queryable
  index lives in memory, hydrated at startup from compact per-feed NDJSON shards;
  item HTML content is lazy per-item files. Dedup on insert updates mutable fields
  only and an `archived_index` tombstone blocks resurrection (SPEC §5). Cursor-scan
  substring search over `search_text` (SPEC §6 v0.1).
- Vendored the `@gcu/bridge` page client (CC0); a non-blocking connectivity probe
  reports bridge presence/version in the shell status bar.
- Tooling: `tools/smoke-store.mjs` (insert/dedup/prune/rehydrate, run in node),
  `tools/serve.mjs` dev server (`npm run serve`), `npm run smoke`.

### Foundation decisions — 2026-05-30

Pre-implementation direction set while surveying the sibling `auditable` toolkit
for reusable parts. No reader code yet; this records settled choices.

- **License changed from CC0 to MIT** © Arthur Endlein Correia, to match
  `@gcu/vfs` and the rest of the auditable toolkit weir vendors from.
- **Vendoring foundation from `@gcu/auditable`** (`vendor/`): `@gcu/vfs` (storage
  backbone), Switchboard design tokens + Barlow/Space Mono fonts. Provenance and
  per-item licenses tracked in `vendor/PROVENANCE.md`.
- **Storage built on VFS**, single store with a selectable backend (IndexedDB by
  default, File System Access when the user picks a directory) so the entire state
  — content and index — can live on the real filesystem. Collapses the planned
  IDB→OPFS→FSA stages (SPEC §5) into a backend swap. Queryable index becomes an
  in-memory index hydrated from a packed file rather than IDB-native compound
  indexes. (Deviation from SPEC §5 literal v0.1; noted in CLAUDE.md.)
- **Design palette = canonical Switchboard `--sw-*`** (muted, accessibility-tuned
  basalt), superseding the mockup's brighter `--basalt-*`/`--a-*` tokens; mockup to
  be reconciled.

### v0.1 draft — 2026-05-23

Design phase. No implementation yet.

- Initial specification ([SPEC.md](SPEC.md)) covering architecture, data model
  (Item, Feed, Tag, Settings), adapters (`feed`, `youtube`, `scrape`), the
  two-pane UI and interaction model, the three-stage storage strategy
  (IndexedDB → OPFS → File System Access), retention rules, JS routing rules,
  views, two-layer search, and `@gcu/bridge` / Auditable Works integration.
- Interactive UI mockup ([examples/weir-mockup.html](examples/weir-mockup.html)).
- Scope, non-goals, and roadmap through v1.0 defined.

Build target for the first implemented release is SPEC.md §9 "v0.1 — Minimum
useful reader."
