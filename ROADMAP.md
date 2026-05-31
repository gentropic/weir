# Roadmap

weir is well past its original v0.1 target — see [CHANGELOG.md](CHANGELOG.md) for
what's shipped (adapters, poller, router, retainer, OPML, search, feed archaeology
+ recovery drip, watch-affinity, PWA, full-content extraction, mouse UX). The
canonical design intent is [SPEC.md](SPEC.md); this file is the **forward plan**.
Nothing here is committed scope — it's the candidate list, roughly ordered.

## Glass — weir becomes a knowledge base (the big arc)

weir is becoming the home implementation of **`@gcu/glass`** (library-science
catalog over its own archive; see [GLASS.md](GLASS.md)). This reframes several
items below — **search v2** becomes facet-intersection + thesaurus (LIS-shaped),
**save-to-glass / SPEC §7** is retired into "weir *is* glass," and **webmcp** is
the trigger/query layer on top.

- ~~**Stage 0** — catalog format + deterministic cards + faceted browser.~~
  ✅ Shipped 2026-06-01 (`glass.js`, `Store.buildCatalog`, the rail **Catalog**
  facet browser with live intersection).
- **Stage 1 — the cataloger service.** ✅ *Foundation shipped 2026-06-01*
  (`llm.js` provider client, `llmkeys.js` OPFS vault, `cataloger.js` bounded call
  filling the language facets + abstract, `Store.writeCard`/usage ledger, Settings
  → AI cataloger). **Remaining:** the per-item "catalog" action + batch run
  (on-keep, Ollama-first), a `needs_review` **review queue** to confirm/correct,
  proposed typed `related` edges, and the catalog browser filling in its empty
  facets live as items get enriched.
- **Stage 2 — the query side.** Facet-intersection + thesaurus broaden/narrow (this
  *is* search v2); navigable emergent graph.
- **Stage 3 — notes & graph view.** Notes-as-items (`form: note`, markdown) +
  annotations; optional force-graph view; webmcp triggers.
- Near-term Stage-0 follow-up: a **faceted catalog view** (see the corpus by facet).

## Near term — small UX / polish

- ~~**Views over sources (smart-folders).**~~ ✅ Shipped 2026-05-31 — a rail
  **Views** area with persisted saved filters (`/views.json`), seeded type
  defaults (Videos/Articles/Papers/Releases, shown when non-empty), and
  save-a-search-as-a-view. Follow-ups: a richer view builder (combine type +
  folder + saved + tag in one dialog rather than only type-defaults or a saved
  search); **feed-health and watch-affinity views** (the `health`/`affinity`
  dimensions aren't yet expressible in a saved `query` — would need a post-filter
  or query extension); optional include-archived/routed scope per view.
- ~~**Feed favicons** in the rail for visual scanning.~~ ✅ Shipped 2026-05-31 —
  lazy/polite fetch via the bridge, cached as `data:` URLs, deterministic letter
  monogram fallback.
  - ~~**Follow-up: `<link rel="icon">` fallback.**~~ ✅ Shipped 2026-05-31 — feeds
    that miss `<origin>/favicon.ico` now get a second pass: fetch the home page,
    `parseIconLinks` extracts `icon`/`shortcut icon`/`apple-touch-icon` hrefs
    (ranked SVG → ~32px → rest), and the best one or two are fetched. Same
    politeness throttle; only for feeds the `.ico` missed.
- ~~**Density toggle** (compact ↔ comfortable item rows).~~ ✅ Shipped 2026-05-31.
- ~~**Edit feed URL.**~~ ✅ Shipped 2026-05-31 — the feed context menu's
  "Edit feed…" opens a dialog (name, URL, folder, images, full-text, **+ "remove
  stored items on save"**). Changing the URL resets `next_poll_at` and re-polls
  the new source immediately; `clearFeedItems` drops the old items (saved-exempt,
  no tombstone). Motivated by a real hijack: the abandoned FeedBurner proxy
  `feeds.feedburner.com/PythonSoftwareFoundationNews` now serves SEO spam instead
  of `pyfound.blogspot.com` — now a one-dialog fix.
- ~~**Manual reorder within a folder.**~~ ✅ Shipped 2026-05-31 — folder menu
  "Reorder feeds…" → move up/down dialog writing `feed.order` (pins ahead of the
  affinity/name fallback). Drag-to-reorder still deferred.
- **Manual prune control.** Retention is archive-only and off by default; add a
  "prune/archive expired now" action for when you do want a sweep.
- ~~**Gallery view.**~~ ✅ Shipped 2026-05-31 — list ↔ gallery topbar toggle
  (`stream_layout`); thumbnail grid using item `media.thumbnail` (videos) with a
  colored type-tile fallback; tiles are `.item` so click/select/expand are shared.
  Follow-up: ~~first content image~~ ✅ (inline `<img>` fallback shipped
  2026-05-31, zero-network); fetching `og:image` for articles with *no* inline
  image at all is still deferred (needs a per-item page fetch, like favicons).

## Medium

- ~~**Affinity-driven poll cadence.**~~ ✅ Shipped 2026-05-31 (`pollIntervalFor`
  in `poller.js`). Scales each feed's interval off the baseline by watch-affinity,
  observed cadence (≥3wk history guard), and health backoff; clamped 30 min–1 wk;
  `adaptive_polling` toggle (on by default). Follow-up: surface the effective
  interval per feed (edit dialog / tooltip); fold in time-of-day patterns.
- **Source-health view** (SPEC §9 v0.3): per-feed history, last-known-good,
  surfacing slow/failing feeds; auto-archive after a failure threshold.
- ~~**Feed-hijack / drift detection.**~~ ✅ Shipped 2026-05-31 (`health.js`).
  `assessFeed` scores each feed from its stored items into **suspect** (hijack/
  drift), **stale** (long-quiet), **failing** (poller can't fetch), or ok.
  Suspect needs ≥2 independent tells (generic-`admin` author collapse +2, links
  uniformly off the feed's own host +1, a repeated brand token across titles +1)
  so non-English feeds and link blogs don't false-flag. Flagged feeds get a rail
  badge + class; a status-bar chip (`⚠ N suspect · N stale`) opens a **feed-health
  overlay** listing each with its reasons and one-click *Edit feed* / *Open site*
  / *Show items*. Follow-ups: memoize per-feed health (currently recomputed each
  rail render); a dedicated health filter-view; richer signals (language-shift vs.
  the feed's own history, near-duplicate-body bursts); auto-suggest the native
  source when a FeedBurner proxy goes suspect.
- ~~**Bridge v0.2 conditional GETs.**~~ ✅ Shipped 2026-06-01. `@gcu/bridge`
  already brokers conditional GETs (auto-revalidation, `304→200` masking,
  freshness, `x-gcu-bridge-cache` header) — no bridge change needed. weir now
  stores `etag`/`last_modified`, sends `If-None-Match`/`If-Modified-Since` (also
  covers the direct-fetch path), and **skips parsing unchanged feeds** (304 or
  bridge cache hit). Status bar shows the cache ratio. Possible bridge tuning for
  heavy feed-reader use (its cache is 500 entries / 256 KB-body) — deferred.
- **Search v0.2.** Swap the cursor scan for a MiniSearch/`@gcu/librarian` inverted
  index over `search_text` (ranked, fuzzy); index full-content text too.
- **Save-to-glass.** Auditable Works interop — `BroadcastChannel('gcu-handoff')`
  export with an FSA-markdown fallback (SPEC §7).

## Larger / research

- **More adapters:** ~~GitHub~~ ✅ Shipped 2026-06-01 (releases/commits/tags Atom
  → `release`/`commit` items; add-time URL resolution). Remaining: `scrape`
  (public-page change tracking → `track` items), arXiv (→ `paper`), Mastodon,
  Bluesky.
- **Durability / storage tiers.** ~~Full backup + restore~~ ✅ + ~~FSA "mount to
  a folder"~~ ✅ both shipped 2026-06-01 — the store runs on a user-picked
  directory (adopt-or-migrate, persisted handle, bulletproof IDB fallback,
  reconnect flow). **Next: a cold-store tier** that offloads archived items out
  of the hot in-memory index to compacted on-disk storage — still never deleting
  ([[weir-never-delete]]). Possible follow-ups on the mount: auto-mirror to a
  second folder, OPFS as a zero-prompt middle tier.
- **Save-Page-Now.** Proactively archive live feeds to the Internet Archive (uses
  the IA keys already in Settings) so future [feed archaeology](CHANGELOG.md)
  always has snapshots. Plus link-rot recovery (dead item URL → archived page).
- **webmcp.** Vendor `../auditable/ext/webmcp` so Claude can drive weir directly —
  curation, triage, bulk ops.
- **Sync** (the open question, SPEC §10). Lean on the FSA archive dir +
  syncthing/rclone, or a `@gcu/pointer`/Trystero CRDT for read-state. Deferred
  until the need is real (multi-device).

## Known limitations / tech debt

- The full-content **extractor** (heuristic readability) and the **sanitizer**
  (regex for feeds, DOM for extraction) are pragmatic, not bulletproof —
  acceptable for a single-user local tool; revisit before any shared scenario.
- **Feed-health thresholds** are guesses (SPEC §10) — tune against real behavior.
- The rail/stream render eagerly; very large sets (1000+) lean on folder-collapse
  + the 300-row cap. Virtualize if it ever feels heavy.
- The built `index.html` is committed (deterministic build) for GitHub Pages.
- **Cleanup from the 2026-05-31 code review** (bugs fixed; these are the
  refactors): the six overlay open/close pairs + Esc id-list want one overlay
  mechanism; image-suppression lives in two places (`sanitize.js` regex +
  `extract.js` DOM) — unify into one `suppressImages` helper; feed-menu toggles
  mutate-then-`putFeed` — add `store.updateFeed(id, patch)`; item-action verbs are
  spelled out in three render sites (hover toolbar, reader footer, context menu) —
  drive from one descriptor list. (`reflectItem` already unified row updates.)
