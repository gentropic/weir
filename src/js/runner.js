// Central background runner — the one place every background loop registers, so
// "keep running when the tab's backgrounded" is INFRASTRUCTURE, not per-task
// discipline you can forget. A loop registers its essence — { name, intervalMs,
// tick, enabled? } — and the runner owns the timer, the busy-guard, and the
// enabled check. The flight-deck calls setDriver(pipWindow) / setDriver(null) ONCE
// to re-point EVERY loop's timer at its always-visible (un-throttled) window and
// back. Add a new loop with runner.add(...) and it's kept alive for free — there's
// no separate keep-alive path left to forget (the poller/resolver/telegram bug).
//
// Timer ids are per-window, so each task remembers which window armed it (to clear
// it correctly when the driver switches).

export class BackgroundRunner {
  constructor({ win } = {}) {
    this.win = win || (typeof window !== 'undefined' ? window : globalThis);
    this.tasks = [];
  }

  // task: { name, intervalMs, tick: async()=>{}, enabled?: ()=>boolean }
  add(task) {
    const t = {
      name: task.name || `task-${this.tasks.length}`,
      intervalMs: Math.max(1000, task.intervalMs || 30_000),
      tick: task.tick, enabled: task.enabled || null,
      _timer: null, _timerWin: null, _busy: false,
    };
    this.tasks.push(t);
    this._arm(t);
    return t;
  }

  remove(name) { this.tasks = this.tasks.filter((t) => (t.name === name ? (this._disarm(t), false) : true)); }

  // The flight-deck's single switch: drive every loop from `win` (the PiP window,
  // which the browser doesn't throttle because it's always visible), or null → the
  // main window. New tasks added later inherit the current driver automatically.
  setDriver(win) {
    this.win = win || (typeof window !== 'undefined' ? window : globalThis);
    for (const t of this.tasks) this._arm(t);
  }

  // Run a task NOW (e.g. right after an import kicks the resolver), busy/enabled-aware.
  kick(name) { const t = this.tasks.find((x) => x.name === name); if (t) this._run(t); }

  _disarm(t) { if (t._timer && t._timerWin) { try { t._timerWin.clearInterval(t._timer); } catch { /* window gone */ } } t._timer = null; t._timerWin = null; }
  _arm(t) {
    this._disarm(t);
    t._timerWin = this.win;
    t._timer = this.win.setInterval(() => this._run(t), t.intervalMs);
    if (t._timer && typeof t._timer.unref === 'function') t._timer.unref();
  }
  async _run(t) {
    if (t._busy) return;
    if (t.enabled && !t.enabled()) return;
    t._busy = true;
    try { await t.tick(); } catch (e) { console.error('runner:', t.name, e); } finally { t._busy = false; }
  }
}
