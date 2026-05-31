// Recovery drip — a *very* slow background trickle that recovers archived/dead
// feeds from the Internet Archive, one request at a time (SPEC §10 / the IA must
// not be bothered). Each tick makes exactly ONE request: either a CDX query to
// start a feed, or a single snapshot fetch. On a long interval (default 8 min)
// that's ~7 requests/hour while the tab is open. State persists to /recovery.json
// so it resumes across restarts. Pauses when the tab is hidden.

import { cdxSnapshots } from './wayback.js';

const STATE_PATH = '/recovery.json';

function sampleCap(arr, n) {
  const pick = (s) => ({ timestamp: s.timestamp, original: s.original });
  if (arr.length <= n) return arr.map(pick);
  const out = []; const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(pick(arr[Math.round(i * step)]));
  return out;
}

export class RecoveryDrip {
  constructor(store, { fetch, parseFeed, intervalMs = 480_000, maxSnapshots = 60, autoStart = true } = {}) {
    this.store = store;
    this.fetch = fetch;
    this.parseFeed = parseFeed;
    this.intervalMs = intervalMs;
    this.maxSnapshots = maxSnapshots;
    this.autoStart = autoStart;
    this.queue = [];          // feed ids waiting
    this.current = null;      // { feedId, snaps: [{timestamp, original}], idx }
    this.done = [];           // recovered feed ids
    this._timer = null; this._busy = false; this._listeners = new Set();
  }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  emit() { const st = this.status(); this._listeners.forEach((fn) => { try { fn(st); } catch { /* ignore */ } }); }

  status() {
    return {
      queued: this.queue.length,
      current: this.current ? { feedId: this.current.feedId, idx: this.current.idx, total: this.current.snaps.length } : null,
      done: this.done.length,
      running: !!this._timer,
    };
  }

  async load() {
    const t = await this.store._readText(STATE_PATH, '');
    if (t) { try { const s = JSON.parse(t); this.queue = s.queue || []; this.current = s.current || null; this.done = s.done || []; } catch { /* ignore */ } }
  }
  async save() { await this.store.vfs.writeFile(STATE_PATH, JSON.stringify({ queue: this.queue, current: this.current, done: this.done })); }

  async enqueue(ids) {
    for (const id of ids) {
      if (id && !this.queue.includes(id) && !this.done.includes(id) && this.current?.feedId !== id) this.queue.push(id);
    }
    await this.save(); this.emit();
    if (this.autoStart && !this._timer && (this.queue.length || this.current)) this.start();
  }
  enqueueCategory(cat) { return this.enqueue(this.store.listFeeds().filter((f) => f.category === cat).map((f) => f.id)); }
  reset() { this.done = []; return this.save(); }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick().catch((e) => console.error('drip', e)), this.intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    this.emit();
    this.tick().catch(() => {});
  }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } this.emit(); }

  async tick() {
    if (this._busy) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;   // pause when hidden
    this._busy = true;
    try {
      if (!this.current) {
        const feedId = this.queue.shift();
        if (!feedId) { this.stop(); return; }
        const feed = this.store.getFeed(feedId);
        if (!feed) { await this.save(); return; }
        const snaps = await cdxSnapshots(feed.url, { fetch: this.fetch, limit: 1000 });   // one CDX request this tick
        if (!snaps.length) { this.done.push(feedId); await this.save(); this.emit(); return; }
        this.current = { feedId, snaps: sampleCap(snaps, this.maxSnapshots), idx: 0 };
        await this.save(); this.emit();
        return;
      }
      const { feedId, snaps, idx } = this.current;
      if (idx >= snaps.length) { this.done.push(feedId); this.current = null; await this.save(); this.emit(); return; }
      const s = snaps[idx];
      const feed = this.store.getFeed(feedId) || { id: feedId };
      try {
        const res = await this.fetch(`https://web.archive.org/web/${s.timestamp}id_/${s.original}`);   // one snapshot this tick
        if (res.ok) await this.store.upsertItems(this.parseFeed(await res.text(), { feed }).items);
      } catch { /* skip this snapshot */ }
      this.current.idx++;
      await this.save(); this.emit();
    } finally {
      this._busy = false;
    }
  }
}
