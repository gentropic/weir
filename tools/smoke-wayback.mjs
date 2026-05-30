// Wayback recovery tests with a mock fetch (no network). Run: node tools/smoke-wayback.mjs

import assert from 'node:assert';
import { cdxSnapshots, recoverFeed } from '../src/js/wayback.js';
import { parseFeed } from '../src/js/adapters/feed.js';

// Mock CDX: 3 distinct snapshots; mock snapshots: two different feed states that
// overlap on item "b" so dedup must collapse it.
const CDX_JSON = [
  ['urlkey', 'timestamp', 'original', 'mimetype', 'statuscode', 'digest', 'length'],
  ['x', '20100101000000', 'http://x/feed', 'text/xml', '200', 'D1', '1'],
  ['x', '20110101000000', 'http://x/feed', 'text/xml', '200', 'D2', '1'],
  ['x', '20120101000000', 'http://x/feed', 'text/xml', '200', 'D2', '1'], // dup digest → collapsed by CDX param, also client-side
];
const SNAP_2010 = `<rss version="2.0"><channel><title>X</title>
  <item><title>Post A</title><guid>a</guid></item>
  <item><title>Post B</title><guid>b</guid></item></channel></rss>`;
const SNAP_2011 = `<rss version="2.0"><channel><title>X</title>
  <item><title>Post B</title><guid>b</guid></item>
  <item><title>Post C</title><guid>c</guid></item></channel></rss>`;

const calls = [];
const mockFetch = async (url) => {
  calls.push(url);
  if (url.includes('/cdx/')) return { ok: true, status: 200, async json() { return CDX_JSON; } };
  if (url.includes('20100101')) return { ok: true, status: 200, async text() { return SNAP_2010; } };
  return { ok: true, status: 200, async text() { return SNAP_2011; } };
};

const snaps = await cdxSnapshots('http://x/feed', { fetch: mockFetch });
assert.equal(snaps.length, 2, 'distinct digests only (D1, D2)');
assert.equal(snaps[0].timestamp, '20100101000000', 'oldest first');

const feed = { id: 'x' };
const r = await recoverFeed('http://x/feed', { fetch: mockFetch, parseFeed, feed, minIntervalMs: 0, maxSnapshots: 40 });
assert.equal(r.fetched, 2, 'fetched both distinct snapshots');
assert.equal(r.failed, 0, 'no failures');
// Union of {a,b} and {b,c} = {a,b,c}, deduped across snapshots.
const ids = r.items.map((i) => i.id).sort();
assert.deepEqual(ids, ['x:a', 'x:b', 'x:c'], 'history reconstructed + deduped');

// Cap respected.
const many = Array.from({ length: 100 }, (_, i) => ['x', String(20000101000000 + i), 'http://x/feed', 't', '200', 'D' + i, '1']);
const capFetch = async (url) => url.includes('/cdx/')
  ? { ok: true, status: 200, async json() { return [CDX_JSON[0], ...many]; } }
  : { ok: true, status: 200, async text() { return SNAP_2011; } };
const capped = await recoverFeed('http://x/feed', { fetch: capFetch, parseFeed, feed, minIntervalMs: 0, maxSnapshots: 10 });
assert.equal(capped.total, 10, 'snapshot cap honored');

console.log('wayback smoke ok:', JSON.stringify({ snaps: snaps.length, recovered: ids.length }));
