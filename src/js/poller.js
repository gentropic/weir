// Poller — schedules per-feed fetches through the bridge and feeds the store
// (SPEC §1 lifecycle). Fetch and the adapter set are injected so it's testable
// in node without network or DOM.

export class Poller {
  constructor(store, opts = {}) {
    this.store = store;
    this.fetch = opts.fetch || ((url) => fetch(url));
    this.adapters = opts.adapters || [];
    this.tickMs = opts.tickMs || 60_000;
    this._timer = null;
    this._running = new Set();        // feed ids currently in flight
    this._listeners = new Map();
    this.lastPollAt = null;
  }

  on(ev, fn) { (this._listeners.get(ev) || this._listeners.set(ev, new Set()).get(ev)).add(fn); return () => this._listeners.get(ev)?.delete(fn); }
  emit(ev, data) { this._listeners.get(ev)?.forEach((fn) => { try { fn(data); } catch (e) { console.error(e); } }); }

  pickAdapter(feed) {
    return this.adapters.find((a) => a.name === feed.adapter)
      || this.adapters.find((a) => { try { return a.match(feed.url); } catch { return false; } })
      || this.adapters[0];
  }

  // Poll a single feed: fetch → (autodiscover if the body is a web page) →
  // parse → upsert → record health. Never throws; failures land in feed_health.
  async pollFeed(feed) {
    if (this._running.has(feed.id)) return null;
    this._running.add(feed.id);
    const adapter = this.pickAdapter(feed);
    const intervalMs = (feed.poll_interval_minutes || 30) * 60_000;
    try {
      let res = await this.fetch(feed.url);
      let items = await adapter.parse(res.clone ? res.clone() : res, feed);

      // Pasted a site URL, not a feed? Try autodiscovery once.
      if (items.length === 0 && adapter.detectFeedUrl) {
        const text = await res.text().catch(() => '');
        if (/<html[\s>]/i.test(text)) {
          const found = adapter.detectFeedUrl(feed.url, text);
          if (found && found !== feed.url) {
            feed.url = found;
            res = await this.fetch(found);
            items = await adapter.parse(res, feed);
          }
        }
      }

      const result = await this.store.upsertItems(items);
      const h = feed.feed_health || (feed.feed_health = { consecutive_failures: 0, publication_history: [] });
      const t = Date.now();
      h.consecutive_failures = 0;
      h.last_successful_poll = t;
      h.last_error = undefined;
      feed.last_polled_at = t;
      feed.next_poll_at = t + intervalMs;
      feed.state = 'healthy';
      await this.store.putFeed(feed);
      this.emit('polled', { feed, result });
      return result;
    } catch (e) {
      const h = feed.feed_health || (feed.feed_health = { consecutive_failures: 0, publication_history: [] });
      const t = Date.now();
      h.consecutive_failures = (h.consecutive_failures || 0) + 1;
      h.last_error = e.message;
      feed.last_polled_at = t;
      feed.next_poll_at = t + intervalMs;
      if (h.consecutive_failures >= 5) feed.state = 'failing';
      await this.store.putFeed(feed);
      this.emit('polled', { feed, error: e });
      return { error: e.message };
    } finally {
      this._running.delete(feed.id);
      this.lastPollAt = Date.now();
    }
  }

  // Fetch all feeds whose next_poll_at has elapsed, capped at N concurrent.
  async pollDue(force = false) {
    const due = this.store.listFeeds().filter((f) => f.state !== 'archived' && (force || (f.next_poll_at || 0) <= Date.now()));
    return this._runPool(due);
  }

  pollAll() { return this.pollDue(true); }

  async _runPool(feeds) {
    const cap = this.store.getSettings().poll_concurrency || 8;
    const queue = [...feeds];
    const results = [];
    const workers = Array.from({ length: Math.min(cap, queue.length) }, async () => {
      while (queue.length) results.push(await this.pollFeed(queue.shift()));
    });
    await Promise.all(workers);
    this.emit('cycle', { count: feeds.length });
    return results;
  }

  start() {
    if (this._timer) return;
    this.pollDue();
    this._timer = setInterval(() => {
      if (this.store.getSettings().pause_polling_when_hidden && typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      this.pollDue();
    }, this.tickMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  // Next scheduled poll across all feeds (epoch ms), or null.
  nextPollAt() {
    let next = null;
    for (const f of this.store.listFeeds()) {
      if (f.state === 'archived') continue;
      if (next == null || (f.next_poll_at || 0) < next) next = f.next_poll_at || 0;
    }
    return next;
  }
}
