// Background runner — busy/enabled gating + the flight-deck driver switch.
// Run: node tools/smoke-runner.mjs
import assert from 'node:assert';
import { BackgroundRunner } from '../src/js/runner.js';

// A fake window: synchronous, controllable timers so the test is deterministic.
function fakeWin(label) {
  const timers = new Map(); let id = 0;
  return {
    label, timers,
    setInterval(fn) { const i = ++id; timers.set(i, fn); return i; },
    clearInterval(i) { timers.delete(i); },
    fireAll() { for (const fn of [...timers.values()]) fn(); },
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

console.log('runner smoke ok:', JSON.stringify({ a: aRuns, b: bRuns, cMax }));
