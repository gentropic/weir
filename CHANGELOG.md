# Changelog

All notable changes to `@gcu/weir` are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is described in
[SPEC.md §9](SPEC.md).

## [Unreleased]

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
