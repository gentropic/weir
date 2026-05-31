// Lazy, polite favicon fetching for the source rail. Each feed's site icon is
// fetched once (through the bridge so cross-origin works), cached as a data:
// URL on the feed record, and rendered in the rail. Until one arrives — or for
// feeds that turn out to have none — a deterministic letter monogram stands in,
// so the rail is scannable instantly and offline.

const MAX_FAVICON_BYTES = 24_000;          // skip oversized icons; hundreds of feeds add up
const RECHECK_MS = 30 * 86_400_000;        // re-try a missing favicon at most monthly

// Origin to fetch a favicon from: prefer the human site over the feed URL
// (feed URLs often live on a feedproxy/CDN host with no favicon of their own).
export function faviconOrigin(feed) {
  for (const u of [feed.site_url, feed.url]) {
    if (!u) continue;
    try { return new URL(u).origin; } catch { /* not a URL */ }
  }
  return null;
}

// Deterministic monogram chip for a feed: first alphanumeric letter + a hue
// derived from the host, so a feed always gets the same colored square. Pure —
// used by the rail renderer and exercised directly by the smoke test.
export function monogram(feed) {
  const name = (feed.name || feed.id || '?').trim();
  const m = name.match(/[A-Za-z0-9]/);
  const ch = (m ? m[0] : '#').toUpperCase();
  const seed = faviconOrigin(feed) || name;
  let h = 0; for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return { ch, hue: h % 360 };
}

function bytesToDataUrl(bytes, type) {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return `data:${type};base64,${btoa(bin)}`;
}

// Does this feed still need a favicon fetched? No cached icon, and either never
// checked or the recheck window has elapsed (so a one-off network miss heals).
export function needsFavicon(feed, nowMs) {
  if (feed.favicon) return false;
  if (!feed.favicon_checked_at) return true;
  return nowMs - feed.favicon_checked_at > RECHECK_MS;
}

export class FaviconFetcher {
  constructor(store, { fetch, intervalMs = 1500, now = () => Date.now() } = {}) {
    this.store = store;
    this.fetch = fetch;
    this.intervalMs = intervalMs;
    this._now = now;
    this._queue = [];
    this._seen = new Set();      // feed ids queued/resolved this session — no dup work
    this._running = false;
    this._stopped = false;
    this._timer = null;
  }

  // Enqueue any of these feeds that still need an icon. Callers pass what
  // they're about to render, so visible feeds get fetched first; de-duped
  // across the session so re-renders don't re-queue.
  enqueue(feeds) {
    const n = this._now();
    for (const f of feeds) {
      if (this._seen.has(f.id)) continue;
      this._seen.add(f.id);
      if (needsFavicon(f, n) && faviconOrigin(f)) this._queue.push(f.id);
    }
    this._kick();
  }

  _kick() {
    if (this._running || this._stopped || !this._queue.length) return;
    this._running = true;
    this._tick();
  }

  async _tick() {
    const id = this._queue.shift();
    if (id == null) { this._running = false; return; }
    try { await this._fetchOne(id); } catch { /* network/parse — leave the monogram standing */ }
    if (this._stopped) { this._running = false; return; }
    // Space requests out — one per origin, gently.
    this._timer = setTimeout(() => this._tick(), this.intervalMs);
  }

  async _fetchOne(id) {
    const feed = this.store.getFeed(id);
    if (!feed) return;
    const origin = faviconOrigin(feed);
    if (!origin) return;
    let favicon;
    try {
      const res = await this.fetch(`${origin}/favicon.ico`);
      if (res && res.ok) {
        const type = (res.headers?.get?.('content-type') || '').split(';')[0].trim() || 'image/x-icon';
        const bytes = new Uint8Array(await res.arrayBuffer());
        // Guard against 200-but-HTML error pages and oversized blobs.
        if (bytes.length && bytes.length <= MAX_FAVICON_BYTES && type.startsWith('image/')) {
          favicon = bytesToDataUrl(bytes, type);
        }
      }
    } catch { /* fall through — still stamp the attempt so we don't hammer */ }
    // Always record the attempt (success or miss); only set favicon on success.
    const patch = { favicon_checked_at: this._now() };
    if (favicon) patch.favicon = favicon;
    await this.store.updateFeed(id, patch);
  }

  stop() { this._stopped = true; this._running = false; if (this._timer) clearTimeout(this._timer); }
}
