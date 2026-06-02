// Link resolver — a gentle background drip that resolves saved share-sheet /
// shortener links (share.google, search.app, bit.ly, …) to their real
// destination a couple at a time on a long interval. A one-shot import burst
// gets rate-limited (share.google throttles bursts); dripping politely over time
// doesn't. Scans the 'saved' source for items whose url is still a wrapper,
// resolves via gcuFetch (follow redirects → response.url, cache-busted so a stale
// 429 isn't re-served), and updates the url IN PLACE (the item id is hashed from
// the original url, so this never changes identity). Flushes after each change so
// nothing is lost on refresh. Pauses when hidden; idles when nothing's left.

import { isWrappedUrl } from './importers.js';

const SAVED_FEED = 'saved';

function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(+n); } catch { return _; } });
}

// Pull OpenGraph/Twitter card metadata out of a page's <head> with a tolerant
// regex (no DOM — runs in node tests too). Returns { title, image, description }.
export function parseLinkMeta(html) {
  const head = String(html || '').slice(0, 200_000);   // og tags live up top; cap the work
  const meta = (prop) => {
    const re = new RegExp('<meta\\b[^>]*\\b(?:property|name)\\s*=\\s*["\']' + prop + '["\'][^>]*>', 'i');
    const tag = head.match(re);
    if (!tag) return null;
    const c = tag[0].match(/\bcontent\s*=\s*["']([^"']*)["']/i);
    return c ? decodeEntities(c[1].trim()) || null : null;
  };
  const titleTag = head.match(/<title[^>]*>([^<]*)<\/title>/i);
  return {
    title: meta('og:title') || meta('twitter:title') || (titleTag ? decodeEntities(titleTag[1].trim()) : null) || null,
    image: meta('og:image:secure_url') || meta('og:image') || meta('twitter:image') || meta('twitter:image:src') || null,
    description: meta('og:description') || meta('twitter:description') || meta('description') || null,
  };
}

// A title is "weak" (worth replacing with og:title) when it's missing, the
// untitled placeholder, a bare wrapper, or just a hostname (our import fallback).
function isWeakTitle(title, url) {
  if (!title || title === '(untitled)') return true;
  const t = String(title).trim();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t)) return true;   // looks like a bare domain
  try { if (t === new URL(url).hostname.replace(/^www\./, '')) return true; } catch { /* ignore */ }
  return false;
}

function absUrl(href, base) { try { return new URL(href, base).href; } catch { return null; } }

export class LinkResolver {
  constructor(store, { fetch, extract, intervalMs = 15_000, batch = 2, maxMisses = 8 } = {}) {
    this.store = store;
    this.fetch = fetch;
    this.extract = extract || null;   // readability extractor (browser-only; injected so node tests can omit it)
    this.intervalMs = intervalMs;
    this.batch = batch;
    this.maxMisses = maxMisses;     // park a link after this many failed ticks (until the next kick / reload)
    this._misses = new Map();       // id → consecutive miss count
    this._timer = null; this._busy = false; this._listeners = new Set();
  }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  emit() { const st = this.status(); this._listeners.forEach((fn) => { try { fn(st); } catch { /* ignore */ } }); }

  _pending() {
    // Everything not yet successfully fetched: wrapped links (need resolving) AND
    // direct links (need enriching for a thumbnail). Resolve wrappers FIRST — they
    // all hit the same host (share.google) so they're the throttle-prone ones; the
    // direct links spread across many hosts. An item drops out once `enriched` is set.
    return this.store.query({ feed_id: SAVED_FEED })
      .filter((r) => !r.archived && !r.enriched && (this._misses.get(r.id) || 0) < this.maxMisses)
      .sort((a, b) => (isWrappedUrl(b.url) ? 1 : 0) - (isWrappedUrl(a.url) ? 1 : 0));
  }
  status() { return { pending: this._pending().length, running: !!this._timer }; }

  // (Re)start resolving — called at boot and after each import. Clears the
  // parked-misses so a fresh import retries everything (throttle may have lifted).
  kick() { this._misses.clear(); if (!this._timer && this._pending().length) this.start(); }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick().catch((e) => console.error('linkresolver', e)), this.intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    this.emit();
    this.tick().catch(() => {});
  }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } this.emit(); }

  // Fetch a saved link's page once and do both jobs from the single response:
  // follow redirects to the real url (if it's a wrapper) AND parse OpenGraph
  // metadata (thumbnail / better title / excerpt). Updates the item in place.
  // Returns the applied patch, or null if it couldn't resolve (retry later).
  async enrichOne(item) {
    let html = '', finalUrl = item.url;
    try {
      const r = await this.fetch(item.url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
      if (!r || !r.ok) return null;
      if (r.url && !isWrappedUrl(r.url)) finalUrl = r.url;
      if (isWrappedUrl(finalUrl)) return null;   // no redirect surfaced — still a wrapper, try again later
      html = await (r.text ? r.text().catch(() => '') : Promise.resolve(''));
    } catch { return null; }

    const meta = parseLinkMeta(html);
    const img = meta.image && absUrl(meta.image, finalUrl);
    // Extract the article body from the SAME response (no second fetch) so the
    // cataloger gets full content + the link reads inline. Images stay suppressed
    // (weir's default; "load images" per-item still works).
    let content = null;
    if (this.extract) { try { content = this.extract(html, finalUrl); } catch { /* unparseable page */ } }

    const patch = { id: item.id, feed_id: SAVED_FEED, url: finalUrl, enriched: true };   // url write clears "unresolved"; enriched = fetched+parsed (won't re-fetch)
    if (img) patch.media = { ...(item.media || {}), thumbnail: img };
    if (meta.title && isWeakTitle(item.title, finalUrl)) patch.title = meta.title;
    if (meta.description && !item.excerpt) patch.excerpt = meta.description.slice(0, 300);
    if (content) patch.content = content;   // → has_content; cataloger uses it (capped at maxBodyChars)
    await this.store.upsertItems([patch]);
    return patch;
  }

  async tick() {
    if (this._busy) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;   // idle in the background
    this._busy = true;
    try {
      const batch = this._pending().slice(0, this.batch);
      if (!batch.length) { this.stop(); return; }
      let changed = 0;
      for (const it of batch) {
        const patch = await this.enrichOne(it);
        if (patch) { this._misses.delete(it.id); changed++; }
        else this._misses.set(it.id, (this._misses.get(it.id) || 0) + 1);
      }
      if (changed) await this.store.flush();
      this.emit();
    } finally {
      this._busy = false;
    }
  }
}
