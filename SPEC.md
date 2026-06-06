# @gcu/weir — Spec

Status: v0.1 draft · 2026-05-23 · MIT

`@gcu/weir` gathers timestamped streams — RSS, Atom, JSON Feed, YouTube, GitHub,
arXiv, ActivityPub, AT Proto, scraped pages, anything that produces dated items
on a schedule — and presents them in a single reader. Source format is an adapter
concern, not a UX concern. Items are typed; the UI renders by type; storage is
local-first and eviction-resistant.

**Why weir?** A weir is a low barrier in a stream that controls flow without
fully blocking it — and, when calibrated, a weir is also how you *measure* flow.
Both purposes apply here. Routing rules and retention control which items pass
through to which views and which survive over time; source sparklines,
publication-cadence indicators, and storage usage gauges measure the streams
you're channeling. The metaphor covers control and observation in one word.

This is the design-intent reference. The [README](README.md) is the five-minute
onboarding. When spec and implementation disagree, file an issue; until resolved,
this doc is the canonical statement of intent.

**Contents.** §1 Architecture · §2 Data model · §3 Adapters · §4 UI &
interaction · §5 Storage & offline · §6 Routing, views & search · §7 Integration ·
§8 Non-goals · §9 Versioning & roadmap · §10 Open questions

---

## 1. Architecture

A single-file HTML application that lives in a pinned browser tab (or as an
Auditable Works tool). Zero npm dependencies; embedded copies of
`bridge-client.js` and any other small CC0 helpers. State lives in IndexedDB
(v0.1), with OPFS (v0.2) and File System Access (v0.3) as the path to
eviction-resistant, file-shaped storage.

```
┌─────────────────────────────────────────────────────────┐
│  weir.html  (single-file UI, pinned tab)              │
│                                                          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌─────────┐ │
│  │ adapters │  │ poller   │  │ retainer │  │ router  │ │
│  └─────┬────┘  └────┬─────┘  └────┬─────┘  └────┬────┘ │
│        └────────────┴─────────────┴─────────────┘      │
│                          │                              │
│                   ┌──────┴──────┐                       │
│                   │  store API  │  (IDB + OPFS + FSA)   │
│                   └──────┬──────┘                       │
└──────────────────────────┼──────────────────────────────┘
                           │
                  ┌────────┴────────┐
                  │  @gcu/bridge    │  (fetches, ETag cache)
                  └─────────────────┘
                           │
                       any URL
```

Four internal subsystems:

- **Adapters** — match URLs to source types, parse responses into Items.
- **Poller** — schedules fetches per feed using `gcuFetch`; respects poll intervals
  and bridge-side conditional GETs.
- **Retainer** — applies retention policy; archives or deletes items per rules.
- **Router** — evaluates routing rules on each new item; applies tags; updates
  views.

The store is the only shared mutable surface. Everything else is event-driven
around inserts.

### Lifecycle

The reader runs only while the tab is open. Polling is `setInterval`-driven and
pauses on `document.visibilityState === 'hidden'` (configurable). On open, the
poller does a catch-up pass: feeds whose `next_poll` has elapsed get fetched in
parallel, capped at N concurrent (default 8). New items flow through the router,
then into the store. The UI listens for store events and re-renders the active
view incrementally.

The reader is single-device by design in v0.1. Sync (across zero-gravitas, the
eventual Mac Studio, etc.) is an open question — see §10.

---

## 2. Data Model

Two top-level entities: `Item` (the things that flow into the reader) and `Feed`
(the sources that produce them). Plus supporting types — views, rules,
settings — which are smaller and live alongside.

### Item

The unified type that every adapter emits. Stored verbatim; the UI renders by
inspecting `type`.

```ts
interface Item {
  // Identity
  id: string;              // stable, source-scoped (e.g. "arxiv:2026.04321")
  feed_id: string;         // FK to feeds table
  url: string;             // canonical URL of the item itself

  // Common metadata
  title: string;
  author?: string;
  published_at: number;    // epoch ms; falls back to fetched_at if absent
  fetched_at: number;      // epoch ms

  // Content
  type: ItemType;          // see below
  content: string;         // sanitized HTML (text-shaped types) or empty
  excerpt?: string;        // first ~300 chars, derived; for list view
  search_text: string;     // lowercased title + author + excerpt; used by §6 search

  // State
  read: boolean;
  saved: boolean;          // bypasses retention
  tags: string[];          // applied by router or manually
  expires_at?: number;     // computed at insert; null = never expires

  // Type-specific
  media?: Media;           // for video, podcast, image
  structured?: object;     // adapter-specific (PR state, commit list, paper authors, etc.)
}

type ItemType =
  | 'article'    // blog post, news, generic feed item
  | 'video'      // YouTube, PeerTube, etc.
  | 'release'    // GitHub release, package version
  | 'paper'      // arXiv, journal feeds
  | 'status'     // Mastodon, Bluesky, social posts
  | 'track'      // scrape adapter — a watched page changed
  | 'podcast'    // RSS with audio enclosure (metadata only; no enclosure cache)
  | 'commit'     // git commit feed
  | 'issue';     // issue tracker feed

interface Media {
  thumbnail?: string;      // URL; not cached in v0.1
  duration_seconds?: number;
  audio_url?: string;      // streamed, never cached
  video_url?: string;      // streamed
}
```

### ID stability

`id` must be stable across re-fetches. Adapters derive it from a source-specific
canonical identifier: arXiv ID, YouTube video ID, GitHub release tag, RSS GUID,
URL hash for scrape items. **Never the array index in a feed** — feeds reorder.
If a feed omits stable IDs, the adapter synthesizes one from URL + published_at.

### Sanitization

`content` is sanitized HTML. The reader runs a strict allowlist on incoming
content (DOMPurify or equivalent) before storing. Stored content is trusted.
Script tags, event handlers, and `javascript:` URLs are stripped at parse time,
never at render time.

### Image handling

Feed content commonly embeds tracking pixels and other privacy-leaking imagery.
By default, the sanitizer strips `src` attributes from `<img>` tags during parse
and replaces them with a placeholder element noting "image suppressed (click to
load)." A per-feed `images_allowed: true` flag bypasses this for feeds the user
explicitly trusts. A per-item "load images" verb is always available; once
invoked, the actual `src` is restored for that item only.

In v0.3+, bridge-proxied image fetching becomes an opt-in privacy upgrade: even
allowed images are fetched through `@gcu/bridge`'s service worker, so the
upstream sees the bridge's IP rather than the user's. Not committed for v0.1.

### Expires_at

Computed by the retainer at insert: `expires_at = published_at + ttl(type, feed)`.
Stored even if v0.1 retention is just "manual prune button." Saved items
(`saved: true`) ignore `expires_at`. The field exists from day one so v0.2
retention is a no-data-migration release.

### Feed

The source-of-truth record for each subscription. Adapters operate on a `Feed`;
the poller schedules around `next_poll_at`; the source rail visualizes
`feed_health`.

```ts
interface Feed {
  // Identity
  id: string;              // stable; slug-cased from name or URL
  url: string;             // poll URL (RSS/Atom/JSON endpoint, channel feed URL, etc.)
  adapter: string;         // adapter name: 'feed' | 'youtube' | 'scrape' | ...

  // Display
  name: string;            // user-visible name; editable
  site_url?: string;       // human-facing site (for "open source site" verb)
  icon_url?: string;       // favicon or channel avatar; cached locally

  // Scheduling
  poll_interval_minutes: number;   // default per-adapter; user-overridable
  last_polled_at?: number;
  next_poll_at: number;
  etag?: string;           // for conditional GETs once bridge v0.2 lands
  last_modified?: string;  // ditto

  // Per-feed settings
  images_allowed: boolean;          // §2 image handling override; default false
  fetch_full_content: boolean;      // if true, follow item URLs for full text; default false
  retention?: RetentionPolicy;      // overrides type defaults; see §5

  // Health
  feed_health: FeedHealth;
  state: 'healthy' | 'slow' | 'failing' | 'archived';

  // Adapter-specific
  config?: object;                  // e.g. scrape selectors, YouTube channel ID
}

interface FeedHealth {
  last_successful_poll?: number;
  consecutive_failures: number;
  last_error?: string;              // human-readable, last error message
  avg_items_per_week?: number;      // rolling 4-week average; drives "dying" detection
  publication_history: number[];    // counts per day for last 30d; drives sparkline
}

interface RetentionPolicy {
  unread_days?: number | 'forever';
  read_days?: number | 'forever';
  max_items?: number;               // hard cap on stored items for this feed
}
```

**State transitions.** `healthy` is the default. `slow` if no items in 2x the
avg cadence (configurable). `failing` if `consecutive_failures` ≥ N (default 5)
or if `last_successful_poll` was > N days ago (default 14). `archived` is
user-set or auto-set after extended failure — polling stops, items remain
accessible, the feed can be promoted back to `healthy` via a manual verb.

**Display in source rail.** Sparkline color reflects `state`: muted for
`healthy`, slightly warm for `slow`, warning-tinted for `failing`, fully dim
for `archived`. Sorting puts active feeds toward the top, archived toward the
bottom, with a collapse threshold.

### Tags

Tags are bare strings on `Item.tags`. Applying a tag that doesn't yet exist
creates it implicitly — there is no separate "create tag" step. An optional
`tags` store holds presentation metadata for tags the user has customized:

```ts
interface Tag {
  name: string;            // the string used in Item.tags; primary key
  color?: string;          // one of the six Switchboard accents; default assigned by hash
  label?: string;          // display override; defaults to name
  pinned?: boolean;        // show in the rail's view list
}
```

A tag with no `Tag` record still works — it renders with a hash-derived accent
color and its raw name. The store exists only so the user can pin, recolor, or
relabel. Deleting a `Tag` record does not remove the tag from items; it just
reverts that tag to defaults. Removing a tag from all items is a separate bulk
action.

### Settings

Global configuration, single `settings` record (key-value or one object):

```ts
interface Settings {
  default_poll_interval_minutes: number;   // default 30
  poll_concurrency: number;                 // max parallel fetches; default 8
  pause_polling_when_hidden: boolean;       // default true
  images_default_allowed: boolean;          // global default for new feeds; default false
  retainer_run_hour: number;                // 0–23 local; daily retention pass; default 4
  theme: 'switchboard-dark';                // only option in v0.1
  fetch_full_content_default: boolean;      // default false
}
```

Per-feed settings (`images_allowed`, `fetch_full_content`, `retention`) override
these defaults where present.

---

## 3. Adapters

Adapters convert source-specific responses into Items. They're the only place
that knows about RSS or Atom or AT Proto.

### Interface

```ts
interface Adapter {
  name: string;            // e.g. 'youtube', 'arxiv', 'feed'
  match(url: string): boolean;
  parse(response: Response, feed: Feed): Promise<Item[]>;
  detectFeedUrl?(pageUrl: string, html: string): string | null;
  // Optional custom renderer for items of this adapter's type
  render?(item: Item, container: HTMLElement): void;
}
```

`match` is consulted in registration order; first match wins. The fallback
`feed` adapter (RSS/Atom/JSON Feed) matches anything content-typed as a feed.
`detectFeedUrl` is optional autodiscovery: given a page URL and its HTML,
return a feed URL if one is linked.

### v0.1 adapters

- **`feed`** — RSS 0.9/2.0, Atom 1.0, JSON Feed 1.x. Handles the long tail. Bundles
  a minimal parser (~30KB), accepts malformed XML pragmatically.
- **`youtube`** — channel URLs and `/feeds/videos.xml` endpoints. Parses Atom with
  YouTube namespace extensions; extracts thumbnail, duration, view count.
- **`scrape`** — config-driven monitoring of a **public** page. Config is a URL
  plus an optional content selector (a CSS selector scoping which part of the
  page to watch; defaults to `body`). On each poll the adapter fetches via the
  bridge, extracts the selected region, and normalizes it to text (strip scripts,
  styles, and attributes; collapse whitespace). It stores the latest normalized
  snapshot per source and a content hash. When the hash changes, it emits one
  `track` item whose `content` is a unified-diff summary (added/removed lines)
  plus the new snapshot, and `structured` carries `{ added, removed }` line
  counts for the rail's diff badge. No diff history chain is kept — only the
  latest snapshot is retained (see §5 for the per-source snapshot cap), so a
  `track` item is a point-in-time "this changed" record, not a reconstructable
  timeline.

  **Authenticated pages are out of scope for `scrape`.** It polls via the bridge,
  which sends no cookies, so login-gated or personalized pages (favorites,
  wishlists, account views) return logged-out content or bot walls. Passive
  harvesting of those is a separate concern handled by `@gcu/glean`, which reads
  the DOM of pages you visit while logged in rather than polling them. A future
  `glean` source can feed harvested items into weir; the `scrape` adapter
  stays narrowly about pollable public pages.

That's it for v0.1. arXiv, GitHub, Mastodon, Bluesky, podcast, generic ActivityPub
are post-v0.1.

### Encoding

Real-world feeds declare encodings that don't match their bytes. The `feed`
adapter detects encoding from (in priority order) the HTTP `Content-Type`
charset, the XML declaration, the BOM, and a heuristic fallback to UTF-8 with
Windows-1252 retry. Mojibake is logged but does not fail the parse — better to
show garbled-but-readable than nothing.

### Adapter ordering

A URL pattern can match multiple adapters (e.g. youtube.com/feeds/videos.xml
matches both `youtube` and `feed`). Registration order determines precedence;
more specific adapters register before `feed`.

---

## 4. UI & Interaction Model

Two-pane layout: source rail on the left, item stream on the right. The mockup
referenced in design discussions is the canonical reference.

### Source rail

- **Inbox views** — `inbox`, `work`, `later`, `archived`. Counts shown inline.
- **Sources** — per-feed entries with a 7-day publication sparkline. Active feeds
  toward the top; dim/dead feeds toward the bottom. Collapses to `+ N more` when
  the list exceeds ~10.
- **Views** — saved searches as `#named-view` references. Plus an editor link
  (`routing.js →`) to the routing rules file.

### Item stream

Items render as a vertical list, newest first by default. Each item:

- Left column: type pill (colored by adapter)
- Right column: type-specific rendering of title, preview, and metadata

Type-specific rendering:

- `article` — title, excerpt, source/author/timestamp
- `video` — thumbnail (lazy-loaded, not cached), title, duration, channel
- `release` — title with version, commit summary, repo/author/timestamp
- `paper` — title, abstract preview, journal/authors/timestamp
- `track` — title with change description, diff preview, source URL/timestamp
- `status` — author prominent, content body, instance/timestamp
- `podcast` — title, episode description, duration, embedded player on click

### Reading an item

Selecting an item (click or `j`/`k`) highlights it in the stream. Opening it
(`Enter`, or click on the title) expands it **inline**: the item's row grows in
place to show full `content`, pushing subsequent items down, with the rest of
the stream still visible above and below. This keeps the list as the spine —
there's no separate reading pane and no full-screen takeover. A second `Enter`
(or `Esc`) collapses it back to the list row.

Inside an expanded item:

- `content` renders as sanitized HTML with the §2 image policy applied — images
  suppressed unless the feed allows them or the user clicks "load images."
- Opening an item marks it read automatically (configurable). The expand action
  and the read-state toggle are independent: `r` toggles read without expanding,
  `Enter` expands and marks read.
- Type-specific affordances appear in the expanded view: `video` shows an
  embedded player (streamed, never cached); `podcast` shows an audio player;
  `paper` shows the full abstract plus a "save PDF" verb (v0.4 blob opt-in);
  `track` shows the full diff; `release` shows the full changelog body.
- Footer actions mirror the keyboard verbs: open original (`o`), save (`s`),
  archive (`e`), save-to-glass (export to Auditable Works per §7).

`j`/`k` while an item is expanded moves to the next/previous item and expands
it, collapsing the current one — so holding `j` walks you through items in
reading mode, one at a time. This is the primary "process the inbox" flow.

### Empty, loading & error states

- **First run** (no feeds): the stream shows an onboarding panel — import OPML,
  paste a feed URL, or add a source — instead of an empty list.
- **Empty view** (feeds exist, no matching items): a quiet "nothing here"
  placeholder naming the active view, not a blank pane.
- **Loading** (initial store read, or a poll in progress): the stream renders
  cached items immediately and shows poll progress in the status bar; it never
  blocks on the network.
- **Per-item parse error**: an item that failed to parse renders as a minimal
  error row (title if available, source, "couldn't parse — open original")
  rather than being silently dropped, so feed breakage is visible.

### Keyboard

A non-exhaustive starter set; full table lives in keybindings.md:

```
j / k       next / previous item
o           open original URL in new tab
r           toggle read
s           toggle saved
e           archive (bypass retention countdown, go immediately to archived)
g i         go to inbox
g w         go to work
g <feed>    go to feed (with autocomplete palette)
/ <query>   search
? help
```

Keyboard is first-class. Every action available via mouse should have a key.

### Status bar

Bottom strip, monospace, muted. Always shows: last-poll-time, next-poll-time,
bridge version, storage usage (bytes + percentage of quota). Surfaces what the
machine is doing without ceremony.

### Time display

Item timestamps render as relative time within the last 7 days ("2h ago", "3d
ago"), then switch to absolute dates ("May 12") for older items, then to
absolute date + year ("May 12, 2024") past the calendar year boundary. Hover
reveals the full ISO timestamp in the user's local timezone. Internally,
everything is epoch ms; timezone is purely a display concern.

### Visual language

Inherits the Switchboard design system: Barlow + Space Mono, semantic accents
on a dark base, flat surfaces, no decorative gradients. Sparklines and the
status bar are flight-deck instrumentation.

---

## 5. Storage & Offline

### Stages

The reader's storage strategy evolves over three releases, each a strict upgrade
without data migration pain:

**v0.1 — IndexedDB.**
- Object stores: `feeds`, `items`, `views`, `rules`, `settings`, `archived_index`.
- Manual prune button.
- `navigator.storage.persist()` requested on first run.
- Storage usage visible in status bar via `navigator.storage.estimate()`.

**v0.2 — OPFS for content.**
- IndexedDB stays as the index (queries, filtering, joins).
- Item content (the HTML body) moves to OPFS files keyed by `feed_id/item_id`.
- OPFS is more eviction-resistant than IDB and faster for large blobs.
- Backward compatible: items without OPFS content fall back to IDB `content` field.

**v0.3 — File System Access for user-visible archive.**
- User picks a directory once via `showDirectoryPicker()`.
- Reader writes feed items as files there in a documented layout (see below).
- The archive becomes auditable, syncable, backup-able with standard tools.
- IDB index still drives queries; FSA dir is the source of truth.

### File layout (v0.3)

```
~/weir-store/
├── feeds/
│   ├── arxiv-geo.json              # feed config + retention policy
│   └── arxiv-geo/
│       ├── 2026-05-23T14-22-12345.json    # item record
│       └── 2026-05-23T14-22-12345.html    # readable content
├── routing.js                      # routing rules as a JS file
├── views/
│   └── work-this-week.json
└── meta.json                       # index version, last-known good state
```

Filename format: `<ISO-timestamp>-<id-suffix>.{json,html}`. Sortable, greppable,
human-readable, no name collisions.

### Retention

Type defaults applied at item insert time, overridable per feed:

| Type      | Unread TTL  | Read TTL    | Saved      |
|-----------|-------------|-------------|------------|
| article   | 60 days     | 30 days     | forever    |
| video     | 30 days     | 14 days     | forever    |
| release   | forever     | forever     | forever    |
| paper     | forever     | forever     | forever    |
| status    | 14 days     | 7 days      | forever    |
| track     | last 50 snapshots per source                  |
| podcast   | 90 days metadata; enclosures never cached     |
| commit    | 30 days     | 14 days     | forever    |
| issue     | 90 days     | 30 days     | forever    |

Per-feed override is a single `retention` object on the feed config:

```json
{ "retention": { "unread_days": 90, "read_days": 60 } }
```

The retainer runs once daily (configurable) plus once on app open. Items
approaching expiry surface a countdown on hover ("expires in 4 days"). Manual
prune available always. Saved items bypass retention. Tagged items can bypass
retention via routing rule (`retain: forever`).

### Deduplication & the archived_index

Items are keyed by their stable `id` (§2). The poller must not re-insert an item
that already exists *or that the user has already seen and pruned* — otherwise
every poll resurfaces content you deliberately got rid of. Two checks guard
insertion:

1. **Live check.** If `items` already contains the `id`, the incoming item is a
   re-fetch. Update mutable fields (title, content if changed) but never reset
   `read`, `saved`, or `tags`.
2. **Archive check.** If the `id` appears in `archived_index`, the item was
   pruned after being read or expiring. Do not re-insert. (An exception: if the
   user explicitly "unarchives" a source or clears its history, the index entry
   for that feed is dropped and items can flow again.)

`archived_index` holds minimal tombstones, not full items:

```ts
interface ArchiveRecord {
  id: string;              // the pruned item's stable id
  feed_id: string;
  archived_at: number;     // epoch ms
  reason: 'expired' | 'pruned' | 'user';
}
```

This is deliberately tiny — a 50k-item history costs a few MB of tombstones, far
less than keeping the items themselves. The retainer writes a tombstone when it
removes an item; the poller reads the index on insert. The index itself is
subject to a soft cap (default: keep tombstones for 1 year, then forget — at
which point a very old item could theoretically re-surface, which is acceptable).

### Schema migration

IndexedDB schema changes ride `onupgradeneeded` with an integer version. Moving
content to OPFS (v0.2) and adding the FSA mirror (v0.3) are additive: existing
records keep their `content` field; new storage layers are read preferentially
with IDB `content` as fallback. No destructive migration in the v0.x line; any
post-v1.0 model change ships with an explicit migration step (§9).

### Offline behavior

The reader functions fully offline for reading items already in the store.
What requires network:

- Polling for new items (silently fails offline; resumes on reconnect)
- Loading external thumbnails (graceful degradation: placeholder shown)
- Following item URLs (browser handles)

What works offline:

- Reading any stored item content
- Searching, filtering, view switching
- Routing rule evaluation
- Marking read/saved/archived
- Importing OPML (it's local parsing)

The pinned-tab model keeps the JS in memory; FSA-backed storage means data
survives across browser restarts. A PWA shell (v0.4+) would enable true cold-
start offline; not committed for v0.1.

---

## 6. Routing Rules, Views & Search

Three related mechanisms for shaping how items surface: routing rules (applied
once at insert, mutate item state), views (named queries over the store), and
search (ad-hoc query against item text). All three share the same query
vocabulary where they overlap.

### Routing rules

A rule is plain JavaScript. Rules live in `routing.js`, which in v0.1 is stored
as a string in IndexedDB and `eval`d at app start; in v0.3 it becomes a real
file in the FSA-backed archive directory.

```js
// routing.js
export default [
  {
    name: 'arxiv-geo to work',
    when: (item) => item.feed === 'arxiv-physics.geo-ph'
                 && /kriging|variogram/i.test(item.title),
    then: { tag: ['work'], retain: 'forever' }
  },
  {
    name: 'framework videos',
    when: (item) => item.type === 'video'
                 && /framework/i.test(item.title),
    then: { tag: ['hardware'] }
  },
  {
    name: 'gentropic releases',
    when: (item) => /^gentropic\//.test(item.feed),
    then: { tag: ['gcu'], notify: true }
  },
];
```

**Rule shape.**

```ts
interface Rule {
  name: string;            // human-readable identifier; surfaced in debug logs
  when: (item: Item) => boolean;
  then: RuleAction | ((item: Item) => RuleAction);
  enabled?: boolean;       // default true
}

interface RuleAction {
  tag?: string[];          // accumulated across all matching rules
  retain?: 'forever' | number;   // number = days
  route?: string;          // surface in named view, hide from inbox
  mark?: ('read' | 'saved')[];
  notify?: boolean;        // surface in in-app notification panel; no system notif
}
```

**Evaluation.** All rules run on each new item *at insert time*. Tags accumulate
across matches. For conflicting scalar actions (`retain`, `route`), first match
wins. Predicate errors are caught, logged with the rule name, and the rule is
skipped — one broken rule never breaks the pipeline.

**Retroactivity.** Rules do not apply retroactively. Adding or editing a rule
affects only items inserted afterward — existing items keep whatever tags and
state they had. A manual "re-run rules over history" verb re-evaluates all
stored items against the current ruleset; it's an explicit action, not
automatic, because backfilling tags across a large store is both slow and
occasionally surprising (a new rule could silently retag thousands of old
items). The verb shows a preview count before committing.

**Editor UX.** The rules panel is a code editor (CodeMirror or equivalent) with
JS syntax highlighting and a "test against recent items" affordance that runs
the current draft against the last 100 items and shows which would match.

**Trust note.** Because rules are evaluated as JS, they execute with full page
power — DOM access, network via the bridge, the works. This is fine for a
single-user tool. Do not paste rules from strangers. The trust posture is
identical to running JS from your own browser console.

### Views

A view is a named query plus optional grouping and sort. Stored similarly to
rules — string in IDB in v0.1, file in v0.3.

```js
// views/work-this-week.js
export default {
  id: 'work-this-week',
  name: 'Work, this week',
  where: (item) => item.tags.includes('work')
                && item.fetched_at > Date.now() - 7 * 86400_000,
  group_by: 'feed',      // 'feed' | 'date' | 'type' | null
  sort: '-published_at', // - prefix = descending
};
```

Views are addressable via URL hash: `#view:work-this-week`. Bookmarking a view
URL works; sharing a view as a `.js` export works.

Built-in views — `inbox`, `saved`, `archived` — are not editable but can be
hidden from the rail. They're implemented in the same shape as user views,
just shipped with the app.

### Search

Two layers; both run client-side, both work offline.

**Structured search** rides on IndexedDB compound indexes. Queries like
"unread items from feed X in the last week" or "items tagged work this month"
are cursor scans against pre-defined indexes — fast at any reasonable scale,
no library needed. Indexes defined at schema time:

- `(feed_id, published_at)` — feed timeline queries
- `(read, published_at)` — global unread queries
- `(saved, published_at)` — saved items
- `(state, expires_at)` — retainer's working set
- `(type, published_at)` — type-scoped views

Routing's `where` predicates and views' filters both ultimately become some
combination of index scan plus in-memory filter. The view definition language
chooses which index to use based on the predicate shape.

**Text search** matches against the `search_text` field on each item
(lowercased title + author + excerpt, populated at insert). Two strategies,
staged:

- **v0.1 — cursor scan with substring match.** No library, no index. Iterate
  items via IDB cursor, match `search_text.includes(query)`. At 50k items × ~500
  bytes search_text, a full scan is ~100-200ms — slow but acceptable for
  type-and-enter search. Bad for as-you-type; v0.1 doesn't promise as-you-type.
- **v0.2 — MiniSearch in-memory index.** ~9KB embedded library, builds an
  inverted index from `search_text` on app start (cached across sessions in IDB).
  Supports ranking, fuzzy match, field weighting. Drop-in upgrade; no data
  migration since `search_text` already exists from v0.1.

The choice between v0.1 cursor scan and v0.2 MiniSearch is purely an
implementation swap behind a `searchItems(query)` interface. The data model
doesn't change.

`sql.js` / `wa-sqlite` with FTS5 was considered and rejected — the ~1MB binary
download violates the zero-deps single-file ethos. If text search needs grow
past MiniSearch's capabilities, that's a v1.x reconsideration.

---

## 7. Integration

Weir has three I/O surfaces. **Inbound fetching** goes through `@gcu/bridge`.
**Outbound collaboration** — sharing weir's catalog with, and ingesting work
from, an external agent — goes through the **Courier**. And **glass**, once
imagined here as an *external* "save to glass" handoff, has been internalized:
weir *is* the glass implementation (see GLASS.md). All three are loose couplings —
weir functions without any of them, just with degraded reach.

### Bridge

Weir is a consumer of `@gcu/bridge`. It is bridge's primary motivating use case
but not a coupled dependency — bridge ships and versions independently.

**Bridge requirements:**

- **v0.1.0+** required for basic fetch brokering.
- **v0.2.0+** strongly recommended for ETag/If-Modified-Since caching, which
  makes per-feed polling polite to upstreams. Without it, weir issues
  unconditional GETs every poll.

**Capability detection.** On first run, weir probes the bridge via `hasBridge()`
and `bridgeVersion()`:

- No bridge → banner explaining install; reader still works for CORS-friendly
  feeds (hnrss.org, some Atom endpoints) and for the scrape adapter's
  same-origin fallback.
- Bridge present but origin not allowed → banner explaining how to add the
  weir page's origin to the bridge allowlist.
- Bridge v0.1 → all good, but polling is non-conditional.
- Bridge v0.2+ → optimal.

**Origin.** If weir runs from `file://`, no allowlist action needed (covered
by bridge's static allowlist). If from `localhost` or a custom origin, the
user adds it once in bridge's options page.

### Glass — internalized, not a handoff

Earlier drafts of this section defined a one-way "Save to glass" handoff: weir →
Auditable Works over `BroadcastChannel('gcu-handoff')`, with an FSA Markdown
export to `exports/<ts>-<slug>.md` as fallback. **That design is retired.** Glass
is no longer an external app weir exports *to* — **weir is the glass
implementation.** The catalog (faceted classification, controlled vocabulary,
Dublin Core, the typed relation graph, the LLM cataloger-as-service) lives inside
weir; reading an item, writing a note, and adding it to the library are the same
act. The canonical design is **GLASS.md**, which supersedes this subsection.

An Auditable-based glass may still exist as a *second* implementation of the same
CC0 catalog-card format; the two interoperate through the card and can share one
FSA folder — but that is a peer implementation, not weir's "save" target.

### The Courier & webmcp — external agents

Weir's outward collaboration surface is the **Courier** (`src/js/courier.js`): an
optional, sync-agnostic, filesystem-backed exchange with an external agent
collaborator. Weir writes a curated slice to `out/` (controlled vocabulary as
SKOS/JSON-LD, recent deliberate captures, a mirror of the collaborator's own
notes as a tree) and ingests the agent's "dispatches" from `in/` — notes land in
the stacks vault as `author:<agent>` items; structural suggestions (e.g. a feed
to follow) arrive as **proposals the user ratifies** (decides-vs-proposes,
GLASS §2.1). The transport is the user's own infrastructure (Syncthing, etc.)
over a dedicated FSA handle — weir only reads and writes the folder; it operates
no sync protocol of its own. The generated `README.md` in that folder is the
self-describing protocol.

Separately, **`@gcu/webmcp`** exposes weir's catalog to *your* Claude as MCP
tools (query, catalog, vocabulary, recover, stacks…), so an agent can drive the
librarian — trigger cataloging, work the review queue, run reference queries —
without weir's core becoming agentic.

---

## 8. Non-Goals

The weir will not grow into any of these. If a use case demands them, the
right answer is a different tool, not the weir.

- **Server-side polling.** No daemon, no cron, no VPS. The reader is a document.
- **Multi-device sync as a built-in.** Sync happens via your file-system tools
  (rclone, syncthing, git) on the FSA directory. The reader doesn't operate a
  sync protocol of its own.
- **Audio/video caching.** Podcast enclosures, YouTube videos, etc. are never
  downloaded automatically. Streamed only.
- **Recommendations or algorithmic ranking.** Items appear in chronological
  order within their view. The router can hide or surface based on rules, but
  there's no "for you" reordering.
- **Notifications outside the app.** No browser notifications, no system tray.
  The `notify` action surfaces items in an in-app panel only.
- **Social features.** No sharing, no comments, no follows. The reader reads.
- **Markets / feed directories / discovery.** No browsable directory of feeds.
  Users add what they add.
- **Account system.** No login, no cloud, no telemetry.
- **Mobile.** Desktop, Chromium, pinned tab. A mobile companion is a separate
  project if it ever happens.
- **Per-item AI *generation* — summarization, rewriting, synthesis.** Still out
  of scope: weir does not produce prose for you, and there is no "for you"
  synthesis. Note the boundary, though — *cataloging* (classification into facets
  + Dublin Core, run as a bounded, auditable, human-correctable service) **is**
  now core via glass (GLASS.md §1.1). That is classification, not generation: the
  line glass draws is decides-vs-proposes — structured, inspectable records yes;
  opaque synthesis no.

---

## 9. Versioning & Roadmap

v0.x means the data model and routing rule shape may change with explicit
migration notes in CHANGELOG.md per release. v1.0 stabilizes both.

### v0.1 — Minimum useful reader

- Single HTML file, pinned tab
- `feed`, `youtube`, `scrape` adapters
- IndexedDB storage, manual prune
- Two-pane UI, type pills, source sparklines
- OPML import and export
- Keyboard navigation
- JS routing rules + built-in views (`inbox`, `saved`, `archived`)
- Cursor-scan text search
- Bridge v0.1+ as fetch primitive

### v0.2 — Production-feeling

- Retention rules engine with type defaults + per-feed overrides
- OPFS for content storage
- Bridge v0.2 integration (conditional GETs)
- MiniSearch index for fuzzy / ranked text search
- User-defined views with hash-URL addressing
- Auto-archive failing feeds after configurable threshold

### v0.3 — Files-on-disk

- File System Access integration
- User-visible archive directory
- `routing.js` and `views/` as real files in the directory
- Source health view (per-feed history, last-known-good state)

### v0.4 — Polish

- Additional adapters: arxiv, github, mastodon, bluesky
- Cross-source threading by URL
- PWA shell for cold-start offline
- Optional per-item "save PDF for offline" verb (opt-in blob storage)

### v1.0 — Stable

- Adapter API frozen
- Item and Feed models frozen
- Routing rule shape and view shape frozen
- Migration tooling for any post-v1.0 data model changes

Beyond v1.0 is genuinely open. The reader should be done at some point.

---

## 10. Open Questions

Not promises; the design is incomplete here.

- **Sync model.** Single-device is fine for one machine. What's the story for
  zero-gravitas + eventual Mac Studio? `@gcu/pointer` is the candidate primitive,
  but the read-state-as-CRDT problem is non-trivial. Alternative: lean on the
  v0.3 FSA directory + syncthing/rclone, treat the reader as offline-by-default
  with last-write-wins reconciliation. `Trystero` with paranoid encryption is a
  third option for live device-to-device sync; deferred until the need is real.

- **OPML import edge cases.** Your 1,249-entry OPML had 1,088 YouTube subs swept
  in. The importer needs to detect this and offer a separation pass: "import
  these 161 feeds as articles; import these 1,088 as YouTube subs in a separate
  bucket." Whether the YouTube subs become individual feeds (1,088 feeds) or a
  single grouped source ("YouTube subscriptions" with channels as facets) is a
  product question, not just an implementation detail.

- **Per-view vs per-item tag scope.** Tags are flat in this draft. Hierarchical
  tags (`work/geomet`, `work/bma`) might be worth it — or might be
  overengineering. Deferring.

- **Bridge-side caching vs weir-side caching.** Bridge v0.2 will cache by ETag.
  Weir also has its store. Do these duplicate? Probably not — bridge caches
  responses (the bytes), weir stores parsed Items (the structured data). But
  worth being explicit in the eventual integration spec.

- **`@gcu/glean` as a passive source.** The `scrape` adapter only handles
  pollable public pages (§3). Authenticated, personalized pages — favorites,
  wishlists, account views — need passive harvesting: a separate extension reads
  the DOM of pages you visit while logged in and stashes structured snapshots.
  Open question is the handoff: does glean write items directly into weir's
  store (tight coupling, shared schema), or expose a local feed weir polls
  (loose coupling, glean owns its own storage)? The loose-coupling version keeps
  both tools' trust stories clean and is probably right, but it's undesigned.

- **Feed health thresholds.** Sensible defaults exist (5 consecutive failures →
  failing, 14 days without success → archive candidate), but the numbers are
  guesses until observed against real feed behavior. Expect to revisit after a
  month of v0.1 use.

---

*End of spec.*
