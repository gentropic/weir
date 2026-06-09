# SYNC.md — weir multi-device sync (roles + a mounted cloud backend)

Status: **design, not built.** This is the "third option for live-ish device-to-device
sync" that SPEC §10 deferred "until the need is real." The need is now real: reading +
note-taking on a **tablet** (a Galaxy S10 FE, `reasonable-excuse`) against the corpus
fetched on the **desktop** (`zero-gravitas`). This doc specs how — minimally, and in a
shape the **roles** model keeps tractable.

It does **not** replace weir's existing stance (sync is your FS tools on the FSA folder,
no protocol of weir's own). It *adds* a second tier for where that stance breaks.

---

## 1. Two tiers — keep the free one, add a cloud one

| | local store | sync mechanism | weir code |
|---|---|---|---|
| **Desktop ↔ desktop** | FSA-mounted folder | your Dropbox/Syncthing/iCloud **daemon** mirrors the folder | **none** (works today) |
| **Tablet / phone / pure-cloud** | IndexedDB / OPFS | a **mounted Dropbox VFS backend** + weir sync engine | backend → `@gcu/vfs`; mount + engine + auth → weir |

Why the desktop trick can't carry mobile: it relies on a desktop **daemon** continuously
mirroring a local folder. Mobile Dropbox (and iCloud/Drive) is **cloud-on-demand** — there
is no continuously-synced local folder for a web app to mount. (Note: Chrome Android *did*
ship the FSA pickers + persistent handles in **Chrome 132, Jan 2025** — caniuse lags on
this — so the limit is *not* "no picker." It's that there's no synced local folder to pick,
and Android backs handles with **SAF `content://` URIs** that **don't support atomic
writes/renames** — so a picked folder can't safely be weir's store anyway; keep the mobile
local store on **IndexedDB/OPFS**. SAF *can* reach Dropbox's DocumentsProvider, but that's
a fragile, non-atomic, Android-only round-trip to the cloud.) So a tablet should talk to
the cloud **API** directly: Dropbox v2 is CORS-enabled with a browser **PKCE** OAuth flow
(no client secret, no proxy, no `@gcu/bridge`, no server) — feasible in mobile Chrome.

The FSA-into-your-sync-folder path **stays** as the zero-config desktop option. The cloud
sync engine also works on desktop, so it doubles as the *one-mechanism-everywhere* choice.

---

## 2. Roles — the load-bearing simplification

Multi-master sync (every instance fetches + writes everything) is the hard problem. We
sidestep it: **one instance is authoritative for fetching.**

- **`hub`** (authoritative — `zero-gravitas`): the only instance that **polls, runs
  adapters, catalogs, recovers**. It **owns the corpus** — feeds, items, item content,
  catalog cards, vocabulary. **Single writer for corpus data → no corpus conflicts, ever.**
- **`reader`** (satellite — `reasonable-excuse`, the tablet): **never polls**. Reads the
  synced corpus; writes only its **own small deltas** — read/saved/tags state and
  notes/annotations.

This maps cleanly onto weir's existing **poll/read split** and **decides-vs-proposes**
(GLASS §2.1): the satellite *proposes* (notes, state, later: "add this feed" / "catalog
this"); the hub's corpus is *decided*. It turns the conflict surface from "two machines
racing on the whole store" into "two people editing small, mostly-disjoint delta files" —
which weir's existing **dedup + tombstone + never-reset** guards already largely reconcile.

`role` + `instance_id` are per-install settings (Settings → Sync). A fresh install
defaults to `hub`; a `reader` with no hub yet shows an empty corpus until it syncs one.

---

## 3. What syncs, and who writes it

- **Corpus** — `feeds.json`, per-feed item shards, lazy per-item content files, catalog
  shards, vocab. **Hub writes; satellites read-only.** Single-writer ⇒ conflict-free.
- **State deltas** — per-item `read`/`saved`/`tags`. Each instance writes its **own**
  delta file (`state/<instance_id>.json`: `item_id → { read, saved, tags, at }`). On
  hydrate, **union** all deltas, latest-`at`-per-field wins; the existing never-reset guard
  stops a stale delta from un-reading/un-saving. The hub may periodically fold deltas into
  the canonical item records and prune. Per-instance files ⇒ writers never collide.
- **Notes / annotations** — stacks notes + W3C annotations have stable ids; each instance
  writes its own (a per-instance notes area, or globally-unique ids). **Union by id** on
  hydrate. Append-y + unique ids ⇒ no conflict.

So the only *multi-writer* data is small, per-instance-filed, and last-writer-wins-safe.

---

## 4. A `DropboxBackend`, mounted (the VFS is built for this) + a weir-side sync engine

The VFS already ships exactly the machinery for this: `BACKEND_TYPES` includes **`fetch`,
`rest`** (remote backends), **`overlay`** (union), and **`cache`** (a local read-through
cache over a slow backend) — and `_createBackend` accepts a `Backend` instance *or any
duck-typed object with `readFile`/`stat`* as a mount. So Dropbox is a **sibling backend,
mounted via the mount table** — the designed path, not a novelty. (Mounting it as the
*primary* store at `/` would be wrong — a network hit per read — but that's not the plan.)

- **`DropboxBackend`** — implements the Backend interface (`readFile`/`writeFile`/`readdir`/
  `stat`/`remove`/`mkdir`) over the Dropbox HTTP API (`files/upload`, `download`,
  `list_folder`[`/longpoll`], `delete`), app-folder-relative, with the PKCE token injected
  via config (a `getToken()` callback). A peer of `rest`/`fetch`. (CORS-clean, no proxy —
  proven by `examples/dropbox-spike.html`.)
- **Mount it as a *secondary* mount, not the live store.** Mount at `/mnt/dropbox`; the
  local store stays at `/` (IDB/OPFS). The sync engine copies between `/` and `/mnt/dropbox`.
  **Or** wrap it in the existing **`cache`** backend for an offline-first *cached* mount
  (reads hit the local cache; only misses + writes touch the network) — the cleaner
  long-term shape, and the VFS already provides it.
- **Provider-agnostic by construction** — the sync engine copies `/` ↔ `/mnt/<provider>`;
  Drive/OneDrive/WebDAV become other mounted backends with **zero** sync-engine change.
- **App structure — ONE GCU Dropbox app, subtrees by `root`.** Register a *single* app
  ("GCU", App-folder access → `/Apps/GCU/`); each surface mounts its **subtree** via the
  backend's `root` (weir `root:'/weir'` → `/Apps/GCU/weir`; auditable `root:'/auditable'`).
  Win: **one OAuth consent per *device*** covers all GCU surfaces (vs one-per-surface). The
  app key is a **public PKCE `client_id` — not a secret** — embedded in each *consumer's*
  OAuth code (weir, auditable), **never in `@gcu/vfs`** (the backend only sees `getToken()`'s
  output). Committing it is safe: a stranger can't get tokens with it (the auth code only
  reaches *your* registered redirect URIs). Trade-off: a GCU-app token can reach the whole
  `/Apps/GCU/` tree (shared grant) — fine for first-party surfaces + your own data. **Escape
  hatch:** a surface that must be isolated (untrusted/shared) gets its *own* app (`root:''` +
  its own key). *(Quota/identity is pooled under the one app — a scaling knob only if GCU ever
  has many users, not a personal-use concern.)*
- **Where it lives → `@gcu/vfs`, via `spec_inbox`.** `DropboxBackend` is a reusable VFS
  backend (a peer of `rest`/`fetch`) and **auditable will want sync too**, so its home is
  `@gcu/vfs`'s `BACKEND_TYPES`, *not* weir-local. Hand it off: a spec → `../auditable/
  spec_inbox/`, auditable's Claude implements it, both apps re-vendor `vfs.js`. **Never a
  concurrent edit of `../auditable`.** *(The duck-typed-mount escape hatch means weir could
  prototype a local `DropboxBackend` first to validate the design — then promote it upstream
  — but the home is the VFS.)*

What stays **weir-side** (its domain, not the backend's): the **PKCE auth** (acquire the
token → inject as the backend's `getToken`), the **mount wiring**, the **`hub`/`reader`
roles**, and the **sync orchestration + feed-aware merge** below:
- **Push** — debounced copy of files the **store** already flags dirty (`_markCardDirty`/
  `_markFeedDirty` + shard flush) from `/` to `/mnt/dropbox`.
- **Pull** — a stored `list_folder` cursor + `longpoll` → copy changed shards/deltas from
  `/mnt/dropbox` into `/` → re-hydrate the affected slice.

---

## 5. Sync mechanics

- **Pull:** a stored `list_folder` **cursor** + `longpoll` for near-real-time → fetch
  changed shards/deltas → merge into the local VFS → re-hydrate the affected slice.
- **Push:** debounced upload of *dirty* files. The hub uploads corpus shards as it polls/
  catalogs; a satellite uploads its `state/<id>.json` + note files on change.
- **Merge-on-hydrate:** existing dedup/tombstone/never-reset reconciles the corpus; union
  state deltas (latest-`at` per field); union notes by id.
- **Conflict backstop:** Dropbox **"conflicted copy"** files — detect on listing, fold them
  (union deltas, keep both notes). With roles, true conflicts are rare: corpus has one
  writer, and deltas are per-instance files that never collide.

---

## 6. Ethos

Opt-in — IndexedDB local-first stays the **default**. It's **your** account and **your**
Dropbox app-folder: still **no weir server, no weir account, no telemetry** — "bring your
own cloud," not "weir's cloud." App-folder-scoped (least-privilege, inspectable). The
desktop FSA-folder option remains for those who don't want any account.

---

## 7. Scope / sequencing

- **v1** — **`DropboxBackend`** in `@gcu/vfs` (via `../auditable/spec_inbox/`) · weir mounts
  it at `/mnt/dropbox` (optionally `cache`-wrapped) · PKCE app-folder auth · `hub`/`reader`
  roles ·
  corpus read-only on satellites · `state/<id>.json` deltas · note sync · merge-on-hydrate
  · longpoll pull · debounced push.
- **Deferred** — reader→hub **proposals** (a satellite queues "add feed" / "catalog this"
  for the hub to enact, decides-vs-proposes) · other providers (Drive/OneDrive/WebDAV) ·
  true real-time multi-master (probably never — the role split is the better answer).

See also: SPEC §10 (the original deferral), the Courier (`src/js/courier.js`, the *other*
sync-agnostic exchange seam), STACKS.md (notes/annotations are the satellite's main output).
