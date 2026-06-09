# SYNC.md — weir multi-device sync (roles + a cloud VFS backend)

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
| **Tablet / phone / pure-cloud** | IndexedDB / OPFS | a **cloud VFS backend** (Dropbox first), browser → cloud API | the new backend |

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
backend also works on desktop, so it doubles as the *one-mechanism-everywhere* choice.

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

## 4. The cloud VFS backend (Dropbox = impl #1)

weir's storage is already a VFS with swappable backends (IndexedDB default, FSA optional).
A cloud backend is a third impl — it does **not** change the store, hydrate, or
packed-shard layers above it.

- **API:** `files/upload`, `files/download`, `files/list_folder`(`/continue`,`/longpoll`),
  `files/delete`. (Dropbox is CORS-clean — direct `fetch` from the page.)
- **Auth:** PKCE OAuth (S256, no secret) → short-lived token + refresh token, scoped to a
  Dropbox **App folder** (`/Apps/weir`, sandboxed). Least-privilege: weir can't see the
  rest of your Dropbox — on-brand for *auditable by construction*.
- **It's a sync target, not the live store.** Local reads/writes stay on IndexedDB/OPFS
  (no per-read network hit); the cloud holds the packed shards + delta/note files. weir's
  in-memory index hydrates locally, as today.
- **Generalize later, not on n=1.** Extract a `RemoteBackend` interface once a *second*
  provider (Drive / OneDrive / WebDAV / S3) actually shows up. Dropbox-specific first.

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

- **v1** — Dropbox `RemoteBackend` + PKCE app-folder auth · `hub`/`reader` roles ·
  corpus read-only on satellites · `state/<id>.json` deltas · note sync · merge-on-hydrate
  · longpoll pull · debounced push.
- **Deferred** — reader→hub **proposals** (a satellite queues "add feed" / "catalog this"
  for the hub to enact, decides-vs-proposes) · other providers (Drive/OneDrive/WebDAV) ·
  true real-time multi-master (probably never — the role split is the better answer).

See also: SPEC §10 (the original deferral), the Courier (`src/js/courier.js`, the *other*
sync-agnostic exchange seam), STACKS.md (notes/annotations are the satellite's main output).
