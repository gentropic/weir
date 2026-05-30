// Boot — wires the vendored VFS storage backbone and proves the pipeline
// (tokens + fonts + VFS) end-to-end. This is the v0.1 shell's only logic; the
// real store/adapters/poller/router/UI land on top of this.

import { VFS } from '../../vendor/vfs.js';

const VERSION = '__WEIR_VERSION__';        // replaced at build time
const BUILD_DATE = '__WEIR_BUILD_DATE__';  // replaced at build time
const DB_NAME = 'weir';

const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el) el.textContent = text; };

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i > 0 && v < 10 ? 1 : 0)} ${u[i]}`;
}

function setDot(state) { const d = $('vfs-dot'); if (d) d.dataset.state = state; }

async function boot() {
  setText('weir-version', `weir ${VERSION}`);
  setText('build-date', BUILD_DATE);

  // 1. Bring up VFS on IndexedDB (default backend; FSA-A is the opt-in swap).
  let vfs;
  try {
    vfs = await VFS.create({ type: 'idb', name: DB_NAME });
    window.__weirVfs = vfs;   // for console poking during dev
  } catch (e) {
    setText('vfs-status', `VFS init failed: ${e.message}`);
    setText('backend-status', 'store: unavailable');
    setDot('fault');
    return;
  }

  const mount = vfs.mounts()[0];
  setText('backend-status', `store: ${mount ? mount.type : '?'}`);

  // 2. Smoke test: round-trip a health file to confirm read/write works.
  try {
    const stamp = new Date().toISOString();
    await vfs.writeFile('/.weir-health', stamp);
    const back = await vfs.readFile('/.weir-health', 'utf8');
    const ok = back === stamp;
    setText('vfs-status', ok ? 'VFS ok — read/write round-trip' : 'VFS mismatch');
    setDot(ok ? 'ok' : 'fault');
  } catch (e) {
    setText('vfs-status', `VFS round-trip failed: ${e.message}`);
    setDot('fault');
  }

  // 3. Ask for persistent storage (eviction resistance).
  try {
    let persisted = false;
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
    if (!persisted && navigator.storage?.persist) persisted = await navigator.storage.persist();
    setText('persist-status', persisted ? 'persistent' : 'best-effort');
  } catch { /* storage manager unavailable */ }

  // 4. Storage usage in the status bar (flight-deck instrumentation).
  try {
    const est = await vfs.estimate('/');
    if (est && (est.usage != null || est.quota != null)) {
      setText('storage-usage', `${fmtBytes(est.usage)} / ${fmtBytes(est.quota)}`);
    }
  } catch { /* estimate unsupported */ }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
