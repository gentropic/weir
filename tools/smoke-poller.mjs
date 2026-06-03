// Poller + format-helper tests (node; fetch is injected, no network/DOM).
// Run: node tools/smoke-poller.mjs

import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { feedAdapter } from '../src/js/adapters/feed.js';
import { Poller, pollIntervalFor } from '../src/js/poller.js';
import { relativeTime, dailyCounts, sparkPoints, fmtDuration } from '../src/js/ui/format.js';

// ── format ──
const NOW = 1_700_000_000_000;
assert.equal(relativeTime(NOW - 2 * 3600_000, NOW), '2h', 'hours');
assert.equal(relativeTime(NOW - 3 * 86_400_000, NOW), '3d', 'days');
assert.match(relativeTime(NOW - 30 * 86_400_000, NOW), /^[A-Z][a-z]{2} \d{1,2}$/, 'absolute past 7d');
assert.equal(fmtDuration(3723), '1:02:03', 'duration');
const dc = dailyCounts([NOW, NOW - 86_400_000], 7, NOW);
assert.equal(dc.length, 7); assert.equal(dc[6], 1); assert.equal(dc[5], 1);
assert.ok(sparkPoints([1, 2, 3]).length > 0, 'sparkline points');

// ── poller ──
const RSS = `<rss version="2.0"><channel><title>F</title>
  <item><title>A</title><guid>a</guid><link>http://x/a</link></item>
  <item><title>B</title><guid>b</guid></item></channel></rss>`;
const mockResponse = (body, ct = 'application/rss+xml') => ({
  status: 200,
  headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? ct : null) },
  clone() { return mockResponse(body, ct); }, async text() { return body; },
});
// Header-accurate response for conditional-GET tests.
const mkRes = ({ status = 200, ct = 'application/rss+xml', body = '', headers = {} } = {}) => {
  const h = new Map(Object.entries({ 'content-type': ct, ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return { status, headers: { get: (k) => (h.has(String(k).toLowerCase()) ? h.get(String(k).toLowerCase()) : null) }, clone() { return mkRes({ status, ct, body, headers }); }, async text() { return body; } };
};

const store = new Store(await VFS.create());
await store._hydrate();
await store.putFeed({ id: 'f', name: 'F', adapter: 'feed', url: 'http://x/feed', next_poll_at: NOW - 1000 });

let calls = 0;
const poller = new Poller(store, { adapters: [feedAdapter], fetch: async () => { calls++; return mockResponse(RSS); } });

const r = await poller.pollFeed(store.getFeed('f'));
assert.deepEqual(r, { inserted: 2, updated: 0, skipped: 0 }, 'poll inserts');
assert.equal(calls, 1, 'one fetch');
assert.equal(store.counts().inbox, 2, 'items in store');
let f = store.getFeed('f');
assert.equal(f.feed_health.consecutive_failures, 0, 'health reset on success');
assert.ok(f.next_poll_at > Date.now(), 'next poll scheduled forward');
assert.equal(f.state, 'healthy', 'healthy');

// Re-poll (dedup): same items → all updated, none new.
const r2 = await poller.pollFeed(store.getFeed('f'));
assert.deepEqual(r2, { inserted: 0, updated: 2, skipped: 0 }, 're-poll dedups');

// Failure path.
const bad = new Poller(store, { adapters: [feedAdapter], fetch: async () => { throw new Error('network down'); } });
const r3 = await bad.pollFeed(store.getFeed('f'));
assert.ok(r3.error, 'error surfaced');
f = store.getFeed('f');
assert.equal(f.feed_health.consecutive_failures, 1, 'failure counted');
assert.equal(f.feed_health.last_error, 'network down', 'error recorded');

// ── adaptive poll interval (pollIntervalFor) ──
const S = { default_poll_interval_minutes: 180 };
const base = pollIntervalFor({ affinity: 0 }, S);
assert.equal(base, 180, 'neutral feed = baseline');
assert.ok(pollIntervalFor({ affinity: 120 }, S) < base, 'core (high affinity) polls more often');
assert.equal(pollIntervalFor({ affinity: 120 }, S), 72, 'affinity≥100 → base×0.4');
assert.ok(pollIntervalFor({ affinity: 5 }, S) > base, 'subscribed-but-barely-watched polls less often');
assert.ok(pollIntervalFor({ affinity: 0, state: 'failing' }, S) >= pollIntervalFor({ affinity: 0 }, S) * 3, 'failing feed backs off hard');
// cadence: proven low-volume (with ≥3wk history) slows down; high-volume speeds up
assert.ok(pollIntervalFor({ affinity: 0 }, S, { itemsPerWeek: 0.2, spanWeeks: 12 }) > base, 'low-volume slows');
assert.ok(pollIntervalFor({ affinity: 0 }, S, { itemsPerWeek: 30, spanWeeks: 12 }) < base, 'high-volume speeds up');
assert.equal(pollIntervalFor({ affinity: 0 }, S, { itemsPerWeek: 0.1, spanWeeks: 1 }), base, 'short history → cadence ignored (new feed not starved)');
// clamps
assert.ok(pollIntervalFor({ affinity: 200, state: 'healthy' }, { default_poll_interval_minutes: 20 }) >= 30, 'never faster than 30 min');
assert.ok(pollIntervalFor({ affinity: 0, state: 'failing' }, { default_poll_interval_minutes: 100000 }) <= 7 * 24 * 60, 'never slower than weekly');

// integration: adaptive ON makes a high-affinity feed's next_poll sooner than a neutral one
await store.setSettings({ adaptive_polling: true, default_poll_interval_minutes: 180 });
await store.putFeed({ id: 'core', name: 'Core', adapter: 'feed', url: 'http://x/feed', affinity: 150, next_poll_at: NOW - 1000 });
const okp = new Poller(store, { adapters: [feedAdapter], fetch: async () => mockResponse(RSS) });
await okp.pollFeed(store.getFeed('core'));
await okp.pollFeed(store.getFeed('f'));
const coreGap = store.getFeed('core').next_poll_at - Date.now();
const fGap = store.getFeed('f').next_poll_at - Date.now();
assert.ok(coreGap < fGap, 'adaptive: favorite re-polls sooner than a neutral feed');

// ── conditional GET: capture validators, send them, skip parse on unchanged ──
await store.putFeed({ id: 'cg', name: 'CG', adapter: 'feed', url: 'http://x/feed', next_poll_at: NOW - 1000 });
const seen = [];   // headers sent on each fetch
let phase = 0;
const cgFetch = async (url, opts = {}) => {
  seen.push(opts.headers || {});
  if (phase === 0) return mkRes({ status: 200, body: RSS, headers: { etag: 'W/"v1"', 'last-modified': 'Mon, 01 Jun 2026 00:00:00 GMT' } });
  if (phase === 1) return mkRes({ status: 304, ct: 'text/plain' });             // server: not modified
  return mkRes({ status: 200, ct: 'text/plain', headers: { 'x-gcu-bridge-cache': 'hit' } });   // bridge cache hit
};
const cg = new Poller(store, { adapters: [feedAdapter], fetch: cgFetch });

phase = 0; const c0 = await cg.pollFeed(store.getFeed('cg'));
assert.equal(c0.inserted, 2, 'first poll inserts');
assert.equal(store.getFeed('cg').etag, 'W/"v1"', 'etag captured from 200 response');
assert.equal(store.getFeed('cg').last_modified, 'Mon, 01 Jun 2026 00:00:00 GMT', 'last-modified captured');
assert.deepEqual(seen[0], {}, 'no conditional headers on the first poll (nothing stored yet)');

phase = 1; const c1 = await cg.pollFeed(store.getFeed('cg'));
assert.equal(c1.unchanged, true, '304 → unchanged, no parse');
assert.equal(seen[1]['If-None-Match'], 'W/"v1"', 'sent If-None-Match from stored etag');
assert.equal(seen[1]['If-Modified-Since'], 'Mon, 01 Jun 2026 00:00:00 GMT', 'sent If-Modified-Since');

phase = 2; const c2 = await cg.pollFeed(store.getFeed('cg'));
assert.equal(c2.unchanged, true, 'bridge x-gcu-bridge-cache: hit → unchanged');

const cgStats = cg.stats();
assert.equal(cgStats.fetches, 3, 'three fetches');
assert.equal(cgStats.unchanged, 2, 'two confirmed-unchanged');
assert.ok(Math.abs(cgStats.ratio - 2 / 3) < 1e-9, 'ratio = unchanged/fetches');

// ── force poll: skip conditional GET + ignore cache "fresh" → re-parse the body ──
// (powers weir_repoll — re-derives titles even when the server/bridge says
// unchanged). The scenario that defeats a normal poll: a bridge cache hit that
// STILL carries the body. force must bypass the short-circuit and re-parse it,
// without sending conditional headers or losing the stored validators.
{
  await store.putFeed({ id: 'fp', name: 'FP', adapter: 'feed', url: 'http://x/feed', next_poll_at: NOW - 1000 });
  const hdrs = [];
  // Always a cache HIT that still carries the body (the bridge masks 304 as
  // 200 + x-gcu-bridge-cache: hit, body included).
  const fpFetch = async (url, opts = {}) => { hdrs.push(opts.headers || {}); return mkRes({ status: 200, body: RSS, headers: { 'x-gcu-bridge-cache': 'hit', etag: 'W/"keep"' } }); };
  const fp = new Poller(store, { adapters: [feedAdapter], fetch: fpFetch });
  // Seed items (first poll has no stored items → hasItems false → it parses).
  const s0 = await fp.pollFeed(store.getFeed('fp'));
  assert.equal(s0.inserted, 2, 'seed poll inserts');
  // NORMAL poll now short-circuits on the cache hit (hasItems true).
  const n0 = await fp.pollFeed(store.getFeed('fp'));
  assert.equal(n0.unchanged, true, 'normal poll on a cache hit short-circuits (no re-parse)');
  // FORCE bypasses it and re-parses the same body → items updated.
  const f0 = await fp.pollFeed(store.getFeed('fp'), { force: true });
  assert.equal(f0.unchanged, undefined, 'force does NOT short-circuit on a cache hit');
  assert.equal(f0.updated, 2, 'force re-parses the body → items updated (re-derives titles)');
  assert.deepEqual(hdrs[2], {}, 'force sends no conditional headers');
  assert.equal(store.getFeed('fp').etag, 'W/"keep"', 'force preserves the stored etag');
}

// ── setKeepAlive: flight-deck-driven poll tick on an injected (PiP) window ──
{
  const ka = new Poller(store, { adapters: [feedAdapter], fetch: async () => mkRes({ status: 304 }) });
  let scheduled = null, cleared = false;
  const fakePip = { setInterval: (fn) => { scheduled = fn; return 7; }, clearInterval: (id) => { cleared = (id === 7); } };
  ka.setKeepAlive(fakePip);
  assert.equal(typeof scheduled, 'function', 'keep-alive tick scheduled on the PiP window');
  let polled = 0; const orig = ka.pollDue.bind(ka); ka.pollDue = (...a) => { polled++; return orig(...a); };
  await scheduled();                         // simulate a PiP timer fire
  assert.equal(polled, 1, 'PiP tick drives pollDue');
  ka.setKeepAlive(null);
  assert.equal(cleared, true, 'keep-alive cleared via the PiP window');
}

console.log('poller smoke ok:', JSON.stringify(store.counts()));
