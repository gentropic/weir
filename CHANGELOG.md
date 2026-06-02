# Changelog

All notable changes to `@gcu/weir` are documented here. Format loosely follows
[Keep a Changelog](https://keepachangelog.com/); versioning is described in
[SPEC.md §9](SPEC.md).

## [Unreleased]

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
