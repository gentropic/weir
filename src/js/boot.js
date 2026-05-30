// Boot — brings up the store on the vendored VFS, probes the bridge, and wires
// live counts into the shell. The real stream/adapters/poller render on top of
// this; for now it proves storage + bridge connectivity end to end.

import { Store } from './store/store.js';
import { hasBridge, bridgeVersion } from '../../vendor/bridge-client.js';

const VERSION = '__WEIR_VERSION__';        // replaced at build time
const BUILD_DATE = '__WEIR_BUILD_DATE__';  // replaced at build time

const $ = (id) => document.getElementById(id);
const setText = (id, text) => { const el = $(id); if (el) el.textContent = String(text); };
const setDot = (state) => { const d = $('vfs-dot'); if (d) d.dataset.state = state; };

function fmtBytes(n) {
  if (n == null || Number.isNaN(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(i > 0 && v < 10 ? 1 : 0)} ${u[i]}`;
}

function renderCounts(store) {
  const c = store.counts();
  setText('count-inbox', c.inbox);
  setText('count-saved', c.saved);
  setText('count-archived', c.archived);
  const feeds = store.listFeeds().length;
  setText('topbar-sub', feeds ? `${c.unread} unread · ${feeds} source${feeds === 1 ? '' : 's'}` : 'no feeds yet');
}

async function probeBridge() {
  try {
    if (!(await hasBridge())) { setText('bridge-status', 'bridge: not detected'); return; }
    const v = await bridgeVersion();
    setText('bridge-status', v ? `bridge: v${v}` : 'bridge: connected');
  } catch {
    setText('bridge-status', 'bridge: probe failed');
  }
}

async function boot() {
  setText('weir-version', `weir ${VERSION}`);
  setText('build-date', BUILD_DATE);
  probeBridge();   // non-blocking; independent of storage

  let store;
  try {
    store = await Store.open({ backend: { type: 'idb', name: 'weir' } });
    window.__weirStore = store;   // for console poking during dev
  } catch (e) {
    setText('vfs-status', `store init failed: ${e.message}`);
    setText('backend-status', 'store: unavailable');
    setDot('fault');
    return;
  }

  setText('backend-status', `store: ${store.vfs.mounts()[0]?.type || '?'}`);

  try {
    const ok = await store.ping();
    setText('vfs-status', ok ? 'store ok — read/write round-trip' : 'store mismatch');
    setDot(ok ? 'ok' : 'fault');
  } catch (e) {
    setText('vfs-status', `store round-trip failed: ${e.message}`);
    setDot('fault');
  }

  renderCounts(store);
  for (const ev of ['items', 'item', 'prune', 'feed']) store.on(ev, () => renderCounts(store));

  try {
    let persisted = false;
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
    if (!persisted && navigator.storage?.persist) persisted = await navigator.storage.persist();
    setText('persist-status', persisted ? 'persistent' : 'best-effort');
  } catch { /* storage manager unavailable */ }

  try {
    const est = await store.estimate();
    if (est && (est.usage != null || est.quota != null)) {
      setText('storage-usage', `${fmtBytes(est.usage)} / ${fmtBytes(est.quota)}`);
    }
  } catch { /* estimate unsupported */ }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
