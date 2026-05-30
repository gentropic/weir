// Poller + format-helper tests (node; fetch is injected, no network/DOM).
// Run: node tools/smoke-poller.mjs

import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { feedAdapter } from '../src/js/adapters/feed.js';
import { Poller } from '../src/js/poller.js';
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
  headers: { get: () => ct }, clone() { return mockResponse(body, ct); }, async text() { return body; },
});

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

console.log('poller smoke ok:', JSON.stringify(store.counts()));
