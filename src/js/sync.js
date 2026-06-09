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
// Whole subtrees kept OUT of sync. /content holds one HTML file per item (~12.8k for a big
// corpus) — the bulk of the file count, and re-fetchable on demand (getContent re-derives) —
// so we sync the INDEX (feeds, item shards, catalog, vocab, notes), not the article bodies.
// Packing those bodies into per-feed shards so they CAN sync (for offline reading) is a
// deliberate follow-up; until then a reader fetches a body when it opens the item.
const SYNC_EXCLUDE_PREFIXES = ['/content/'];
function syncExcluded(p) { return SYNC_EXCLUDE.has(p) || SYNC_EXCLUDE_PREFIXES.some((pre) => p.startsWith(pre)); }
const MANIFEST_PATH = '/sync-state.json';   // the excluded marker: per-file push signatures + the pull cursor
const CHECKPOINT = 100;      // save the manifest every N transferred files, so an interrupted big sync RESUMES (only the not-yet-recorded files re-transfer)
const PROGRESS_EVERY = 25;   // emit a progress tick every N files

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

// retry with backoff — Dropbox throttles a burst with 429s (surfaced as EIO by the backend).
async function syncRetry(fn, tries = 3) {
  let err;
  for (let a = 0; a < tries; a++) { try { return await fn(); } catch (e) { err = e; if (a < tries - 1) await syncSleep(150 * Math.pow(4, a)); } }
  throw err;
}

class SyncEngine {
  constructor({ local, remote, store = null, concurrency = 8, onProgress = null }) {
    this.local = local;            // weir's live VFS (store.vfs)
    this.remote = remote;          // the cloud VFS (DropboxBackend), or a memory VFS in tests
    this.store = store;            // optional — for the post-pull re-hydrate
    this.concurrency = concurrency;
    this._onProgress = onProgress; // optional ({phase, done, total}) → UI progress
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
      if (scanned % 256 === 0) this._progress('scan', scanned, 0);
      const sig = this._sig(st);
      if (this._changed(man.files[p], sig)) toUpload.push({ p, sig });
    });
    let pushed = 0;
    this._progress('push', 0, toUpload.length);
    await syncPool(toUpload, this.concurrency, async ({ p, sig }) => {
      const data = await this.local.readFile(p, 'bytes');
      await syncEnsureParent(this.remote, p);
      await syncRetry(() => this.remote.writeFile(p, data));
      man.files[p] = sig; pushed++;
      if (pushed % CHECKPOINT === 0) await this._saveManifest();
      if (pushed % PROGRESS_EVERY === 0 || pushed === toUpload.length) this._progress('push', pushed, toUpload.length);
    });
    await this._saveManifest();
    return { pushed, skipped: scanned - toUpload.length, scanned };
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
    let cursor = man.cursor, pulled = 0, removed = 0, more = true;
    while (more) {
      const res = await be.changes(cursor);
      for (const e of res.entries || []) {
        const p = this._entryToVfsPath(be, e);
        if (!p || p === '/' || syncExcluded(p)) continue;
        const tag = e['.tag'];
        if (tag === 'deleted') { try { await this.local.unlink(p); } catch { /* gone */ } delete man.files[p]; removed++; continue; }
        if (tag !== 'file') continue;   // folder
        const data = await syncRetry(() => this.remote.readFile(p, 'bytes'));
        await syncEnsureParent(this.local, p);
        await this.local.writeFile(p, data);
        try { man.files[p] = this._sig(await this.local.stat(p)); } catch { /* */ }
        pulled++;
      }
      cursor = res.cursor; more = res.has_more;
      man.cursor = cursor; await this._saveManifest();        // checkpoint per page → resumable across pages
      this._progress('pull', pulled + removed);
    }
    if ((pulled || removed) && this.store && typeof this.store.reload === 'function') await this.store.reload();
    return { pulled, removed, mode: 'incremental' };
  }

  // First sync against a change-feed backend: download only files we haven't synced yet (so a
  // hub that just pushed everything downloads nothing — they're all in the manifest), then
  // capture the cursor so every later pull is an incremental delta.
  async _bootstrapPull(man, be) {
    this._progress('scan', 0, 0);   // walking the remote tree (Dropbox list calls) can take a moment
    const paths = (await syncCollectPaths(this.remote)).filter((p) => !man.files[p]);
    let pulled = 0;
    this._progress('pull', 0, paths.length);
    await syncPool(paths, this.concurrency, async (p) => {
      const data = await syncRetry(() => this.remote.readFile(p, 'bytes'));
      await syncEnsureParent(this.local, p);
      await this.local.writeFile(p, data);
      try { man.files[p] = this._sig(await this.local.stat(p)); } catch { /* */ }
      pulled++;
      if (pulled % CHECKPOINT === 0) await this._saveManifest();
      if (pulled % PROGRESS_EVERY === 0 || pulled === paths.length) this._progress('pull', pulled, paths.length);
    });
    try { man.cursor = await be.latestCursor(); } catch { /* leave null — retries as bootstrap */ }
    await this._saveManifest();
    if (pulled && this.store && typeof this.store.reload === 'function') await this.store.reload();
    return { pulled, scanned: paths.length, mode: 'bootstrap' };
  }

  async _fullMirrorPull(man) {
    this._progress('scan', 0, 0);
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

export { SyncEngine, syncCollectPaths, syncCopyIfDiffer, syncListTree, syncBytesEqual, syncPool, syncRetry, SYNC_EXCLUDE };
