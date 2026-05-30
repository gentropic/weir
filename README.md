# @gcu/weir

A unified reader for timestamped streams — RSS, Atom, JSON Feed, YouTube, GitHub,
arXiv, scraped pages, anything that produces dated items on a schedule. Local-first,
eviction-resistant, browser-native. Part of the Geoscientific Chaos Union toolkit.

**Status: v0.1 — early implementation.** Storage foundation built (VFS-backed
store, dedup, retention fields, cursor-scan search) and wired into a single-file
shell; adapters, the poller, and the UI stream are next.

[SPEC.md](SPEC.md) is the canonical design intent; everything in §9's v0.1 list
is the build target. Build the app with `node build.js` (→ `weir.html`); run it
over a local origin with `npm run serve` → `http://localhost:8017/weir.html`.

## Why "weir"?

A weir is a low barrier across a stream that controls flow without fully blocking
it — and, when calibrated, a weir is also how you *measure* flow. Both purposes
apply. Routing rules and retention control which items pass through to which views
and which survive over time; source sparklines and storage gauges measure the
streams you're channeling. The metaphor covers control and observation in one word.

## What's here

```
weir/
├── README.md              ← you are here
├── SPEC.md                ← full design spec (data model, adapters, storage, UI)
├── CHANGELOG.md
├── LICENSE                ← MIT
├── .gitignore
├── vendor/                ← vendored-as-source from @gcu/auditable (VFS, Switchboard tokens + fonts)
└── examples/
    └── weir-mockup.html   ← interactive two-pane UI mockup (open in a browser)
```

## The idea, briefly

The conceptual core of a feed reader isn't "parse RSS" — it's *things that arrive
on a schedule, surfaced in one place*. Weir treats source format as an **adapter**
concern, not a UX concern. A YouTube channel, an arXiv category, a GitHub release
feed, and a watched web page are all the same shape underneath: a stream of typed,
dated items. The UI renders by type; the adapters handle ingest.

Design commitments:

- **Single-file, zero-dependency** HTML app, runs in a pinned browser tab.
- **Local-first storage** — IndexedDB now, OPFS and File System Access later, so
  your archive outlives the tool and you can `cd` into it.
- **Inbox-shaped**, not stream-shaped. You process it and clear it; you don't
  scroll it forever. Items age out by retention rules.
- **No server, no account, no telemetry, no sync protocol of its own.** Sync, if
  ever, rides on file-system tools over the v0.3 archive directory.

## Architecture (short version)

Four internal subsystems over a shared store: **adapters** (match URLs to source
types, parse responses into items), **poller** (schedules fetches via the bridge),
**retainer** (applies retention policy), **router** (evaluates JS rules on each new
item). Fetching goes through [`@gcu/bridge`](https://github.com/gentropic/bridge),
which handles CORS and, from v0.2, conditional GETs.

See [SPEC.md §1](SPEC.md) for the full picture.

## Relationship to @gcu/bridge

Weir is bridge's primary motivating consumer but not coupled to it — bridge ships
and versions independently. Without the bridge, weir still reads CORS-friendly
feeds and already-stored items; with it, weir can fetch anything. Bridge v0.2+ adds
ETag/If-Modified-Since caching, which makes polite per-feed polling possible.

## Building

`node build.js` inlines the `src/` ES modules, the vendored VFS, and the
Switchboard tokens + base64 fonts into a single self-contained `weir.html`. No
npm install, no dependencies. `npm run serve` hosts it over `http://localhost`
(a stable origin, so IndexedDB/persistence work). `npm run smoke` runs the store
and VFS round-trip tests in node.

The v0.1 target (SPEC.md §9): `feed` + `youtube` + `scrape` adapters, local-first
storage with manual prune, the two-pane UI in the mockup, OPML import/export,
keyboard navigation, JS routing rules, and cursor-scan search. **Done so far:**
the VFS-backed store (schema, dedup + tombstone resurrection guard, retention
fields, cursor-scan search) and the buildable two-pane shell.

## License

[MIT](LICENSE) © Arthur Endlein Correia. Consistent with the rest of the GCU
toolkit (which weir vendors from). Vendored fonts (Barlow, Space Mono) are under
the SIL Open Font License — see `vendor/` for attribution.
