// Boot — assembles the store, poller, and UI, wires the status bar, and starts
// polling. The dynamic UI lives in App; boot owns one-time setup + diagnostics.

import { Store } from './store/store.js';
import { Poller } from './poller.js';
import { Router } from './router.js';
import { RecoveryDrip } from './recovery.js';
import { LinkResolver } from './linkresolver.js';
import { extractArticle } from './extract.js';
import { Retainer } from './retainer.js';
import { FaviconFetcher } from './favicon.js';
import { App } from './ui/app.js';
import { initPwa, setAutoCheck } from './pwa.js';
import { loadHandle, handlePermission } from './fsmount.js';
import { catalogStoreItem } from './cataloger.js';
import { SearchIndex } from './search.js';
import { initWebmcp } from './webmcp.js';
import { getKey } from './llmkeys.js';
import { TelegramInflux } from './telegram.js';
import { StacksStore } from './stacks.js';
import { Courier, DEFAULT_COURIER } from './courier.js';
import { BackgroundRunner } from './runner.js';
import { parseFeed, feedAdapter } from './adapters/feed.js';
import { youtubeAdapter } from './adapters/youtube.js';
import { githubAdapter } from './adapters/github.js';
import { usgsAdapter } from './adapters/usgs.js';
import { fmtBytes } from './ui/format.js';
import { hasBridge, bridgeVersion, gcuFetch } from '../../vendor/bridge-client.js';

const VERSION = '__WEIR_VERSION__';        // replaced at build time
const BUILD_DATE = '__WEIR_BUILD_DATE__';  // replaced at build time
const COMMIT = '__WEIR_COMMIT__';          // short content hash of the bundle (build id)

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
  setText('weir-version', `weir ${VERSION === '0.0.0' ? COMMIT : `${VERSION}·${COMMIT}`}`);
  { const wv = $('weir-version'); if (wv) wv.title = `build ${COMMIT}${BUILD_DATE ? ` · ${BUILD_DATE}` : ''}`; }
  document.title = `@gcu/weir`;
  initPwa();
  probeBridge();

  // Pick the backend: if the user has mounted weir to a folder and the grant is
  // still live, run on it (File System Access). Anything off — no handle, lapsed
  // permission, or any error — falls back to IndexedDB so weir ALWAYS loads.
  let backendCfg = { type: 'idb', name: 'weir' };
  let pendingMount = null;
  try {
    const handle = await loadHandle();
    if (handle) {
      if ((await handlePermission(handle, false)) === 'granted') backendCfg = { type: 'fsaa', handle };
      else pendingMount = handle;   // needs a reconnect gesture; run on IDB meanwhile
    }
  } catch { /* stay on IDB */ }

  let store;
  try {
    store = await Store.open({ backend: backendCfg });
  } catch (e) {
    if (backendCfg.type === 'fsaa') {   // folder failed → fall back to IDB, don't strand the user
      pendingMount = backendCfg.handle;
      try { store = await Store.open({ backend: { type: 'idb', name: 'weir' } }); } catch { /* handled below */ }
    }
    if (!store) {
      setText('backend-status', `store: unavailable (${e.message})`);
      const d = $('vfs-dot'); if (d) d.dataset.state = 'fault';
      return;
    }
  }

  setAutoCheck(store.getSettings().auto_check_updates);   // sync the SW with the saved preference

  const backendType = store.vfs.mounts()[0]?.type || '?';
  const backendLabel = backendType === 'fsaa' ? 'folder' : backendType;
  try {
    const ok = await store.ping();
    setText('backend-status', `store: ${backendLabel}${ok ? '' : ' (mismatch)'}`);
    const d = $('vfs-dot'); if (d) d.dataset.state = ok ? 'ok' : 'fault';
  } catch (e) {
    setText('backend-status', `store: ${backendLabel} (error)`);
    const d = $('vfs-dot'); if (d) d.dataset.state = 'fault';
  }

  const router = new Router();
  router.load(await store.getRouting());
  router.loadStacks(await store.getStacksRouting());   // stacks filing rules (STACKS.md §4)
  store.router = router;

  const adapters = [youtubeAdapter, githubAdapter, usgsAdapter, feedAdapter];   // specific before the `feed` fallback
  const poller = new Poller(store, { adapters, fetch: gcuFetch });
  const faviconFetcher = new FaviconFetcher(store, { fetch: gcuFetch });   // lazy rail icons, polite
  // Full-text search v2 — build the in-RAM librarian index from the corpus, and
  // rebuild (debounced) as items arrive/change. app.query() routes the search box
  // through it (ranked), falling back to the cursor-scan until it's ready.
  const search = new SearchIndex(store);
  try { search.build(); } catch (e) { console.error('search index build failed', e); }
  store.on('items', () => search.scheduleRebuild());

  const app = new App({ store, poller, router, adapters, faviconFetcher });
  app.searchIndex = search;
  app.fsMount = { type: backendType, pending: pendingMount };   // filesystem-mount state for the UI

  // Stacks (STACKS.md) — the notes/files vault. Set on the app before mount so the
  // rail tree renders any persisted entries immediately; ensure + scan + drain the
  // Telegram stash run just after (async), reconciling the on-disk tree.
  const stacks = new StacksStore(store);
  app.stacks = stacks;
  // The Courier — weir's optional FS-backed collaborator exchange (the Laney bridge).
  // Created unmounted; the user attaches an exchange folder from the UI (a gesture).
  { const cs = store.getSettings(); app.courier = new Courier({ store, stacks, config: { ...DEFAULT_COURIER, owner: cs.owner_name || '', name: cs.courier_name || DEFAULT_COURIER.name, author: cs.courier_author || DEFAULT_COURIER.author } }); }
  // Structural dispatch types land as PROPOSALS the user ratifies (decides-vs-proposes).
  app._courierProposals = store.getSettings().courier_proposals || [];
  app.courier.handlers = {
    feed: async ({ data, body }) => app.courierPropose('feed', { url: data.url, name: data.name, why: ((data.why || body || '').toString()).trim().slice(0, 280) }),
  };
  // Silently re-attach a previously-connected exchange folder if permission survives
  // (no prompt — handlePermission without request only queries; else reconnect via Settings).
  (async () => {
    try {
      const h = await loadHandle('courier:' + DEFAULT_COURIER.id);
      if (h && (await handlePermission(h)) === 'granted') { await app.courier.mount(h); await app.courier.publish().catch(() => {}); app.renderCourierSettings?.(); }
    } catch { /* offline / no folder — user connects from Settings */ }
  })();

  app.mount();
  poller.start();

  (async () => {
    try {
      await stacks.ensure();
      await stacks.scan();
      const ingested = await stacks.ingestStash();   // drain /telegram-notes.ndjson → /stacks/inbox
      await store.flush();
      app.renderStacks();
      if (ingested) app.renderCounts();
    } catch (e) { console.error('stacks init failed', e); }
  })();

  // WebMCP — register weir's tools on the shim-polyfilled navigator.modelContext
  // and reconnect to the bridge if a connection string was saved. gcuFetch is the
  // injected transport so it works from the deployed (public-origin) PWA too.
  const webmcp = initWebmcp({ store, app, fetch: gcuFetch });
  app.webmcp = webmcp;
  app.renderWebmcpStatus(webmcp ? webmcp.state() : 'unavailable');
  // WebMCP over a folder (fs transport): reconnect silently if a folder handle was
  // persisted and permission is still granted (no prompt — else reconnect via Settings,
  // which has the user gesture). Mirrors the Courier's boot reconnect.
  if (webmcp && webmcp.storedFs && webmcp.storedFs()) {
    try {
      const h = await loadHandle('webmcp-fs');
      if (h && (await handlePermission(h)) === 'granted') webmcp.connectFolder(h, webmcp.storedFs());
    } catch { /* reconnect via Settings */ }
  }

  const retainer = new Retainer(store);   // archives expired items (never deletes); off until enabled
  retainer.start();

  // Background IA recovery drip — resumes if there's pending work from last time.
  const drip = new RecoveryDrip(store, { fetch: gcuFetch, parseFeed, intervalMs: store.getSettings().recovery_drip_interval_ms });
  app.recovery = drip;   // expose for the MCP weir_recover tool (queue dead feeds for archival recovery)
  await drip.load();
  drip.on((st) => app.renderDripStatus(st));
  app.renderDripStatus(drip.status());
  if (drip.queue.length || drip.current) drip.start();

  // Background link resolver — politely resolves wrapped saved links (share.google
  // etc.) over time, so imports never have to burst-hit (and get throttled by) the
  // shortener. Resumes any unresolved links from prior imports.
  // One runner drives every background loop, so the flight-deck keep-alive is a
  // single switch (setDriver) and new loops can't forget to be kept alive.
  const runner = new BackgroundRunner();
  app.runner = runner;

  const linkResolver = new LinkResolver(store, { fetch: gcuFetch, extract: extractArticle, onKick: () => runner.kick('resolver') });
  app.linkResolver = linkResolver;
  await linkResolver._loadLog();   // resume the run log (so the overnight tally survives reloads)
  linkResolver.on((st) => app.renderResolverStatus(st));
  app.renderResolverStatus(linkResolver.status());
  runner.add({ name: 'resolver', intervalMs: linkResolver.intervalMs, tick: () => linkResolver.tick(), enabled: () => linkResolver.enabled() });
  linkResolver.kick();   // clear misses + (via onKick) an immediate run

  // Telegram influxer — poll a weir-only bot's getUpdates (direct fetch; CORS-ok)
  // for live captures: links → Saved Links (resolved), notes → stashed. Token in the
  // vault; only runs when enabled + a token is set.
  const telegram = new TelegramInflux(store, {
    getToken: () => getKey('telegram'),
    fetchFile: gcuFetch,   // file-bytes download goes through the bridge (not CORS-readable directly)
    onLinks: (links) => app.importLinks(links, 'telegram'),
    onFile: async ({ name, bytes, mime }) => { await stacks.addFile({ name, bytes, mime, source: 'telegram' }); await store.flush(); app.renderStacks(); },
  });
  app.telegram = telegram;
  telegram.on((st) => app.renderTelegramStatus(st));
  runner.add({ name: 'telegram', intervalMs: telegram.intervalMs, tick: () => telegram.tick(), enabled: () => telegram.enabled() });
  if (store.getSettings().telegram_enabled && await getKey('telegram')) { telegram.start(); runner.kick('telegram'); }
  app.renderTelegramStatus(telegram.status);   // reflect enabled/polling in the footer from the start

  // Courier auto-loops — so the exchange works hands-off (no manual ingest/publish), which
  // is the mode the collaborator's skills assume. Both gated on a mounted courier.
  runner.add({
    name: 'courier-ingest', intervalMs: 25_000,
    enabled: () => !!(app.courier && app.courier.mounted),
    tick: async () => {
      const r = await app.courier.ingest();
      if (r.results && r.results.length) { await store.flush(); app.renderStacks(); app.renderStream(); app.renderCourierBar(); }
      if (r.ingested > 0) await app.courier.publish().catch(() => {});   // refresh out/notes so her new note shows up
    },
  });
  runner.add({
    name: 'courier-publish', intervalMs: 90_000,
    enabled: () => !!(app.courier && app.courier.mounted && app._courierDirty),
    tick: async () => { app._courierDirty = false; await app.courier.publish().catch(() => {}); },
  });

  window.__weir = { store, poller, router, drip, retainer, linkResolver, stacks, app, addFeed: (u) => app.addFeed(u), recover: (id) => app.recoverHistory(id), exportCorpus: (o) => app.exportCorpus(o), buildCatalog: (o) => store.buildCatalog(o), clearCatalog: () => store.clearCatalog(),
    catalogItemLLM: async (id, o = {}) => {
      const s = store.getSettings();
      const provider = o.provider || s.catalog_provider || 'ollama';
      const key = o.key || (await getKey(provider));
      return catalogStoreItem(store, id, { provider, model: o.model || s.catalog_model, baseUrl: o.baseUrl || s.catalog_base_url, key, fetch: gcuFetch, ...o });
    },
    webmcp, search, parseFeed, feedAdapter, gcuFetch };

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
