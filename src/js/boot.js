// Boot — assembles the store, poller, and UI, wires the status bar, and starts
// polling. The dynamic UI lives in App; boot owns one-time setup + diagnostics.

import { Store } from './store/store.js';
import { Poller } from './poller.js';
import { Router } from './router.js';
import { App } from './ui/app.js';
import { parseFeed, feedAdapter } from './adapters/feed.js';
import { youtubeAdapter } from './adapters/youtube.js';
import { fmtBytes } from './ui/format.js';
import { hasBridge, bridgeVersion, gcuFetch } from '../../vendor/bridge-client.js';

const VERSION = '__WEIR_VERSION__';        // replaced at build time
const BUILD_DATE = '__WEIR_BUILD_DATE__';  // replaced at build time

const $ = (id) => document.getElementById(id);
const setText = (id, t) => { const el = $(id); if (el) el.textContent = t; };

async function probeBridge() {
  try {
    if (!(await hasBridge())) { setText('bridge-status', 'bridge: not detected'); return; }
    const v = await bridgeVersion();
    setText('bridge-status', v ? `bridge: v${v}` : 'bridge: connected');
  } catch { setText('bridge-status', 'bridge: probe failed'); }
}

async function boot() {
  setText('weir-version', `weir ${VERSION}`);
  document.title = `@gcu/weir`;
  probeBridge();

  let store;
  try {
    store = await Store.open({ backend: { type: 'idb', name: 'weir' } });
  } catch (e) {
    setText('backend-status', `store: unavailable (${e.message})`);
    const d = $('vfs-dot'); if (d) d.dataset.state = 'fault';
    return;
  }

  const backend = store.vfs.mounts()[0]?.type || '?';
  try {
    const ok = await store.ping();
    setText('backend-status', `store: ${backend}${ok ? '' : ' (mismatch)'}`);
    const d = $('vfs-dot'); if (d) d.dataset.state = ok ? 'ok' : 'fault';
  } catch (e) {
    setText('backend-status', `store: ${backend} (error)`);
    const d = $('vfs-dot'); if (d) d.dataset.state = 'fault';
  }

  const router = new Router();
  router.load(await store.getRouting());
  store.router = router;

  const adapters = [youtubeAdapter, feedAdapter];   // specific before the `feed` fallback
  const poller = new Poller(store, { adapters, fetch: gcuFetch });
  const app = new App({ store, poller, router, adapters });
  app.mount();
  poller.start();

  window.__weir = { store, poller, router, app, addFeed: (u) => app.addFeed(u), recover: (id) => app.recoverHistory(id), parseFeed, feedAdapter, gcuFetch };

  try {
    let persisted = false;
    if (navigator.storage?.persisted) persisted = await navigator.storage.persisted();
    if (!persisted && navigator.storage?.persist) persisted = await navigator.storage.persist();
    setText('persist-status', persisted ? 'persistent' : 'best-effort');
  } catch { /* storage manager unavailable */ }

  try {
    const est = await store.estimate();
    if (est && (est.usage != null || est.quota != null)) setText('storage-usage', `${fmtBytes(est.usage)} / ${fmtBytes(est.quota)}`);
  } catch { /* estimate unsupported */ }
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}
