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

export class LinkResolver {
  constructor(store, { fetch, intervalMs = 15_000, batch = 2, maxMisses = 8 } = {}) {
    this.store = store;
    this.fetch = fetch;
    this.intervalMs = intervalMs;
    this.batch = batch;
    this.maxMisses = maxMisses;     // park a link after this many failed ticks (until the next kick / reload)
    this._misses = new Map();       // id → consecutive miss count
    this._timer = null; this._busy = false; this._listeners = new Set();
  }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  emit() { const st = this.status(); this._listeners.forEach((fn) => { try { fn(st); } catch { /* ignore */ } }); }

  _pending() {
    return this.store.query({ feed_id: SAVED_FEED })
      .filter((r) => !r.archived && isWrappedUrl(r.url) && (this._misses.get(r.id) || 0) < this.maxMisses);
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

  async _resolve(url) {
    try {
      const r = await this.fetch(url, { redirect: 'follow', headers: { 'cache-control': 'no-cache' } });
      if (r && r.ok && r.url && r.url !== url && !isWrappedUrl(r.url)) return r.url;
    } catch { /* throttled/offline — retry next tick */ }
    return null;
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
        const final = await this._resolve(it.url);
        if (final) {
          await this.store.upsertItems([{ id: it.id, feed_id: SAVED_FEED, url: final, title: it.title }]);
          this._misses.delete(it.id);
          changed++;
        } else {
          this._misses.set(it.id, (this._misses.get(it.id) || 0) + 1);
        }
      }
      if (changed) await this.store.flush();
      this.emit();
    } finally {
      this._busy = false;
    }
  }
}
