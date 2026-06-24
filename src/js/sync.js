// weir sync engine (SYNC.md) — a provider-agnostic file sync between the local VFS and a
// remote one (a @gcu/vfs DropboxBackend in production; a memory VFS in tests). The engine
// never knows it's Dropbox — it copies files between two VFS trees, so Drive/OneDrive/WebDAV
// are later mounts, not rewrites.
//
// Efficiency (2d): a local MANIFEST (/sync-state.json, excluded) holds per-file signatures
// (so push skips unchanged files — a cheap stat, no read/upload) and the pull CURSOR. Pull is
// incremental when the remote backend exposes a change feed (Dropbox changes()/latestCursor()):
// after a one-time bootstrap it only fetches deltas. A backend with no change feed (the memory
// VFS in tests) falls back to a full content-compare mirror. Uploads run N-wide with retry so
// the first big push is fast + survives throttling.
//
// Deferred (SYNC.md §8): per-instance state/note delta-merge (2e) for clean concurrent
// read-state; cross-device deletion via tombstones (push never deletes remote today).

const SYNC_EXCLUDE = new Set(['/settings.json', '/usage.json', '/.health', '/sync-state.json']);
// Content is stored as per-feed PACKS (/content/<feed>.ndjson) — those DO sync: hundreds of
// files, offline-readable on the tablet. What stays OUT is any LEGACY per-item file
// (/content/<feed>/<item>.html — nested, pre-pack), so a feed that hasn't migrated yet can't
// drag thousands of files into the sync. After the one-time migration there are only packs.
function syncExcluded(p) {
  if (SYNC_EXCLUDE.has(p)) return true;
  return p.startsWith('/content/') && p.indexOf('/', 9) !== -1;   // nested under /content/ = legacy per-item file
}
// What a `reader` may PUSH — only its OWN deltas (notes/annotations under /stacks/), never the
// corpus (feeds/items/content/catalog/vocab). The hub is the corpus's single writer (SYNC.md §2);
// gating push here makes "a reader can't clobber the hub" true by construction, not by care.
// (Read/saved/tags state lives inside item shards = corpus, so it doesn't round-trip up yet.)
function syncReaderWritable(p) { return p.startsWith('/stacks/'); }
const MANIFEST_PATH = '/sync-state.json';   // the excluded marker: per-file push signatures + the pull cursor
const CHECKPOINT = 100;      // save the manifest every N transferred files, so an interrupted big sync RESUMES (only the not-yet-recorded files re-transfer)
const PROGRESS_EVERY = 25;   // emit a progress tick every N files
const PUSH_CONCURRENCY = 2;  // WRITES are what Dropbox throttles; keep the burst small so we trip the limit less (a 429 on a content endpoint is masked as a CORS throw, so the backend's Retry-After can't engage — see syncRetry)

// recursively list every file path under `dir` (directories are descended, not returned).
async function syncListTree(vfs, dir) {
  const out = [];
  let names; try { names = await vfs.readdir(dir); } catch { return out; }
  for (const name of names) {
    const p = dir === '/' ? '/' + name : dir + '/' + name;
    let st; try { st = await vfs.stat(p); } catch { continue; }
    if (st.type === 'directory') out.push(...(await syncListTree(vfs, p)));
    else out.push(p);
  }
  return out;
}

// the sync set for a tree: every file minus the device-local excludes.
async function syncCollectPaths(vfs) {
  return (await syncListTree(vfs, '/')).filter((p) => !syncExcluded(p));
}

// walk the tree once, calling onFile(path, stat) per non-excluded file — used by push so it
// stats every file a SINGLE time (and can report scan progress) instead of list-then-restat.
async function syncWalkStat(vfs, dir, onFile) {
  let names; try { names = await vfs.readdir(dir); } catch { return; }
  for (const name of names) {
    const p = dir === '/' ? '/' + name : dir + '/' + name;
    let st; try { st = await vfs.stat(p); } catch { continue; }
    if (st.type === 'directory') await syncWalkStat(vfs, p, onFile);
    else if (!syncExcluded(p)) onFile(p, st);
  }
}

function syncBytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// copy src:p → dst:p when dst is missing or differs (content-compare; the cursor-less fallback).
async function syncCopyIfDiffer(src, dst, p) {
  const data = await src.readFile(p, 'bytes');
  let cur = null; try { cur = await dst.readFile(p, 'bytes'); } catch { /* missing on dst */ }
  if (syncBytesEqual(cur, data)) return false;
  await syncEnsureParent(dst, p);
  await dst.writeFile(p, data);
  return true;
}

async function syncEnsureParent(vfs, p) {
  const slash = p.lastIndexOf('/');
  if (slash > 0) { try { await vfs.mkdir(p.slice(0, slash), { recursive: true }); } catch { /* exists */ } }
}

function syncSleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// bounded-concurrency runner — `concurrency` workers drain the items. Returns the count done.
async function syncPool(items, concurrency, fn) {
  let i = 0, done = 0;
  const worker = async () => { while (i < items.length) { const idx = i++; await fn(items[idx], idx); done++; } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker));
  return done;
}

// Categorize synced paths into human kinds for the activity readout, so "uploaded 3" reads as
// "items 2, catalog 1" — you can see WHAT moved, not just a count. Returns { total, byKind }.
function syncSummarize(paths) {
  const KIND = (p) => {
    if (p.startsWith('/items/')) return 'items';
    if (p.startsWith('/content/')) return 'content';
    if (p.startsWith('/catalog/')) return 'catalog';
    if (p.startsWith('/schema/')) return 'vocab';
    if (p.startsWith('/stacks/')) return 'notes';
    if (p.startsWith('/feeds/')) return 'feeds';
    if (p.startsWith('/archived')) return 'archive';
    return 'other';
  };
  const byKind = {};
  for (const p of paths || []) { const k = KIND(p); byKind[k] = (byKind[k] || 0) + 1; }
  return { total: (paths || []).length, byKind };
}
const syncKindLine = (s) => Object.entries(s.byKind || {}).map(([k, n]) => `${k} ${n}`).join(', ');

// Decide whether a push needs the full local FS re-scan. Skip it when nothing changed locally
// since the last push (rev unchanged) — avoids walking/statting the whole tree every cycle (the
// FS-hammer / AV smell). A periodic forced scan (every `forceEvery` cycles) is the safety net for
// any write path the mutation counter doesn't cover, so correctness never depends on it.
function syncShouldScan({ rev, lastRev, cycle = 0, forceEvery = 10, force = false }) {
  return !!force || rev !== lastRev || (cycle % forceEvery === 0);
}

// Dropbox's per-file content_hash: SHA-256 of each 4 MB block, then SHA-256 of the concatenated
// block digests, hex. Lets incremental pull recognize a remote file we ALREADY have byte-for-byte
// (our own upload echoed back through the change feed) and skip re-downloading it. A wrong hash
// only ever fails to skip (→ harmless re-download), never wrongly skips a real change.
async function syncDropboxContentHash(bytes) {
  const BLOCK = 4 * 1024 * 1024;
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  const digests = [];
  for (let off = 0; off < u8.length; off += BLOCK) {
    digests.push(new Uint8Array(await crypto.subtle.digest('SHA-256', u8.subarray(off, Math.min(off + BLOCK, u8.length)))));
  }
  const concat = new Uint8Array(digests.length * 32);
  digests.forEach((d, i) => concat.set(d, i * 32));
  const out = new Uint8Array(await crypto.subtle.digest('SHA-256', concat));
  let hex = ''; for (const b of out) hex += b.toString(16).padStart(2, '0');
  return hex;
}

// retry with backoff — Dropbox throttles a burst with 429s (surfaced as EIO by the backend).
// Dropbox throttles WRITES hard (too_many_write_operations / 429) on a big first push, and the
// backend surfaces it only as an error message (no Retry-After), so detect it and back off
// SECONDS, escalating — a single run RIDES OUT the throttle instead of aborting. Transient
// errors keep the quick (sub-second) ramp. `sleep` is injectable for tests.
// Long (seconds, escalating) backoff cases. Includes "failed to fetch": a Dropbox 429 on a content
// endpoint omits the CORS header, so the browser blocks it and `fetch` THROWS (TypeError "Failed to
// fetch") before the backend can read the 429 → its Retry-After backoff never engages. So we treat a
// thrown content request as a probable masked rate-limit and back off here. (A genuine offline error
// also lands here — backing off + failing gracefully is fine.)
const SYNC_RATE_RE = /too_many_(?:requests|write_operations)|rate.?limit|\b429\b|retry.?later|failed to fetch|load failed/i;
function syncIsRateLimit(e) { return !!(e && SYNC_RATE_RE.test(String((e && e.message) || e))); }
async function syncRetry(fn, tries = 6, sleep = syncSleep) {
  let err;
  for (let a = 0; a < tries; a++) {
    try { return await fn(); }
    catch (e) {
      err = e;
      if (a >= tries - 1) break;
      await sleep(syncIsRateLimit(e) ? Math.min(4000 * Math.pow(2, a), 60000) : Math.min(150 * Math.pow(4, a), 5000));
    }
  }
  throw err;
}

class SyncEngine {
  constructor({ local, remote, store = null, concurrency = 8, onProgress = null, role = 'hub' }) {
    this.local = local;            // weir's live VFS (store.vfs)
    this.remote = remote;          // the cloud VFS (DropboxBackend), or a memory VFS in tests
    this.store = store;            // optional — for the post-pull re-hydrate
    this.concurrency = concurrency;
    this._onProgress = onProgress; // optional ({phase, done, total}) → UI progress
    this.role = role;              // 'hub' (owns + pushes the corpus) | 'reader' (pushes only its own deltas)
    this._manifest = null;
  }

  // Manifest (persisted locally, excluded from sync): { cursor, files: { path: {size, mtime} } }.
  async _loadManifest() {
    if (this._manifest) return this._manifest;
    try { this._manifest = JSON.parse(await this.local.readFile(MANIFEST_PATH, 'utf8')); } catch { this._manifest = {}; }
    if (!this._manifest.files) this._manifest.files = {};
    return this._manifest;
  }
  async _saveManifest() { try { await this.local.writeFile(MANIFEST_PATH, JSON.stringify(this._manifest)); } catch { /* best effort */ } }
  _sig(st) { return { size: st.size || 0, mtime: st.modified ? +new Date(st.modified) : 0 }; }
  _changed(a, b) { return !a || a.size !== b.size || a.mtime !== b.mtime; }
  _progress(phase, done, total) { if (this._onProgress) { try { this._onProgress({ phase, done, total }); } catch { /* ignore */ } } }

  // the remote backend instance (for its change feed), via resolve() — mounts() only gives type.
  _remoteBackend() { try { return this.remote.resolve('/').backend; } catch { return null; } }
  // the local backend (for its bulk writeFiles) — the local store is the primary, un-cached mount,
  // so writing through it is layer-coherent (the facade reads the same bytes back on reload).
  _localBackend() { try { return this.local.resolve('/').backend; } catch { return null; } }
  // a Dropbox change-feed entry's path (e.g. /weir/items/x) → our VFS path (/items/x): strip root.
  _entryToVfsPath(be, e) {
    const root = (be && be._root) || '';
    const dp = e.path_display || e.path_lower || '';
    if (root && dp.toLowerCase().startsWith(root.toLowerCase() + '/')) return dp.slice(root.length);
    if (root && dp.toLowerCase() === root.toLowerCase()) return '/';
    return dp;
  }

  // local → remote: upload only files new/changed since last sync (cheap stat diff), N-wide
  // with retry. Does NOT delete remote files gone locally (needs tombstones, 2e; weir never-deletes).
  async push() {
    const man = await this._loadManifest();
    const toUpload = []; let scanned = 0;
    await syncWalkStat(this.local, '/', (p, st) => {
      scanned++;
      if (scanned % 256 === 0) this._progress('scan-local', scanned, 0);
      const sig = this._sig(st);
      if (this._changed(man.files[p], sig)) toUpload.push({ p, sig });
    });
    // Safe-by-construction: a `reader` pushes ONLY its own deltas (notes), never corpus — so even
    // if it adopted a stale store, it can't overwrite the hub's canon (the roles model, enforced).
    let heldForRole = 0;
    if (this.role === 'reader') {
      const before = toUpload.length;
      for (let i = toUpload.length - 1; i >= 0; i--) if (!syncReaderWritable(toUpload[i].p)) toUpload.splice(i, 1);
      heldForRole = before - toUpload.length;
    }
    let pushed = 0; const paths = [];
    this._progress('push', 0, toUpload.length);
    // Ensure each unique remote parent dir ONCE per session — not per file. Per-file mkdir fired ~1
    // create_folder_v2 per upload (all 409 "exists"), hammering Dropbox's rate limit → 429s whose
    // content-endpoint responses omit CORS headers → surfaced as a bogus "CORS blocked" on the next
    // files/upload. (Dropbox upload auto-creates parents anyway; FSA/memory need them — so we still
    // ensure, just deduped + cached for the engine's lifetime since weir never deletes remote dirs.)
    this._ensuredRemoteDirs = this._ensuredRemoteDirs || new Set();
    const toMk = new Set();
    for (const { p } of toUpload) { const s = p.lastIndexOf('/'); if (s > 0) { const d = p.slice(0, s); if (!this._ensuredRemoteDirs.has(d)) toMk.add(d); } }
    for (const dir of toMk) { try { await this.remote.mkdir(dir, { recursive: true }); } catch { /* exists */ } this._ensuredRemoteDirs.add(dir); }
    // Per-file `files/upload` (NOT batch `writeFiles` — Dropbox `upload_session/*` isn't CORS-enabled;
    // `files/upload` IS). The too_many_write_operations throttle is ridden out by the backend's
    // 429/Retry-After backoff in `_send` (vfs 0.3.0), so per-file at low concurrency is fine.
    await syncPool(toUpload, Math.min(this.concurrency, PUSH_CONCURRENCY), async ({ p, sig }) => {
      const data = await this.local.readFile(p, 'bytes');
      await syncRetry(() => this.remote.writeFile(p, data));
      man.files[p] = sig; pushed++; if (paths.length < 100) paths.push(p);   // sample for the activity readout
      if (pushed % CHECKPOINT === 0) await this._saveManifest();
      if (pushed % PROGRESS_EVERY === 0 || pushed === toUpload.length) this._progress('push', pushed, toUpload.length);
    });
    await this._saveManifest();
    return { pushed, skipped: scanned - toUpload.length, scanned, heldForRole, paths };
  }

  // remote → local. Three modes: incremental (have a cursor + a change feed), bootstrap (have a
  // feed, no cursor yet — fetch only files not already synced, then capture the cursor), or full
  // content-compare (no change feed — the memory/test path). Re-hydrates the store on changes.
  async pull() {
    const man = await this._loadManifest();
    const be = this._remoteBackend();
    const hasFeed = be && typeof be.changes === 'function' && typeof be.latestCursor === 'function';
    if (hasFeed && man.cursor) return this._incrementalPull(man, be);
    if (hasFeed) return this._bootstrapPull(man, be);
    return this._fullMirrorPull(man);
  }

  async _incrementalPull(man, be) {
    let cursor = man.cursor, pulled = 0, removed = 0, echoed = 0, more = true; const paths = [];
    while (more) {
      const res = await be.changes(cursor);
      for (const e of res.entries || []) {
        const p = this._entryToVfsPath(be, e);
        if (!p || p === '/' || syncExcluded(p)) continue;
        const tag = e['.tag'];
        if (tag === 'deleted') { try { await this.local.unlink(p); } catch { /* gone */ } delete man.files[p]; removed++; if (paths.length < 100) paths.push(p); continue; }
        if (tag !== 'file') continue;   // folder
        // Dropbox's change feed echoes our OWN uploads back. If the remote content_hash matches the
        // local file we already have, it's an echo (or already in sync) — record it synced and skip
        // the re-download / re-write / store reload entirely.
        if (e.content_hash) {
          try {
            const have = await this.local.readFile(p, 'bytes');
            if (await syncDropboxContentHash(have) === e.content_hash) { try { man.files[p] = this._sig(await this.local.stat(p)); } catch { /* */ } echoed++; continue; }
          } catch { /* local missing/unreadable → fall through and download */ }
        }
        const data = await syncRetry(() => this.remote.readFile(p, 'bytes'));
        await syncEnsureParent(this.local, p);
        await this.local.writeFile(p, data);
        try { man.files[p] = this._sig(await this.local.stat(p)); } catch { /* */ }
        pulled++; if (paths.length < 100) paths.push(p);
      }
      cursor = res.cursor; more = res.has_more;
      man.cursor = cursor; await this._saveManifest();        // checkpoint per page → resumable across pages
      this._progress('pull', pulled + removed);
    }
    if ((pulled || removed) && this.store && typeof this.store.reload === 'function') await this.store.reload();
    return { pulled, removed, echoed, mode: 'incremental', paths };
  }

  // First sync against a change-feed backend: download only files we haven't synced yet (so a
  // hub that just pushed everything downloads nothing — they're all in the manifest), then
  // capture the cursor so every later pull is an incremental delta.
  async _bootstrapPull(man, be) {
    this._progress('scan-remote', 0, 0);   // listing the remote tree can take a moment
    // Fast path: ONE recursive listTree sweep yields the whole tree (paths + content_hash) AND the
    // cursor — vs syncCollectPaths' readdir + per-file stat walk (~1 get_metadata per file, the
    // minutes-long "checking the cloud folder"). Falls back for backends without listTree.
    let toFetch, treeCursor = null;
    if (typeof be.listTree === 'function') {
      const tree = await be.listTree('/');
      treeCursor = tree.cursor;
      toFetch = (tree.entries || []).filter((e) => e.type === 'file' && !syncExcluded(e.path) && !man.files[e.path]).map((e) => e.path);
    } else {
      toFetch = (await syncCollectPaths(this.remote)).filter((p) => !man.files[p]);
    }
    let pulled = 0;
    this._progress('pull-first', 0, toFetch.length);
    const lbe = this._localBackend();
    if (lbe && typeof lbe.writeFiles === 'function') {
      // Batch the LOCAL writes too: download a chunk (bounded concurrency), then commit it to the
      // store in one op (one IDB transaction) — the local-write twin of the batched push. Download
      // still dominates a first sync, but this removes ~one tx per file on the phone. Bounded
      // memory (a chunk in flight).
      const CHUNK = 200;
      for (let i = 0; i < toFetch.length; i += CHUNK) {
        const slice = toFetch.slice(i, i + CHUNK);
        const files = [];
        await syncPool(slice, this.concurrency, async (p) => {
          try { files.push({ path: p, content: await syncRetry(() => this.remote.readFile(p, 'bytes')) }); } catch { /* skip a file that won't download; a later sync retries it */ }
        });
        await lbe.writeFiles(files);
        for (const f of files) { try { man.files[f.path] = this._sig(await this.local.stat(f.path)); } catch { /* */ } pulled++; }
        await this._saveManifest();
        this._progress('pull-first', pulled, toFetch.length);
      }
    } else {
      await syncPool(toFetch, this.concurrency, async (p) => {
        const data = await syncRetry(() => this.remote.readFile(p, 'bytes'));
        await syncEnsureParent(this.local, p);
        await this.local.writeFile(p, data);
        try { man.files[p] = this._sig(await this.local.stat(p)); } catch { /* */ }
        pulled++;
        if (pulled % CHECKPOINT === 0) await this._saveManifest();
        if (pulled % PROGRESS_EVERY === 0 || pulled === toFetch.length) this._progress('pull-first', pulled, toFetch.length);
      });
    }
    man.cursor = treeCursor || (await be.latestCursor().catch(() => null));   // listTree's cursor, else fall back
    await this._saveManifest();
    if (pulled && this.store && typeof this.store.reload === 'function') await this.store.reload();
    return { pulled, scanned: toFetch.length, mode: 'bootstrap', paths: toFetch.slice(0, 100) };
  }

  async _fullMirrorPull(man) {
    this._progress('scan-remote', 0, 0);
    const paths = await syncCollectPaths(this.remote);
    let pulled = 0;
    for (const p of paths) {
      if (!(await syncCopyIfDiffer(this.remote, this.local, p))) continue;
      pulled++;
      try { man.files[p] = this._sig(await this.local.stat(p)); } catch { /* */ }
    }
    if (pulled) { await this._saveManifest(); if (this.store && typeof this.store.reload === 'function') await this.store.reload(); }
    return { pulled, scanned: paths.length, mode: 'full' };
  }
}

export { SyncEngine, syncCollectPaths, syncCopyIfDiffer, syncListTree, syncBytesEqual, syncPool, syncRetry, syncIsRateLimit, syncShouldScan, syncSummarize, syncKindLine, syncDropboxContentHash, syncReaderWritable, SYNC_EXCLUDE };
