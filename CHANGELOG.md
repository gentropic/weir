# Changelog

All notable changes to `@gcu/weir` are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is described in
[SPEC.md §9](SPEC.md).

## [Unreleased]

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
