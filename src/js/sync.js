// weir sync engine (SYNC.md) — Move 2: a provider-agnostic file MIRROR between the local
// VFS and a remote one (a cache-wrapped @gcu/vfs DropboxBackend in production; a memory VFS
// in tests). The engine never knows it's Dropbox — it copies files between two VFS trees,
// so Drive/OneDrive/WebDAV are later mounts, not rewrites.
//
// This first cut is correctness-first: a CONTENT-COMPARE mirror over the whole store tree
// minus device-local files. Deliberately NOT YET (each a tracked follow-up):
//   • efficiency — diff via the DropboxBackend change cursor + Dropbox content_hash instead
//     of reading every file each pass;
//   • hub/reader roles (SYNC.md §2) — a reader must not push the corpus;
//   • conflict resolution + state/note delta-merge (SYNC.md §3/§5);
//   • live wiring (boot mount + store.reload() after pull) + the settings UI.
// It is not wired into the app yet — it's the tested core the next moves build on.

// What replicates: the WHOLE store tree EXCEPT device-local files. An exclude list (not an
// include list) is deliberate — the store's dirs are many (/feeds, /items, /content,
// /catalog, /schema/vocab, /stacks, …) and a missed dir = silently-unsynced data, so we
// sync-by-default and name only what must stay local. settings.json holds the device's role,
// mount, and connection; usage/health/the engine's own marker are local too.
const SYNC_EXCLUDE = new Set(['/settings.json', '/usage.json', '/.health', '/sync-state.json']);
const MANIFEST_PATH = '/sync-state.json';   // the excluded marker: per-file push signatures + (2d.2) the pull cursor

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
  return (await syncListTree(vfs, '/')).filter((p) => !SYNC_EXCLUDE.has(p));
}

function syncBytesEqual(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

// copy src:p → dst:p when dst is missing or differs. Returns true if it wrote. Reads BYTES so
// it's correct for the text corpus (JSON/ndjson/html) AND binary stacks attachments alike.
async function syncCopyIfDiffer(src, dst, p) {
  const data = await src.readFile(p, 'bytes');
  let cur = null; try { cur = await dst.readFile(p, 'bytes'); } catch { /* missing on dst */ }
  if (syncBytesEqual(cur, data)) return false;
  const slash = p.lastIndexOf('/');
  if (slash > 0) { try { await dst.mkdir(p.slice(0, slash), { recursive: true }); } catch { /* exists */ } }
  await dst.writeFile(p, data);
  return true;
}

class SyncEngine {
  constructor({ local, remote, store = null }) {
    this.local = local;     // weir's live VFS (store.vfs)
    this.remote = remote;   // the cloud VFS (DropboxBackend), or a memory VFS in tests
    this.store = store;     // optional — for the post-pull re-hydrate
    this._manifest = null;
  }

  // The sync manifest (persisted locally, excluded from sync): path → {size, mtime} as last
  // synced, so push can skip unchanged files with a cheap stat — no content read, no re-upload.
  // (It also holds the pull cursor once the cursor-incremental pull lands; see 2d.2 in SYNC.md.)
  async _loadManifest() {
    if (this._manifest) return this._manifest;
    try { this._manifest = JSON.parse(await this.local.readFile(MANIFEST_PATH, 'utf8')); } catch { this._manifest = {}; }
    if (!this._manifest.files) this._manifest.files = {};
    return this._manifest;
  }
  async _saveManifest() { try { await this.local.writeFile(MANIFEST_PATH, JSON.stringify(this._manifest)); } catch { /* best effort */ } }
  _sig(st) { return { size: st.size || 0, mtime: st.modified ? +new Date(st.modified) : 0 }; }
  _changed(a, b) { return !a || a.size !== b.size || a.mtime !== b.mtime; }

  // local → remote: upload only files new or changed since the last sync (cheap stat diff — no
  // content read for unchanged files). Does NOT delete remote files that vanished locally:
  // cross-device deletion needs tombstones (2d.2), and weir never-deletes anyway.
  async push() {
    const man = await this._loadManifest();
    const paths = await syncCollectPaths(this.local);
    let pushed = 0, skipped = 0;
    for (const p of paths) {
      let st; try { st = await this.local.stat(p); } catch { continue; }
      const sig = this._sig(st);
      if (!this._changed(man.files[p], sig)) { skipped++; continue; }
      const data = await this.local.readFile(p, 'bytes');
      const slash = p.lastIndexOf('/'); if (slash > 0) { try { await this.remote.mkdir(p.slice(0, slash), { recursive: true }); } catch { /* exists */ } }
      await this.remote.writeFile(p, data);
      man.files[p] = sig; pushed++;
    }
    await this._saveManifest();
    return { pushed, skipped, scanned: paths.length };
  }

  // remote → local: copy every remote file the local lacks or that differs, record each in the
  // manifest (so the next push doesn't echo it straight back), then re-hydrate the store.
  // NOTE: this is the full content-compare bootstrap — it reads every remote file. The cheap
  // cursor-incremental pull (changes()/latestCursor() are already in the backend) is 2d.2.
  async pull() {
    const man = await this._loadManifest();
    const paths = await syncCollectPaths(this.remote);
    let pulled = 0;
    for (const p of paths) {
      if (!(await syncCopyIfDiffer(this.remote, this.local, p))) continue;
      pulled++;
      try { man.files[p] = this._sig(await this.local.stat(p)); } catch { /* */ }
    }
    if (pulled) { await this._saveManifest(); if (this.store && typeof this.store.reload === 'function') await this.store.reload(); }
    return { pulled, scanned: paths.length };
  }
}

export { SyncEngine, syncCollectPaths, syncCopyIfDiffer, syncListTree, syncBytesEqual, SYNC_EXCLUDE };
