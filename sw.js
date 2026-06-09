// weir service worker — cache-first + stale-while-revalidate (adapted from
// @gcu/ep). The whole app is a single weir.html; cache it on install, serve it
// from cache on every navigation (instant + offline), and refresh in the
// background. If the fresh bytes differ, tell the page to show a "reload" toast.
//
// Being a controlled PWA also makes the browser far more willing to grant
// persistent storage — which is the point here: nothing should be lost.

const CACHE = 'weir-shell-4a68215';
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
];

let _autoCheck = true;   // toggled by the page via a message; gates background refresh

self.addEventListener('install', (event) => {
  event.waitUntil(
    // Fetch the shell with `cache: 'reload'` so a NEWLY-installing SW always caches
    // FRESH bytes — never an HTTP-cached stale index.html (which would trap the update
    // and leave the PWA on the old build despite a successful deploy + cache bump).
    caches.open(CACHE).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).catch(() => { /* offline at install — best effort */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;   // leave cross-origin (bridge/thumbnails) alone
  event.respondWith(handle(req));
});

async function handle(req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  if (cached) {
    // Offline-first: serve from cache instantly. Background-refresh only if the
    // user hasn't turned off auto-check (saves the shell re-fetch on bad links).
    if (_autoCheck) revalidate(req, cache, cached);
    return cached;
  }
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch (e) {
    const navFallback = await cache.match('./index.html') || await cache.match('./');
    if (navFallback) return navFallback;
    throw e;
  }
}

async function revalidate(req, cache, cached) {
  try {
    const fresh = await fetch(req, { cache: 'no-store' });
    if (!fresh || !fresh.ok) return;
    const a = await cached.clone().arrayBuffer();
    const b = await fresh.clone().arrayBuffer();
    await cache.put(req, fresh.clone());
    if (!bytesEqual(a, b)) {
      const clients = await self.clients.matchAll({ includeUncontrolled: true });
      for (const client of clients) client.postMessage({ type: 'weir:update-available' });
    }
  } catch { /* offline / failed refresh — ignore */ }
}

function bytesEqual(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  const va = new Uint8Array(a), vb = new Uint8Array(b);
  for (let i = 0; i < va.length; i++) if (va[i] !== vb[i]) return false;
  return true;
}

// Message protocol with the page (Settings → Updates).
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type === 'weir:set-auto-check') { _autoCheck = !!msg.value; return; }
  if (msg.type === 'weir:check-now') {
    const port = event.ports && event.ports[0];
    event.waitUntil((async () => {
      const cache = await caches.open(CACHE);
      const root = new Request(new URL('./', self.location.href).toString());
      const cached = await cache.match(root, { ignoreSearch: true });
      if (cached) await revalidate(root, cache, cached);           // posts weir:update-available if changed
      else { try { const r = await fetch(root); if (r && r.ok) await cache.put(root, r.clone()); } catch { /* offline */ } }
      if (port) port.postMessage({ type: 'weir:check-complete', at: Date.now() });
    })());
  }
});
