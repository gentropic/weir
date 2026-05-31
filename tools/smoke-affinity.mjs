// Watch-affinity tests. Run: node tools/smoke-affinity.mjs

import assert from 'node:assert';
import { affinityScore, channelIdOf, parseWatchDigest } from '../src/js/affinity.js';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';

// Recency weighting: a stale fad (high count, old) must score far below a
// recently-watched channel — the "Pirate Software" fix.
const fad = affinityScore({ watches: 199, months_since: 30 });   // binged 2.5y ago
const live = affinityScore({ watches: 60, months_since: 1 });    // watched last month
assert.ok(fad < live, `stale fad (${fad}) ranks below recent (${live})`);
assert.equal(affinityScore({ watches: 100, months_since: 1 }), 100, 'recent: full weight');
assert.equal(affinityScore({ watches: 100, months_since: 30 }), 8, 'stale: heavy decay');
assert.equal(affinityScore(null), 0, 'no entry → 0');

// channel id extraction
assert.equal(channelIdOf('https://www.youtube.com/feeds/videos.xml?channel_id=UC123'), 'UC123', 'from feed url');
assert.equal(channelIdOf('https://www.youtube.com/channel/UCabc'), 'UCabc', 'from channel url');
assert.equal(channelIdOf('https://example.com/feed'), null, 'non-youtube → null');

// digest → score map
const map = parseWatchDigest({ UC123: { watches: 50, months_since: 2 }, UCold: { watches: 200, months_since: 40 } });
assert.equal(map.UC123, 50, 'recent score');
assert.equal(map.UCold, 16, 'stale score (200*0.08)');

// store integration: stamp matching feeds, ordering data present
const store = new Store(await VFS.create());
await store._hydrate();
await store.putFeed({ id: 'core', name: 'Core', adapter: 'youtube', url: 'https://www.youtube.com/feeds/videos.xml?channel_id=UC123', category: 'yt' });
await store.putFeed({ id: 'blog', name: 'Blog', adapter: 'feed', url: 'https://example.com/rss', category: 'dev' });
const r = await store.applyAffinity(map);
assert.equal(r.matched, 1, 'one youtube feed matched');
assert.equal(store.getFeed('core').affinity, 50, 'affinity stamped on the youtube feed');
assert.equal(store.getFeed('blog').affinity, 0, 'non-matching feed untouched');
assert.equal(store.feedsWithAffinity(), 1, 'one feed has affinity');

console.log('affinity smoke ok:', JSON.stringify({ fad, live, matched: r.matched }));
