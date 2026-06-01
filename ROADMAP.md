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
  → AI cataloger; **per-item + batch catalog UI**, and the **catalog browser
  fills in enriched facets live**; **wake-lock + PiP flight-deck** keep long runs
  alive; **WebMCP** can clear/start/stop/status the batch). ~~`needs_review`
  **review queue**~~ ✅ Shipped 2026-06-01 (⚑ chip → overlay with ✓/⟳/open per
  flagged card; `store.markCardReviewed`; `weir_reviewQueue`/`weir_reviewItem`).
  **Remaining:** proposed typed `related` edges, and a persisted `/glass-index/`
  so the browser scales past loading every card.
- **Catalog provenance + tiered escalation** (cross-cutting Stage-1 design). Keep
  **one canonical card per item** (`card.facets` = the active set everyone reads)
  — *not* parallel full catalogs (they N× storage and break the 1:1 item→card
  assumption the index / browser / review / thesaurus all rely on). Make the card
  cataloger-aware instead: an append-only `glass.history[]` of prior catalogings
  (`{cataloger, at, confidence, facets}`) for audit + rollback + model provenance.
  Re-cataloging pushes the old pass to history and promotes the new one. The real
  win isn't parallelism but **escalation**: bulk-catalog cheap (qwen, local, free),
  then escalate only the uncertain/valuable (`needs_review`, low-confidence, saved)
  to a strong model (nano-gpt GLM) — a "build" = a *policy over which items get
  which cataloger*, not a duplicate pass. **Hard rule: human-reviewed facets are
  sticky** — a re-build must skip or re-stage them, never clobber the review/
  thesaurus curation (today's overwrite-on-recatalog would erase it). Data-model
  impact is additive (`glass.history[]` + an escalation flag; `card.facets` stays
  active), so it needs no re-catalog to adopt. Full A/B model comparison stays a
  bounded one-off eval on a sample, not a permanent structure.
- **Concurrent cataloging (the cloud speed lever).** Cataloging is sequential
  today (one LLM call at a time — right for a local NPU). With a cloud provider
  (nano-gpt), an N-wide worker pool over the batch would finish ~N× faster (1.8k
  items: ~1h sequential → ~10 min at 6-wide). **Blocker to do first:** concurrent
  `writeCard`s race on the daily glass-id sequence (`_nextCatalogSeq` scans the dir
  → two in-flight catalogs get the same seq → the collision we already fixed once).
  Fix = a **concurrency-safe in-memory seq counter** in the store (init once per
  day from the dir, then synchronous `++`; reset on `clearCatalog`). Then a
  `catalog_concurrency` setting + a pooled `_runCatalog` (shared progress/breaker/
  cancel — safe since JS is single-threaded). Settable via `weir_setCatalog` once
  built. (pace + maxBodyChars knobs + provider/model control already shipped.)
- **Stage 2 — the query side.** Facet-intersection + thesaurus broaden/narrow (this
  *is* search v2 — ✅ the BM25F engine shipped; the facet-intersection/thesaurus
  *layer over it* is the remaining work); navigable emergent graph.
- **Stage 3 — notes & graph view.** Notes-as-items (`form: note`, markdown) +
  annotations; webmcp triggers. (Graph/map visualization broken out below.) The
  data model is ready today (`provenance: self`, `type: note` in `glass.js`); the
  new surface is a note *composer* — weir becomes the **write** side, not just
  read (the "replace Obsidian" move). Folds in Holocene's **activity log** as
  self-notes on import. Sequence: *after* the catalog base settles.
- **Stage 4 — holdings library (the glass endgame).** Extend glass from a *stream
  inbox* to also hold **static, undated holdings** — books (Dewey + Cutter, ready
  to inherit from Holocene), a papers shelf — so it's a literal LIS catalog, not
  just a feed reader. Key realizations: **cataloging holdings is already solved**
  (the Dublin-Core + facets card is format-agnostic; `form: book|paper`, Dewey →
  a facet) and **needs no PDF parsing** — title/author/abstract/Dewey from a `.bib`
  / IA metadata / Calibre is plenty for a card. **FSAA is the unlock** (big PDFs/
  EPUBs on the real filesystem, past IndexedDB's ceiling — the v0.3 storage stage).
  PDF *full-text* (for in-book search) is the stretch: **extract at import time in
  Node**, not in-browser — keeps shipped weir zero-dep (no inlined pdf.js). The real
  build is a **holdings *view*** — browse-and-keep, not inbox process-and-clear —
  over the same catalog/store. Endgame: post-FSAA, after notes.
- **Graph & map visualization (the "brain map").** Two complementary views over
  the catalog — designed to dodge the force-graph scale cliff from the start:
  - **Force graph = explicit relations** (the `related` edges / facet
    co-occurrence). Naive O(N²) layout + SVG dies at ~1–2k nodes (Obsidian's
    global graph is the cautionary tale). Scale levers: **Barnes–Hut quadtree**
    (O(N log N) layout, hand-rollable ~300 lines), **canvas** render (WebGL/
    cosmograph only at the extreme), **web-worker** the sim, **precompute + cache**
    positions (browse a static layout; re-sim only on change). The real unlock is
    **don't render everything**: nodes = entities/topics (not 8k raw items),
    community-clustered, level-of-detail. So build it as a **local / ego explorer**
    — focus+context (click → center + expand neighbors, fade the rest),
    search-to-subgraph, **faceted entry** (graph the "gaming" neighborhood from the
    facet browser). Navigability and scale are the same move; Obsidian's *local*
    graph ≫ its global one. **v1:** scoped ego-graph from a facet/entity, naive sim
    (small because it's local), canvas.
  - **UMAP map = semantic-similarity terrain** (higher-value + more scalable). Run
    **UMAP on the FACET VECTORS** (domain/entity/process… as multi-hot dims) — *no
    embedding model needed, reuses the catalog* — to a 2D map where similar items
    cluster spatially. Precompute (worker) → **static canvas scatter**: renders any
    N trivially, clusters visually obvious (cf. Nomic Atlas). UMAP > t-SNE (faster,
    keeps global structure, no perplexity fiddling); `umap-js` is small + vendorable.
  - **Combine them** (the good hybrids): seed the force layout from UMAP coords
    (fast convergence + meaningful start); UMAP map as the zoom-out *terrain* with a
    force/ego-graph on click for local explicit relations (map = context, graph =
    focus); color force nodes by UMAP cluster / facet community. Map answers "what
    are the clusters / where's the white space," graph answers "what connects to
    what."
  - Zero-dep fit: Barnes–Hut + canvas + a blob-inlined worker are hand-rollable;
    `umap-js` vendors as source. Supersedes the loose "graph view" mentions in
    Stage 2/3.
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
- **Unattended-run survival (wake lock + PiP flight-deck).** Long catalog batches
  run in the page, so they stall on two browser throttles: the machine sleeping,
  and background-tab timer throttling. Two clean, self-sufficient fixes (vs. an
  external mouse-jiggler):
  - **Screen Wake Lock** — `navigator.wakeLock.request('screen')` while a batch is
    running, released when it finishes/cancels. Stops display/system sleep
    programmatically. Small, do first.
  - **Document Picture-in-Picture flight-deck** — a pop-out always-on-top window
    (`documentPictureInPicture`) showing catalog progress + latest items + quick
    actions, that *also* hosts the batch's pacing timer. A PiP window is always
    `visible`, so its timers aren't background-throttled, and (same-origin, shared
    JS agent) it can drive the main app's catalog step even while the main tab is
    buried — defeating the overnight crawl. Chromium-only, needs a user gesture to
    open, one at a time; **verify the keep-alive behavior with a quick prototype**
    before relying on it. Nice as a feature regardless (a real flight-deck view).
- **Collapse-all / expand-all folders.** The folder menu has per-folder
  Expand/Collapse and the rail tracks `collapsedCats`; add a one-click
  collapse-all / expand-all (rail control + folder-menu items) — trivial
  (`collapsedCats` = all categories / cleared). Useful once there are many folders.
- **Nested folders (sub-folders).** `category` is a single flat string today.
  Allow a hierarchy — path-style categories (`tech/ai`) or a parent ref — touching
  rail grouping (recursive collapse), the `category` query filter, drag/reorder,
  and the edit-feed folder field. Pairs with collapse-all above.
- ~~**Gallery view.**~~ ✅ Shipped 2026-05-31 — list ↔ gallery topbar toggle
  (`stream_layout`); thumbnail grid using item `media.thumbnail` (videos) with a
  colored type-tile fallback; tiles are `.item` so click/select/expand are shared.
  Follow-up: ~~first content image~~ ✅ (inline `<img>` fallback shipped
  2026-05-31, zero-network); ~~thumbnails in **list** view too~~ ✅ Shipped
  2026-05-31 (rows show any item's `media.thumbnail`, not just videos — lazy,
  browser-cached, no play overlay for articles). Fetching `og:image` for articles
  with *no* inline image at all is still deferred (needs a per-item page fetch).
- **Virtual scrolling (list + gallery).** Render only the visible window + a
  buffer and recycle rows on scroll, replacing the 300-row `RENDER_CAP` so the
  whole corpus is scrollable and the gallery stays smooth as thumbnail count
  grows. Complicated by **variable row heights** (expand-in-place, video vs text
  vs thumbnail) — needs measured/estimated heights, and must keep keyboard nav,
  selection, and the expand-in-place pipeline correct. Worth a dedicated, tested
  pass (ideally when no catalog run is mid-flight, since a reload interrupts it).
  Supersedes the 300-cap tech-debt note below.

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
- **Saved-link import + Holocene/Telegram inflow.** ✅ *Importer shipped 2026-06-01*
  — the **Import** button / file drop now **sniffs the file** (`importers.js` →
  `detectImport`): OPML → feeds (as before); **Telegram export JSON**, **URL list**,
  and **JSON link arrays** → saved links under a non-pollable **Saved Links** source,
  ready to catalog (`App.importLinks`). Share-sheet/shortener URLs (share.google /
  search.app / bit.ly…) are **unwrapped via gcuFetch** (follow redirects → real
  destination) so dedup keys on the target; in-text titles (Google Discover
  "Title | Source &lt;url&gt;") are kept; ids are url-hash so re-import never resets
  read/saved. This folds in Holocene's backlog — **~1,500 unique links** across two
  Telegram exports (2023→2026; see the weir-holocene-migration note). **Remaining:**
  (a) the **ongoing Telegram bot adapter** — mint a *fresh weir bot*, poll Bot API
  `getUpdates` via gcuFetch (allowlist `api.telegram.org`), token in the OPFS vault
  like the LLM key, so new saves flow in live (rei retires as the consumer); (b)
  recover the rei DB's per-link **Wayback snapshots** (`archive_url`/`archive_date`)
  when it's back — dead-link insurance, ties to feed archaeology; (c) more import
  formats (browser bookmarks HTML, `.bib`) = one parser each in `importers.js`.
- **Archive-on-save (linkrot insurance).** Adopt Holocene's habit: when a link is
  saved/imported, ask the Internet Archive to snapshot it (Save-Page-Now), so the
  copy survives the source going dark. It's *good* citizenship (you're feeding the
  commons + preventing rot) with guardrails Holocene already had: respect IA rate
  limits + **exponential backoff**, **check-before-archive** (skip recent snapshots),
  use the user's own IA S3 keys (`ia_access_key`/`ia_secret_key` already in
  settings), **public pages only**. Route via gcuFetch/bridge (allowlist
  `web.archive.org`). Volume is trivial (~1.4 links/day); the ~1,500 backlog gets a
  gentle rate-limited pass. Pairs with never-delete + the shipped Wayback recovery.
- **Remote thin interface via a Telegram Mini App** *(back-pocket / speculative)*.
  A tiny phone-side UI for weir-on-desktop — notes input, maybe light control —
  with **no server and no webhook**. Two tiers:
  - **Simplest (one-way, basically free):** a static Mini App note-composer form →
    `Telegram.WebApp.sendData(JSON)` → arrives as a `web_app_data` message →
    desktop weir's `getUpdates` poll ingests it as a structured note. No return
    channel, no WebRTC. (Constraints: `sendData` needs a reply-keyboard `web_app`
    launch; ~4 KB payload.) This is the one to actually reach for.
  - **Live/bidirectional (the clever hack):** use Telegram only as a one-way
    courier for a **WebRTC room ID** — phone joins a **Trystero** (or PeerJS) room,
    `sendData(roomId)`, desktop reads it via `getUpdates` and joins the same room;
    the P2P lib does the *real* SDP/ICE signaling, then it's a direct data channel
    and Telegram drops out. The Mini App's **`CloudStorage`** (durable, cross-device
    synced KV) stashes the room ID → **pair once, auto-reconnect**. This dissolves
    the "a Mini App can't *receive* bot messages" blocker, since Telegram only
    carries ~20 bytes one-way.
  - **Honest asterisks:** (1) it's a **dependency** (Trystero/PeerJS) vs weir's
    single-file ethos — only acceptable lazy-loaded *inside* this feature, never in
    core. (2) Trystero is "serverless" in the SaaS-marketing sense — it leans on
    *public* rendezvous infra (BitTorrent trackers / Nostr / MQTT), not GCU-grade
    actually-serverless. (3) **NAT is the real gremlin:** same-WiFi P2P works on
    STUN; true-remote (phone-on-cellular ↔ desktop) usually needs a **TURN relay**,
    which *is* a server. So it shines as a same-network remote. (On-LAN, the
    `@gcu/webmcp` bridge binding the LAN IP instead of `127.0.0.1` would be even
    simpler — no WebRTC at all — at a different security tradeoff.)
  - **Safety over sketchy relays — yes, if you trust the endpoints, not the
    transport** (the GCU posture). Split content from metadata: **content is safe
    by construction** — WebRTC data channels are *always* DTLS-encrypted E2E (a
    TURN relay forwards ciphertext; it can't read notes), and Trystero encrypts its
    signaling under a room-derived key before it touches a public tracker / Nostr /
    MQTT, so the relay is a blind dead-drop. The real soft spots aren't the weird
    relays but **the courier + room-id-as-bearer-secret**: Telegram can read what
    you hand it (the note in tier-a; the room id in tier-b), and anyone who gets the
    room id can join the room. The careful recipe: **layer your own E2E key,
    pre-shared out-of-band** (generated on desktop, QR-scanned by the phone — never
    via Telegram/CloudStorage), **rotate room ids per session**, and **pin the
    peer's DTLS fingerprint**. Then a leaked room id buys an attacker nothing
    (encrypted door, no key). Residual is **metadata only** (the two IPs + timing +
    volume visible to whatever relay is in path) — shrink it by self-hosting TURN
    (coturn), else accept it as low-sensitivity for your own two devices. Tier-a's
    `sendData` note, by contrast, is readable by Telegram — fine for everyday notes,
    not for secrets.
- **Favorites & passive harvesting — `@gcu/glean`.** Pull "saved / favorited"
  items from accounts that don't expose feeds — MercadoLibre & Amazon favorites /
  wishlists, etc. — into weir as items, so the second brain sees them too. This is
  the **`@gcu/glean`** concept: deliberately a *separate* sibling tool (per
  CLAUDE.md), because it's authenticated + must be **human-cadence and polite** (the
  "sifter" scraper) precisely to avoid tripping a site's anti-automation /
  enforcement — something weir's public-only `scrape` adapter must never do.
  Cleanest shape: **glean produces, weir stores/reads** — glean harvests in its own
  careful process (its own session, throttle, retries) and emits normalized items
  weir ingests via an adapter or a `BroadcastChannel`/file handoff. Keeps weir's
  "no authenticated scraping" boundary intact while still feeding everything in.
  Open decision: glean-as-sibling vs. a tightly-guarded weir capability.
- **Durability / storage tiers.** ~~Full backup + restore~~ ✅ + ~~FSA "mount to
  a folder"~~ ✅ both shipped 2026-06-01 — the store runs on a user-picked
  directory (adopt-or-migrate, persisted handle, bulletproof IDB fallback,
  reconnect flow). **Next: a cold-store tier** that offloads archived items out
  of the hot in-memory index to compacted on-disk storage — still never deleting
  ([[weir-never-delete]]). Possible follow-ups on the mount: auto-mirror to a
  second folder, OPFS as a zero-prompt middle tier.
- **Storage size report (breakdown).** Today Settings + the status bar show only a
  global usage/quota (browser `estimate()`). Add a **per-area breakdown** — feed
  metadata, item index, stored content HTML, catalog cards, favicons, (and images,
  below) — computed via a VFS walk (`store._walk` already enumerates the tree).
  Shows what's actually eating space and informs the retention / cold-store calls.
  This is the "size report in general" we want regardless.
- **Self-hosted thumbnails / cover images (opt-in).** Today thumbnails are remote
  URLs — browser-cached only, so list/gallery re-fetch after cache eviction and
  break offline. Optionally cache them locally (OPFS or the FSA folder) behind a
  **toggle**, with a **size report + cap** so the cost is visible and bounded.
  Tension to honor: the "no media caching" non-goal (SPEC §8) rules out audio/video
  *enclosures* (streamed); small cover images are a different, measured trade and
  stay opt-in. Pairs with the storage breakdown above (and the cold-store tier).
- **Save-Page-Now.** Proactively archive live feeds to the Internet Archive (uses
  the IA keys already in Settings) so future [feed archaeology](CHANGELOG.md)
  always has snapshots. Plus link-rot recovery (dead item URL → archived page).
- ~~**webmcp.**~~ ✅ Shipped 2026-05-31 — weir speaks **WebMCP** via
  **`@gcu/webmcp`** (repo `gentropic/webmcp`): vendored `webmcp-shim.js` +
  `src/js/webmcp.js` adapter, `.mcp.json` (port 7801), gcuFetch transport for the
  public-origin PWA. Read tools (`weir_queryItems` w/ keyset pagination,
  `weir_getItem`, `weir_listFacets` w/ caps) + mutation/control tools
  (`weir_setState`, `weir_catalogItem`, `weir_catalogControl` start/stop/clear/
  status). Claude Code can query, triage, and drive cataloging over localhost.
  **Next:** deeper "trigger LLM processing" hooks (notes, thesaurus drafting via
  the term distribution); per-call confirmation if a shared scenario ever needs it.
- **Sync** (the open question, SPEC §10). Lean on the FSA archive dir +
  syncthing/rclone, or a `@gcu/pointer`/Trystero CRDT for read-state. Deferred
  until the need is real (multi-device).

## Known limitations / tech debt

- The full-content **extractor** (heuristic readability) and the **sanitizer**
  (regex for feeds, DOM for extraction) are pragmatic, not bulletproof —
  acceptable for a single-user local tool; revisit before any shared scenario.
- **Feed-health thresholds** are guesses (SPEC §10) — tune against real behavior.
- The rail/stream render eagerly; very large sets (1000+) lean on folder-collapse
  + the 300-row cap. **Virtual scrolling** is now a tracked near-term item (above).
- The built `index.html` is committed (deterministic build) for GitHub Pages.
- **Cleanup from the 2026-05-31 code review** (bugs fixed; these are the
  refactors): the six overlay open/close pairs + Esc id-list want one overlay
  mechanism; image-suppression lives in two places (`sanitize.js` regex +
  `extract.js` DOM) — unify into one `suppressImages` helper; feed-menu toggles
  mutate-then-`putFeed` — add `store.updateFeed(id, patch)`; item-action verbs are
  spelled out in three render sites (hover toolbar, reader footer, context menu) —
  drive from one descriptor list. (`reflectItem` already unified row updates.)
