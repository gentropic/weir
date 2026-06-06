# @gcu/weir

A unified reader for timestamped streams — RSS, Atom, JSON Feed, YouTube, GitHub,
USGS gauges, scraped pages, anything that produces dated items on a schedule —
that grew into a **self-cataloging library**. Local-first, eviction-resistant,
browser-native, single-file. Part of the Geoscientific Chaos Union toolkit.

**Status: a mature, running app.** The feed pipeline, the workspace UI, the LIS
catalog (*glass*), the notes vault (*stacks*), full-text search, feed recovery,
and an optional agent-exchange surface (*the Courier*) are all built and shipping.
Built with `node build.js` (→ a single self-contained `index.html`); run over a
local origin with `npm run serve` → `http://localhost:8017/`.

[SPEC.md](SPEC.md) is the canonical design intent for the reader; [GLASS.md](GLASS.md)
specifies the catalog; [STACKS.md](STACKS.md) the notes vault; [ROADMAP.md](ROADMAP.md)
tracks where things are heading.

## Why "weir"?

A weir is a low barrier across a stream that controls flow without fully blocking
it — and, when calibrated, a weir is also how you *measure* flow. Both purposes
apply. Routing rules and retention control which items pass through to which views
and which survive over time; source sparklines and storage gauges measure the
streams you're channeling. The metaphor covers control and observation in one word.

## The idea, briefly

The conceptual core of a feed reader isn't "parse RSS" — it's *things that arrive
on a schedule, surfaced in one place*. Weir treats source format as an **adapter**
concern, not a UX concern. A YouTube channel, a GitHub release feed, a USGS river
gauge, and a watched web page are all the same shape underneath: a stream of typed,
dated items. The UI renders by type; the adapters handle ingest.

Then weir keeps going. A durable, deduped, never-deleted, full-content archive of
timestamped material *is already the hard part of a knowledge base* — so weir
catalogs it. The line between reading an item, taking a note, and adding to the
library disappears: you read or write, a librarian processes it, and it's in the
catalog. That layer is **glass** (below).

Design commitments:

- **Single-file, zero-dependency** HTML app, runs in a pinned browser tab. The
  shipped artifact is one `index.html`; the dev tree is ES modules under `src/`,
  inlined by a zero-dep build step.
- **Local-first storage** — IndexedDB by default, or mount a real directory via
  the File System Access API, so your archive outlives the tool and you can `cd`
  into it.
- **Inbox-shaped**, not stream-shaped. You process it and clear it; you don't
  scroll it forever. Items age out by retention rules — and retention *archives*,
  never deletes.
- **No server, no account, no telemetry.** Sync, if you want it, rides on your own
  file-system tools over the mounted directory.

## What's here

```
weir/
├── README.md              ← you are here
├── SPEC.md                ← the reader: data model, adapters, storage, UI
├── GLASS.md               ← the catalog: faceted classification, vocabulary, the cataloger
├── STACKS.md              ← the notes/files vault
├── ROADMAP.md             ← where it's heading
├── CHANGELOG.md
├── LICENSE                ← MIT
├── build.js               ← zero-dep build → index.html
├── index.html             ← the shipped single-file app
├── src/                   ← ES-module dev tree (adapters, store, ui, glass, courier, …)
├── tools/                 ← build helpers + the smoke-test suite
├── vendor/                ← vendored-as-source from @gcu/auditable (VFS, rails, librarian, Switchboard)
└── examples/
    └── weir-mockup.html   ← the original two-pane UI mockup
```

## The subsystems

Over a shared **VFS-backed store** (IndexedDB default, FSA-mountable):

- **Adapters** match URLs to source types and parse responses into items —
  `feed` (RSS/Atom/JSON Feed), `youtube`, `github`, `usgs` (a `scrape` adapter
  for watched pages is designed but not yet built).
- **Poller** schedules polite per-feed fetches; **router** runs plain-JS rules on
  each new item; **retainer** applies retention (archive, never delete).
- **The UI** is a [`@gcu/rails`](https://github.com/gentropic/auditable) workspace —
  a movable stream pane alongside side-by-side note editors. Keyboard-first, with a
  command palette and a flight-deck status bar.
- **glass** — the catalog. weir is a library-science knowledge base: faceted
  classification, a SKOS controlled vocabulary, Dublin Core metadata, a typed
  relation graph, and an LLM **cataloger-as-service** (a bounded, auditable,
  human-correctable call — not an agent). Catalog by hand, or let a local/cloud
  model facet the whole corpus. See [GLASS.md](GLASS.md).
- **stacks** — a notes-and-files vault; notes and W3C-style annotations are
  first-class library items that catalog alongside everything else.
- **Search** — full-corpus text search on a lean in-memory index
  ([`@gcu/librarian`](https://github.com/gentropic/auditable)).
- **Recovery** — rebuild dead or truncated feed history from the Wayback Machine.
- **The Courier** — an optional, sync-agnostic, filesystem-backed exchange that
  shares weir's curated catalog with an external agent collaborator and ingests
  their work back in. See *Integration* below.

## Fetching: @gcu/bridge

Fetching goes through [`@gcu/bridge`](https://github.com/gentropic/bridge), a
sideloaded Chromium extension that brokers CORS-restricted fetches for allowlisted
origins (and, with v0.2+, conditional GETs for polite polling). Weir is bridge's
primary motivating consumer but not coupled to it — bridge ships and versions
independently. Without the bridge, weir still reads CORS-friendly feeds and
already-stored items; with it, weir can fetch anything.

## Integration & external agents

Two optional outward surfaces, both off by default:

- **The Courier** — weir writes a curated slice of the catalog (controlled
  vocabulary as SKOS/JSON-LD, recent deliberate captures, a mirror of the
  collaborator's notes) to a folder, and ingests an external agent's "dispatches"
  back: notes land in the vault; structural suggestions arrive as **proposals you
  ratify**. The transport is your own infrastructure (Syncthing, rclone, git) over
  a directory weir reads and writes — weir runs no sync protocol of its own.
- **`@gcu/webmcp`** exposes the catalog to your Claude as MCP tools, so an agent
  can drive the librarian — trigger cataloging, work the review queue, run
  reference queries — without weir's core ever becoming agentic.

> Earlier drafts described a one-way "save to glass" handoff to a separate
> Auditable Works app. That's retired — **weir *is* the glass implementation.**
> See [SPEC.md §7](SPEC.md).

## Building

`node build.js` inlines the `src/` ES modules, the vendored modules (VFS, rails,
librarian, Switchboard tokens), and base64 fonts into a single self-contained
`index.html`. No npm install, no runtime dependencies. `npm run serve` hosts it
over `http://localhost:8017/` (a stable origin, so persistence works). `npm run
smoke` runs the logic test suite (store, adapters, glass, courier, search, …) in
node.

## License

[MIT](LICENSE) © Arthur Endlein Correia. Consistent with the rest of the GCU
toolkit (which weir vendors from). Vendored fonts (Barlow, Space Mono) are under
the SIL Open Font License — see `vendor/` for attribution.
