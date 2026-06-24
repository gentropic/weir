// Background runner — busy/enabled gating + the flight-deck driver switch.
// Run: node tools/smoke-runner.mjs
import assert from 'node:assert';
import { BackgroundRunner } from '../src/js/runner.js';

// A fake window: synchronous, controllable timers so the test is deterministic.
function fakeWin(label) {
  const timers = new Map(); const timeouts = new Map(); let id = 0;
  return {
    label, timers, timeouts,
    setInterval(fn) { const i = ++id; timers.set(i, fn); return i; },
    clearInterval(i) { timers.delete(i); },
    setTimeout(fn) { const i = ++id; timeouts.set(i, fn); return i; },
    clearTimeout(i) { timeouts.delete(i); },
    fireAll() { for (const fn of [...timers.values()]) fn(); },
    fireTimeouts() { const fns = [...timeouts.values()]; timeouts.clear(); for (const fn of fns) fn(); },   // one-shots fire once
  };
}
// _run is async (it awaits tick), so _busy clears a microtask after a fire — flush
// to let it settle before the next fire (real ticks are spaced by the interval).
const settle = () => Promise.resolve().then(() => Promise.resolve());

const main = fakeWin('main');
const r = new BackgroundRunner({ win: main });

let aRuns = 0, bRuns = 0, bEnabled = false;
r.add({ name: 'a', intervalMs: 1000, tick: () => { aRuns++; } });
r.add({ name: 'b', intervalMs: 1000, tick: () => { bRuns++; }, enabled: () => bEnabled });

main.fireAll(); await settle(); main.fireAll(); await settle();
assert.equal(aRuns, 2, 'a ran on every fire (always enabled)');
assert.equal(bRuns, 0, 'b skipped while disabled');
bEnabled = true; main.fireAll(); await settle();
assert.equal(bRuns, 1, 'b runs once enabled');

// busy-guard: a slow async tick is not re-entered (fires WITHOUT settling between)
let cConcurrent = 0, cMax = 0; let release;
r.add({ name: 'c', intervalMs: 1000, tick: () => new Promise((res) => { cConcurrent++; cMax = Math.max(cMax, cConcurrent); release = () => { cConcurrent--; res(); }; }) });
main.fireAll();   // c starts (busy)
main.fireAll();   // c still busy → skipped
release(); await settle();
assert.equal(cMax, 1, 'busy-guard prevents overlapping ticks');

// setDriver: re-points timers at the PiP window + clears the old (main) ones
const pip = fakeWin('pip');
r.setDriver(pip);
assert.equal(main.timers.size, 0, 'old (main) window timers cleared on driver switch');
assert.equal(pip.timers.size, 3, 'all three loops re-armed on the PiP window');
const before = aRuns; pip.fireAll(); await settle();
assert.equal(aRuns, before + 1, 'loops now tick from the PiP window (un-throttled keepalive)');
r.setDriver(null);
assert.equal(pip.timers.size, 0, 'PiP timers cleared when the deck closes');

// kick: run a task immediately, honoring enabled
bEnabled = false; const bWas = bRuns; r.kick('b'); await settle();
assert.equal(bRuns, bWas, 'kick respects enabled() (b disabled → no run)');
bEnabled = true; r.kick('b'); await settle();
assert.equal(bRuns, bWas + 1, 'kick runs an enabled task now');

// remove: dropped task is gone + its timer cleared
r.remove('a');
assert.ok(!r.tasks.some((t) => t.name === 'a'), 'removed task is gone');

// firstDelayMs: a one-shot lead-in fires once BEFORE the interval (responsive after a reload),
// then the interval carries it — and it doesn't re-fire on a driver switch.
{
  const w = fakeWin('lead'); const r2 = new BackgroundRunner({ win: w });
  let runs = 0;
  r2.add({ name: 'sync', intervalMs: 1000, firstDelayMs: 10, tick: () => { runs++; } });
  assert.equal(w.timeouts.size, 1, 'lead-in armed a one-shot timeout');
  assert.equal(runs, 0, 'nothing runs until a timer fires');
  w.fireTimeouts(); await settle();
  assert.equal(runs, 1, 'lead-in ticked once before any interval fire');
  r2.setDriver(fakeWin('lead2'));   // re-arm after the lead-in already fired
  assert.equal([...r2.tasks][0]._kicked, true, 'lead-in marked fired');
  r2.win.fireTimeouts && r2.win.fireTimeouts(); await settle();
  assert.equal(runs, 1, 'lead-in does NOT re-fire on a driver switch (once only)');
}

console.log('runner smoke ok:', JSON.stringify({ a: aRuns, b: bRuns, cMax }));
