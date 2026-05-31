// Retainer — runs the retention sweep on open and on a schedule (SPEC §5).
// Retention ARCHIVES expired items into the archived view; it never deletes.
// Saved, routed, and already-archived items are left alone. Off by default
// (settings.retention_enabled) so nothing expires until you choose.
//
// "Cold storage" (offloading archived items out of the hot in-memory index) is
// a later refinement; for now archived items stay fully readable in the store.

export class Retainer {
  constructor(store, { intervalMs = 3_600_000 } = {}) {   // hourly check
    this.store = store;
    this.intervalMs = intervalMs;
    this._timer = null;
    this.lastSweep = null;
    this.lastArchived = 0;
  }

  sweep() {
    const r = this.store.runRetention();
    this.lastSweep = Date.now();
    this.lastArchived = r.archived;
    return r;
  }

  start() {
    if (this._timer) return;
    this.sweep();   // catch-up on open
    this._timer = setInterval(() => this.sweep(), this.intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }
}
