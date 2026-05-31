# Roadmap

weir is well past its original v0.1 target — see [CHANGELOG.md](CHANGELOG.md) for
what's shipped (adapters, poller, router, retainer, OPML, search, feed archaeology
+ recovery drip, watch-affinity, PWA, full-content extraction, mouse UX). The
canonical design intent is [SPEC.md](SPEC.md); this file is the **forward plan**.
Nothing here is committed scope — it's the candidate list, roughly ordered.

## Near term — small UX / polish

- **Views over sources (smart-folders).** Saved filters over feeds and items —
  by folder, feed-health, or watch-affinity; saved item searches as `#views`
  (SPEC §6). The rail's "Routed" section is the seed of this.
- ~~**Feed favicons** in the rail for visual scanning.~~ ✅ Shipped 2026-05-31 —
  lazy/polite fetch via the bridge, cached as `data:` URLs, deterministic letter
  monogram fallback.
  - **Follow-up: `<link rel="icon">` fallback.** The fetcher only tries
    `<origin>/favicon.ico`. Sites that declare their icon only in HTML (no root
    `.ico`) keep the monogram. Add a second pass: fetch the home page, parse
    `<link rel="icon"|"shortcut icon"|"apple-touch-icon">`, resolve + fetch that.
    Gated behind the same politeness throttle; only for feeds that missed the
    `.ico`.
- ~~**Density toggle** (compact ↔ comfortable item rows).~~ ✅ Shipped 2026-05-31.
- ~~**Edit feed URL.**~~ ✅ Shipped 2026-05-31 — the feed context menu's
  "Edit feed…" opens a dialog (name, URL, folder, images, full-text, **+ "remove
  stored items on save"**). Changing the URL resets `next_poll_at` and re-polls
  the new source immediately; `clearFeedItems` drops the old items (saved-exempt,
  no tombstone). Motivated by a real hijack: the abandoned FeedBurner proxy
  `feeds.feedburner.com/PythonSoftwareFoundationNews` now serves SEO spam instead
  of `pyfound.blogspot.com` — now a one-dialog fix.
- **Manual reorder within a folder.** Regroup (move-to-folder) + rename already
  exist via the feed context menu; this adds a manual `feed.order` to override the
  affinity/name sort. (Drag deferred — context-menu "move up/down" likely enough.)
- **Manual prune control.** Retention is archive-only and off by default; add a
  "prune/archive expired now" action for when you do want a sweep.

## Medium

- **Affinity-driven poll cadence.** Poll favorites often, rarely-watched feeds
  seldom (from watch-affinity + observed activity) — makes a 1,600-channel set
  effortless and gentle. The default is now a flat 3h; this makes it adaptive.
- **Source-health view** (SPEC §9 v0.3): per-feed history, last-known-good,
  surfacing slow/failing feeds; auto-archive after a failure threshold.
- **Feed-hijack / drift detection.** A live feed can be quietly taken over —
  expired domains and abandoned FeedBurner proxies get repurposed into SEO spam
  (real case: the PSF FeedBurner feed now emits Vietnamese shoe listings). Signals
  to flag a feed as *suspect* in the rail: a sudden language shift vs. the feed's
  history, the `<title>`/`<link>` host diverging from the subscribed origin, every
  recent author collapsing to one (`admin`), or a burst of near-duplicate titles.
  Cheap heuristics over the items we already store; pairs with "Edit feed URL".
- **Bridge v0.2 conditional GETs.** When `@gcu/bridge` ships ETag/If-Modified-Since
  caching, wire `etag`/`last_modified` (already on the Feed model) for polite polls.
- **Search v0.2.** Swap the cursor scan for a MiniSearch/`@gcu/librarian` inverted
  index over `search_text` (ranked, fuzzy); index full-content text too.
- **Save-to-glass.** Auditable Works interop — `BroadcastChannel('gcu-handoff')`
  export with an FSA-markdown fallback (SPEC §7).

## Larger / research

- **More adapters:** `scrape` (public-page change tracking → `track` items), arXiv,
  GitHub, Mastodon, Bluesky.
- **Storage tiers.** OPFS/FSA content backend (the store is already backend-agnostic
  — mostly a config swap); a **cold-store** tier that offloads archived items out
  of the hot in-memory index — still never deleting ([[weir-never-delete]]).
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
