// Favicon module tests. Run: node tools/smoke-favicon.mjs

import assert from 'node:assert';
import { faviconOrigin, monogram, needsFavicon, FaviconFetcher } from '../src/js/favicon.js';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';

// ── faviconOrigin: prefer the human site, fall back to the feed URL ──
assert.equal(faviconOrigin({ site_url: 'https://blog.example.com/about', url: 'https://feedproxy.io/x' }),
  'https://blog.example.com', 'site_url wins');
assert.equal(faviconOrigin({ url: 'https://news.example.org/atom.xml' }), 'https://news.example.org', 'falls back to feed url');
assert.equal(faviconOrigin({ name: 'no urls' }), null, 'no usable url → null');
assert.equal(faviconOrigin({ url: 'not a url' }), null, 'unparseable → null');

// ── monogram: deterministic letter + hue ──
const f = { name: 'The Verge', url: 'https://theverge.com/rss' };
assert.deepEqual(monogram(f), monogram(f), 'same feed → same monogram');
assert.equal(monogram(f).ch, 'T', 'first alnum letter');
assert.equal(monogram({ name: '———', url: 'https://x.io/f' }).ch, '#', 'no alnum → placeholder');
assert.ok(monogram(f).hue >= 0 && monogram(f).hue < 360, 'hue in range');
assert.notEqual(monogram({ name: 'A', url: 'https://a.io/f' }).hue, monogram({ name: 'B', url: 'https://b.io/f' }).hue,
  'different hosts → (usually) different hue');

// ── needsFavicon ──
const NOW = 1_700_000_000_000;
assert.equal(needsFavicon({ favicon: 'data:...' }, NOW), false, 'has icon → no');
assert.equal(needsFavicon({}, NOW), true, 'never checked → yes');
assert.equal(needsFavicon({ favicon_checked_at: NOW - 1000 }, NOW), false, 'checked recently → no');
assert.equal(needsFavicon({ favicon_checked_at: NOW - 40 * 86_400_000 }, NOW), true, 'stale miss → recheck');

// ── Response stub ──
function makeRes(status, type, bytes) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (String(k).toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}
const ICO = new Uint8Array([0, 0, 1, 0, 1, 0, 16, 16]);   // tiny but non-empty

const store = new Store(await VFS.create());
await store._hydrate();
await store.putFeed({ id: 'ok',   name: 'OK',   url: 'https://ok.example/feed' });
await store.putFeed({ id: 'html', name: 'Html', url: 'https://html.example/feed' });
await store.putFeed({ id: 'big',  name: 'Big',  url: 'https://big.example/feed' });
await store.putFeed({ id: 'gone', name: 'Gone', url: 'https://gone.example/feed' });

const fetcher = new FaviconFetcher(store, { fetch: async () => makeRes(200, 'image/x-icon', ICO), now: () => NOW });

// success → cached data URL + checked stamp
await fetcher._fetchOne('ok');
const okFeed = store.getFeed('ok');
assert.ok(okFeed.favicon?.startsWith('data:image/x-icon;base64,'), 'icon cached as data URL');
assert.equal(okFeed.favicon_checked_at, NOW, 'stamped checked_at on success');

// 200-but-HTML (error page) → no icon, but attempt recorded
fetcher.fetch = async () => makeRes(200, 'text/html', new Uint8Array([60, 33]));
await fetcher._fetchOne('html');
assert.equal(store.getFeed('html').favicon, undefined, 'HTML body rejected');
assert.equal(store.getFeed('html').favicon_checked_at, NOW, 'miss still stamps checked_at');

// oversized icon → rejected
fetcher.fetch = async () => makeRes(200, 'image/png', new Uint8Array(25_000));
await fetcher._fetchOne('big');
assert.equal(store.getFeed('big').favicon, undefined, 'oversized icon skipped');
assert.equal(store.getFeed('big').favicon_checked_at, NOW, 'oversized still stamps');

// 404 → no icon, attempt recorded (won't refetch until recheck window)
fetcher.fetch = async () => makeRes(404, 'text/html', new Uint8Array(0));
await fetcher._fetchOne('gone');
assert.equal(store.getFeed('gone').favicon, undefined, '404 → no icon');
assert.equal(store.getFeed('gone').favicon_checked_at, NOW, '404 stamps checked_at');

// ── enqueue: dedup + drains the queue end-to-end (short interval) ──
let calls = 0;
const store2 = new Store(await VFS.create());
await store2._hydrate();
await store2.putFeed({ id: 'a', name: 'A', url: 'https://a.example/feed' });
await store2.putFeed({ id: 'b', name: 'B', url: 'https://b.example/feed' });
await store2.putFeed({ id: 'cached', name: 'C', url: 'https://c.example/feed', favicon: 'data:image/png;base64,AA==' });
const f2 = new FaviconFetcher(store2, { fetch: async () => { calls++; return makeRes(200, 'image/x-icon', ICO); }, intervalMs: 3 });
f2.enqueue(store2.listFeeds());
f2.enqueue(store2.listFeeds());   // second call must not re-queue anything
await new Promise((r) => setTimeout(r, 60));
f2.stop();
assert.equal(calls, 2, 'fetched exactly the two un-cached feeds, once each (not the pre-cached one)');
assert.ok(store2.getFeed('a').favicon && store2.getFeed('b').favicon, 'both backfilled');

console.log('smoke-favicon: ok');
