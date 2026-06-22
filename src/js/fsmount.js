// Filesystem mount (File System Access). Lets weir run its whole store on a
// user-picked real directory instead of IndexedDB — immune to browser eviction,
// browsable + syncable with normal tools. The directory handle is persisted in a
// tiny dedicated IDB db so weir can re-open the folder on the next launch (with
// a permission re-grant gesture). Everything here is browser-only (FSA + IDB).

import { VFS } from '../../vendor/vfs.js';

const HANDLE_DB = 'weir-fs';
const HANDLE_STORE = 'kv';
const HANDLE_KEY = 'dir';

function _openDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(HANDLE_DB, 1);
    r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(HANDLE_STORE)) r.result.createObjectStore(HANDLE_STORE); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
function _tx(mode, run) {
  return _openDb().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(HANDLE_STORE, mode);
    const req = run(tx.objectStore(HANDLE_STORE));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

// The persisted directory handle, or null. FileSystemDirectoryHandle is
// structured-cloneable, so IDB stores it directly. `key` selects WHICH handle —
// default is the store mount ('dir'); auxiliary mounts (e.g. a Courier exchange
// folder, 'courier:<id>') persist under their own key, fully decoupled from the store.
export async function loadHandle(key = HANDLE_KEY) { try { return (await _tx('readonly', (os) => os.get(key))) || null; } catch { return null; } }
export async function saveHandle(handle, key = HANDLE_KEY) { await _tx('readwrite', (os) => os.put(handle, key)); }
export async function clearHandle(key = HANDLE_KEY) { try { await _tx('readwrite', (os) => os.delete(key)); } catch { /* nothing to clear */ } }

// Prompt the user to pick a directory (needs a user gesture). `id` lets the browser
// remember a distinct last-folder per purpose (store vs each courier).
export async function pickDirectory(id = 'weir-store', mode = 'readwrite') {
  if (typeof window === 'undefined' || !window.showDirectoryPicker) {
    throw new Error('This browser has no File System Access API — try Edge or Chrome (desktop).');
  }
  return window.showDirectoryPicker({ mode, id });   // mode 'read' for a read-only mount (e.g. the repos folder)
}

// 'granted' | 'prompt' | 'denied'. `request: true` triggers the permission
// prompt (must be inside a user gesture). `mode` matches the grant requested at
// pick time ('read' for a read-only mount, 'readwrite' for the store/Courier).
export async function handlePermission(handle, request = false, mode = 'readwrite') {
  if (!handle || !handle.queryPermission) return 'denied';
  const opts = { mode };
  try {
    const q = await handle.queryPermission(opts);
    if (q === 'granted') return 'granted';
    if (request) return await handle.requestPermission(opts);
    return q || 'prompt';
  } catch { return 'denied'; }
}

// Does this folder already hold a weir store? (Checked via a raw VFS so we don't
// hydrate/initialize it — adopting an existing store must not clobber it.)
export async function folderHasStore(handle) {
  try {
    const vfs = await VFS.create({ type: 'fsaa', handle });
    return await vfs.exists('/meta.json');
  } catch { return false; }
}

// A short label for the folder (its name), for the UI.
export function handleName(handle) { return (handle && handle.name) || 'folder'; }

// Read one repo-relative doc from a mounted (read-only) repos-parent VFS:
// `<repoDir>/<path>` as UTF-8 TEXT, ≤ maxBytes. Blocks `..` traversal so a path can't
// escape the repo dir. Returns the text, or null if the file isn't there. Pure (takes a
// vfs + strings) so it's node-testable — the read MUST go through vfs.readFile, whose
// no-/utf8-encoding contract returns a STRING (file.text()); the earlier bug fed that
// string to `new Uint8Array(...)` (→ length 0 → ""), silently emptying every doc.
export async function readMountedDoc(vfs, repoDir, path, opts = {}) {
  if (!vfs) throw new Error('repos folder not mounted');
  const clean = String(path).replace(/\\/g, '/').replace(/^\/+/, '');
  if (clean.split('/').includes('..')) throw new Error(`invalid path "${path}" (no .. traversal)`);
  const dir = String(repoDir).replace(/^\/+|\/+$/g, '');
  const abs = `/${dir}/${clean}`;
  let raw;
  try { raw = await vfs.readFile(abs, 'utf8'); }
  catch (e) { if (e && (e.code === 'ENOENT' || e.name === 'NotFoundError')) return null; throw e; }
  const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8', { fatal: false }).decode(raw instanceof Uint8Array ? raw : new Uint8Array(raw || []));
  const max = opts.maxBytes || 1_000_000;
  if (text.length > max) throw new Error(`${path} exceeds ${Math.round(max / 1000)} KB`);
  return text;
}
