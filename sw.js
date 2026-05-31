// weir service worker — cache-first + stale-while-revalidate (adapted from
// @gcu/ep). The whole app is a single weir.html; cache it on install, serve it
// from cache on every navigation (instant + offline), and refresh in the
// background. If the fresh bytes differ, tell the page to show a "reload" toast.
//
// Being a controlled PWA also makes the browser far more willing to grant
// persistent storage — which is the point here: nothing should be lost.

const CACHE = 'weir-shell-v1';
const SHELL = [
  './',
  './weir.html',
  './manifest.webmanifest',
  './icon.svg',
  './icon-maskable.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => { /* offline at install — best effort */ })
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
  if (cached) { revalidate(req, cache, cached); return cached; }
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});
    return resp;
  } catch (e) {
    const navFallback = await cache.match('./weir.html') || await cache.match('./');
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
