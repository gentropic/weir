// Lazy, polite favicon fetching for the source rail. Each feed's site icon is
// fetched once (through the bridge so cross-origin works), cached as a data:
// URL on the feed record, and rendered in the rail. Until one arrives — or for
// feeds that turn out to have none — a deterministic letter monogram stands in,
// so the rail is scannable instantly and offline.

const MAX_FAVICON_BYTES = 30_000;          // skip oversized icons; hundreds of feeds add up
const RECHECK_MS = 30 * 86_400_000;        // re-try a missing favicon at most monthly
const HTML_SCAN_BYTES = 200_000;           // icons live in <head>; don't scan a whole long page

// Infer an image mime from a URL extension — fallback when a server omits
// Content-Type on the icon response (so the data: URL still gets the right type).
const EXT_MIME = { png: 'image/png', svg: 'image/svg+xml', ico: 'image/x-icon', gif: 'image/gif', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
function mimeFromUrl(url) {
  const m = String(url).split(/[?#]/)[0].match(/\.([a-z0-9]+)$/i);
  return m ? EXT_MIME[m[1].toLowerCase()] : undefined;
}

// Parse `<link rel="icon|shortcut icon|apple-touch-icon">` hrefs out of a home
// page, resolved to absolute URLs and ranked best-first for a tiny rail chip:
// scalable SVG / "any" first, then sizes nearest ~32px, then the rest. Pure +
// regex-based (no DOMParser) so it runs in node tests too. Returns URL strings.
export function parseIconLinks(html, baseUrl) {
  if (!html) return [];
  const head = String(html).slice(0, HTML_SCAN_BYTES);
  const cands = [];
  const linkRe = /<link\b[^>]*>/gi;
  let m;
  while ((m = linkRe.exec(head))) {
    const tag = m[0];
    const rel = (tag.match(/\brel\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (!rel || !/(^|\s)(shortcut\s+)?icon(\s|$)|apple-touch-icon/i.test(rel)) continue;
    const href = (tag.match(/\bhref\s*=\s*["']([^"']*)["']/i) || [])[1];
    if (!href) continue;
    let abs;
    try { abs = new URL(href, baseUrl).href; } catch { continue; }
    const sizes = (tag.match(/\bsizes\s*=\s*["']([^"']*)["']/i) || [])[1] || '';
    const svg = /\.svg(\?|#|$)/i.test(abs) || /any/i.test(sizes);
    const sm = sizes.match(/(\d+)\s*[x×]\s*(\d+)/i);
    const size = sm ? parseInt(sm[1], 10) : (/apple-touch-icon/i.test(rel) ? 180 : 16);
    cands.push({ url: abs, svg, size });
  }
  const score = (c) => (c.svg ? 1000 : c.size >= 16 && c.size <= 64 ? 500 - Math.abs(32 - c.size) : 100 - Math.min(100, Math.abs(32 - c.size)));
  const seen = new Set();
  return cands.sort((a, b) => score(b) - score(a)).map((c) => c.url).filter((u) => (seen.has(u) ? false : seen.add(u)));
}

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
    // Cheap path first: <origin>/favicon.ico. Many feeds end here.
    let favicon = await this._fetchImage(`${origin}/favicon.ico`);
    // Fallback: parse the home page's <link rel="icon"> (sites that declare an
    // icon only in HTML). Same-origin requests, only for feeds the .ico missed.
    if (!favicon) favicon = await this._fromHtml(feed.site_url || origin);
    // Always record the attempt (success or miss); only set favicon on success.
    const patch = { favicon_checked_at: this._now() };
    if (favicon) patch.favicon = favicon;
    await this.store.updateFeed(id, patch);
  }

  // Fetch a URL and, if it's a sane image (right type, non-empty, under the
  // size cap), return it as a data: URL — else null. Guards 200-but-HTML pages.
  async _fetchImage(url) {
    try {
      const res = await this.fetch(url);
      if (!res || !res.ok) return null;
      const ct = (res.headers?.get?.('content-type') || '').split(';')[0].trim();
      const type = ct || mimeFromUrl(url) || 'image/x-icon';
      if (!type.startsWith('image/')) return null;
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (!bytes.length || bytes.length > MAX_FAVICON_BYTES) return null;
      return bytesToDataUrl(bytes, type);
    } catch { return null; }
  }

  // Fetch a home page, parse its <link rel=icon> candidates, and try the best
  // couple — bounded so a missing/odd icon doesn't turn into a fetch storm.
  async _fromHtml(home) {
    let html;
    try {
      const res = await this.fetch(home);
      if (!res || !res.ok) return null;
      const ct = res.headers?.get?.('content-type') || '';
      if (ct && !/html|xml/i.test(ct)) return null;
      html = await res.text();
    } catch { return null; }
    const candidates = parseIconLinks(html, home).slice(0, 2);
    for (const url of candidates) {
      const fav = await this._fetchImage(url);
      if (fav) return fav;
    }
    return null;
  }

  stop() { this._stopped = true; this._running = false; if (this._timer) clearTimeout(this._timer); }
}
