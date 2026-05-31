// Recovery drip test with a mock fetch (no network). Verifies one-request-per-tick,
// item accumulation, completion, and persistence/resume. Run: node tools/smoke-recovery.mjs

import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { parseFeed } from '../src/js/adapters/feed.js';
import { RecoveryDrip } from '../src/js/recovery.js';

const CDX = [
  ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
  ['x', '20100101000000', 'http://dead/feed', 't', '200', 'D1', '1'],
  ['x', '20110101000000', 'http://dead/feed', 't', '200', 'D2', '1'],
];
const SNAP1 = `<rss version="2.0"><channel><title>Dead</title><item><title>Old A</title><guid>a</guid></item></channel></rss>`;
const SNAP2 = `<rss version="2.0"><channel><title>Dead</title><item><title>Old B</title><guid>b</guid></item></channel></rss>`;
let reqs = 0;
const fetch = async (url) => {
  reqs++;
  if (url.includes('/cdx/')) return { ok: true, status: 200, async json() { return CDX; } };
  if (url.includes('20100101')) return { ok: true, status: 200, async text() { return SNAP1; } };
  return { ok: true, status: 200, async text() { return SNAP2; } };
};

const vfs = await VFS.create();
const store = new Store(vfs); await store._hydrate();
await store.putFeed({ id: 'dead', name: 'Dead', adapter: 'feed', url: 'http://dead/feed', state: 'archived' });

const drip = new RecoveryDrip(store, { fetch, parseFeed, autoStart: false });   // drive tick() manually
await drip.load();
await drip.enqueue(['dead']);

// tick 1: CDX (one request), sets current
await drip.tick();
assert.equal(reqs, 1, 'tick 1 = one CDX request');
assert.equal(drip.current.feedId, 'dead', 'feed in progress');
assert.equal(drip.current.snaps.length, 2, 'two distinct snapshots');

// tick 2: first snapshot
await drip.tick();
assert.equal(reqs, 2, 'tick 2 = one snapshot request');
assert.equal(store.getItem('dead:a') != null, true, 'item from snapshot 1 stored');

// tick 3: second snapshot
await drip.tick();
assert.equal(store.getItem('dead:b') != null, true, 'item from snapshot 2 stored');

// tick 4: completes the feed
await drip.tick();
assert.ok(drip.done.includes('dead'), 'feed marked done');
assert.equal(drip.current, null, 'no current feed');

// persistence: a fresh drip over the same store resumes the done-state
const drip2 = new RecoveryDrip(store, { fetch, parseFeed, autoStart: false });
await drip2.load();
assert.ok(drip2.done.includes('dead'), 'done-state persisted + reloaded');

// already-done feed is not re-enqueued
await drip2.enqueue(['dead']);
assert.equal(drip2.queue.length, 0, 'done feed not re-queued');

console.log('recovery smoke ok:', JSON.stringify({ items: store.counts().total, done: drip.done.length, requests: reqs }));
