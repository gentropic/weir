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

function lrDecodeEntities(s) {
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
    // Match to the SAME delimiter quote (backref), so a value containing the other
    // quote — e.g. og:title="That an app 'Fits on a Floppy'…" — isn't truncated.
    const c = tag[0].match(/\bcontent\s*=\s*(["'])([\s\S]*?)\1/i);
    return c ? lrDecodeEntities(c[2].trim()) || null : null;
  };
  const titleTag = head.match(/<title[^>]*>([^<]*)<\/title>/i);
  return {
    title: meta('og:title') || meta('twitter:title') || (titleTag ? lrDecodeEntities(titleTag[1].trim()) : null) || null,
    image: meta('og:image:secure_url') || meta('og:image') || meta('twitter:image') || meta('twitter:image:src') || null,
    description: meta('og:description') || meta('twitter:description') || meta('description') || null,
  };
}

// A title is "weak" (worth replacing with og:title) when it's missing, the
// untitled placeholder, a bare wrapper, or just a hostname (our import fallback).
function isWeakTitle(title, url) {
  if (!title || title === '(untitled)') return true;
  const t = String(title).trim();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(t)) return true;        // looks like a bare domain
  if (/^source\s*[:\-–—|]/i.test(t)) return true;                 // Google Discover attribution prefix: "Source: Hackaday"
  if (/shared via the google app/i.test(t)) return true;          // Google App share-sheet cruft (anywhere)
  if (/\bsource\s*:\s*[\w.''’&\- ]{2,40}$/i.test(t)) return true; // trailing attribution: "…real title… Source: Hackaday"
  try { if (t === new URL(url).hostname.replace(/^www\./, '')) return true; } catch { /* ignore */ }
  return false;
}

function absUrl(href, base) { try { return new URL(href, base).href; } catch { return null; } }
function lrHostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return String(u).slice(0, 48); } }

export class LinkResolver {
  constructor(store, { fetch, extract, intervalMs = 15_000, batch = 2, maxMisses = 8, onKick } = {}) {
    this.store = store;
    this.fetch = fetch;
    this.extract = extract || null;   // readability extractor (browser-only; injected so node tests can omit it)
    this.intervalMs = intervalMs;
    this._onKick = onKick || null;    // boot wires this to runner.kick('resolver') for an immediate run after an import
    this.batch = batch;
    this.maxMisses = maxMisses;     // park a link after this many failed ticks (until the next kick / reload)
    this._misses = new Map();       // id → consecutive miss count
    // Persistent run log (/resolver-log.json) — so an overnight run is reviewable:
    // how many resolved, how many parked (gave up), and WHY (throttled vs dead vs
    // no-content). resolved/parked are counters; reasons tallies every failed try
    // (so share.google throttling shows up); recent = the last few parked links.
    this.log = { resolved: 0, parked: 0, reasons: {}, recent: [], startedAt: null, updatedAt: null };
    this._lastLogSave = 0;
    this._busy = false; this._listeners = new Set();
  }

  // Runner-driven: there's work to do iff something's still pending. The
  // BackgroundRunner owns the timer + keep-alive; this gates whether it ticks us.
  enabled() { return this._pending().length > 0; }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  emit() { const st = this.status(); this._listeners.forEach((fn) => { try { fn(st); } catch { /* ignore */ } }); }

  _pending() {
    // Everything not yet successfully fetched: wrapped links (need resolving) AND
    // direct links (need enriching for a thumbnail). Resolve wrappers FIRST — they
    // all hit the same host (share.google) so they're the throttle-prone ones; the
    // direct links spread across many hosts. An item drops out once `enriched` is set.
    return this.store.query({ feed_id: SAVED_FEED })
      .filter((r) => !r.archived && !r.enriched && !r.resolve_parked && (this._misses.get(r.id) || 0) < this.maxMisses)
      .sort((a, b) => (isWrappedUrl(b.url) ? 1 : 0) - (isWrappedUrl(a.url) ? 1 : 0));
  }
  status() { return { pending: this._pending().length, running: !!this._timer, log: this._logSummary() }; }
  _logSummary() { return { resolved: this.log.resolved, parked: this.log.parked, reasons: { ...this.log.reasons }, recent: this.log.recent.slice(0, 8), startedAt: this.log.startedAt, updatedAt: this.log.updatedAt }; }

  // Load/save the run log. Save is throttled (~once/30s) so an all-night run on
  // FSAA isn't a write every tick; stop() forces a final save.
  async _loadLog() {
    try { const t = await this.store._readText('/resolver-log.json', ''); if (t) this.log = { resolved: 0, parked: 0, reasons: {}, recent: [], startedAt: null, updatedAt: null, ...JSON.parse(t) }; } catch { /* fresh */ }
  }
  _saveLog(force = false) {
    const t = Date.now();
    if (!force && this._lastLogSave && t - this._lastLogSave < 30_000) return;
    this._lastLogSave = t; this.log.updatedAt = t;
    try { this.store.vfs.writeFile('/resolver-log.json', JSON.stringify(this.log)).catch(() => {}); } catch { /* ignore */ }
  }
  _record(outcome, item, res) {
    if (outcome === 'resolved') { this.log.resolved++; return; }
    if (outcome === 'parked') {
      this.log.parked++;
      this.log.recent.unshift({ at: Date.now(), host: lrHostOf(item.url), reason: res.reason });
      if (this.log.recent.length > 50) this.log.recent.length = 50;
    }
  }

  // After an import: clear the parked-misses so a fresh import retries everything
  // (throttle may have lifted), then ask the runner for an immediate run (onKick).
  kick() { this._misses.clear(); if (!this.log.startedAt) this.log.startedAt = Date.now(); this._onKick?.(); }

  // ── rework ── Clear the `enriched` flag on saved links matching `matchFn` so
  // the drip re-fetches + re-applies metadata (after improving the title logic /
  // extractor, etc.). The url is already resolved, so this re-fetches the REAL
  // article — fast, no share.google throttle. Returns how many were queued.
  async reEnrich(matchFn) {
    const items = this.store.query({ feed_id: SAVED_FEED }).filter((r) => !r.archived && matchFn(r));
    for (const it of items) await this.store.upsertItems([{ id: it.id, feed_id: SAVED_FEED, enriched: false, resolve_parked: false }]);   // un-park too: an explicit re-enrich is a deliberate retry
    if (items.length) { await this.store.flush(); this.kick(); }
    return items.length;
  }
  // Re-enrich enriched items whose title is weak by the CURRENT rule — so a better
  // og:title is applied after isWeakTitle is improved (the "Source: X" fix).
  reEnrichWeakTitles() { return this.reEnrich((r) => r.enriched && isWeakTitle(r.title, r.url)); }

  // Flush the run log (e.g. on pagehide). No timer to clear — the runner owns it.
  stop() { this._saveLog(true); this.emit(); }

  // Fetch a saved link's page once and do both jobs from the single response:
  // follow redirects to the real url (if it's a wrapper) AND parse OpenGraph
  // metadata (thumbnail / better title / excerpt) + the article body. Updates the
  // item in place. Returns { ok, reason, … } — reason classifies failures
  // (http-NNN throttle/block, no-redirect, network) for the run log.
  async enrichOne(item) {
    let html = '', finalUrl = item.url;
    try {
      const r = await this.fetch(item.url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
      if (!r || !r.ok) return { ok: false, reason: 'http-' + ((r && r.status) || 'err') };
      if (r.url && !isWrappedUrl(r.url)) finalUrl = r.url;
      if (isWrappedUrl(finalUrl)) return { ok: false, reason: 'no-redirect' };   // still a wrapper — try again later
      html = await (r.text ? r.text().catch(() => '') : Promise.resolve(''));
    } catch { return { ok: false, reason: 'network' }; }

    const meta = parseLinkMeta(html);
    const img = meta.image && absUrl(meta.image, finalUrl);
    // Extract the article body from the SAME response (no second fetch) so the
    // cataloger gets full content + the link reads inline. Images stay suppressed
    // (weir's default; "load images" per-item still works).
    let content = null;
    if (this.extract && !item.has_content) { try { content = this.extract(html, finalUrl); } catch { /* unparseable page */ } }   // skip re-extraction on a re-enrich (already stored)

    const patch = { id: item.id, feed_id: SAVED_FEED, url: finalUrl, enriched: true };   // url write clears "unresolved"; enriched = fetched+parsed (won't re-fetch)
    if (img) patch.media = { ...(item.media || {}), thumbnail: img };
    if (meta.title && isWeakTitle(item.title, finalUrl)) patch.title = meta.title;
    if (meta.description && !item.excerpt) patch.excerpt = meta.description.slice(0, 300);
    if (content) patch.content = content;   // → has_content; cataloger uses it (capped at maxBodyChars)
    await this.store.upsertItems([patch]);
    return { ok: true, reason: 'ok', resolved: finalUrl !== item.url, thumb: !!img, content: !!content };
  }

  async tick() {
    if (this._busy) return;   // belt-and-suspenders alongside the runner's own guard
    this._busy = true;
    try {
      const batch = this._pending().slice(0, this.batch);
      if (!batch.length) { this._saveLog(); return; }
      let changed = 0;
      for (const it of batch) {
        const res = await this.enrichOne(it);
        if (res.ok) { this._misses.delete(it.id); changed++; this._record('resolved', it, res); }
        else {
          const m = (this._misses.get(it.id) || 0) + 1;
          this._misses.set(it.id, m);
          this.log.reasons[res.reason] = (this.log.reasons[res.reason] || 0) + 1;   // counts every failed try (throttle visibility)
          if (m >= this.maxMisses) {
            this._record('parked', it, res);
            // Persist the park so a dead link (e.g. a no-redirect share.google wrapper)
            // doesn't resurface on every reload and starve fresh work. Cleared only by
            // an explicit re-enrich. _misses is in-memory; resolve_parked is durable.
            await this.store.upsertItems([{ id: it.id, feed_id: SAVED_FEED, resolve_parked: true }]);
            changed++;
          }
        }
      }
      if (changed) await this.store.flush();
      this._saveLog();
      this.emit();
    } finally {
      this._busy = false;
    }
  }
}
