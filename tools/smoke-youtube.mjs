// YouTube adapter tests (node, fixture from a real channel feed).
// Run: node tools/smoke-youtube.mjs

import assert from 'node:assert';
import { parseYoutube, youtubeAdapter } from '../src/js/adapters/youtube.js';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';

const FEED = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" xmlns:media="http://search.yahoo.com/mrss/" xmlns="http://www.w3.org/2005/Atom">
  <title>Happery</title>
  <author><name>Happery</name><uri>https://www.youtube.com/channel/UC7H0N-PmBENTsmpnlwtiGSw</uri></author>
  <entry>
    <id>yt:video:ybODZ_fXP-I</id>
    <yt:videoId>ybODZ_fXP-I</yt:videoId>
    <yt:channelId>UC7H0N-PmBENTsmpnlwtiGSw</yt:channelId>
    <title>1 to 99 Construction | One Chunk UIM #16</title>
    <link rel="alternate" href="https://www.youtube.com/watch?v=ybODZ_fXP-I"/>
    <author><name>Happery</name><uri>https://www.youtube.com/channel/UC7H0N-PmBENTsmpnlwtiGSw</uri></author>
    <published>2026-03-09T17:01:22+00:00</published>
    <media:group>
      <media:title>1 to 99 Construction | One Chunk UIM #16</media:title>
      <media:thumbnail url="https://i2.ytimg.com/vi/ybODZ_fXP-I/hqdefault.jpg" width="480" height="360"/>
      <media:description>In this series, I complete every challenge.</media:description>
      <media:community><media:statistics views="120534"/></media:community>
    </media:group>
  </entry>
</feed>`;

const feed = { id: 'happery' };
const { meta, items } = parseYoutube(FEED, { feed });
assert.equal(meta.title, 'Happery', 'channel title');
assert.equal(items.length, 1, 'one video');
const v = items[0];
assert.equal(v.type, 'video', 'video type');
assert.equal(v.id, 'happery:ybODZ_fXP-I', 'feed-scoped stable id from videoId');
assert.equal(v.url, 'https://www.youtube.com/watch?v=ybODZ_fXP-I', 'watch url');
assert.equal(v.author, 'Happery', 'channel as author');
assert.equal(v.media.thumbnail, 'https://i2.ytimg.com/vi/ybODZ_fXP-I/hqdefault.jpg', 'thumbnail');
assert.equal(v.structured.views, 120534, 'view count');
assert.equal(v.structured.channel_id, 'UC7H0N-PmBENTsmpnlwtiGSw', 'channel id');
assert.equal(typeof v.published_at, 'number', 'date parsed');

// match + autodiscovery
assert.ok(youtubeAdapter.match('https://www.youtube.com/feeds/videos.xml?channel_id=UC1'), 'matches feed url');
assert.ok(youtubeAdapter.match('https://youtube.com/@somehandle'), 'matches handle url');
assert.equal(youtubeAdapter.detectFeedUrl('https://www.youtube.com/channel/UCabc123', ''), 'https://www.youtube.com/feeds/videos.xml?channel_id=UCabc123', 'resolve from channel url');
assert.equal(youtubeAdapter.detectFeedUrl('https://www.youtube.com/@h', '"channelId":"UCxyz789"'), 'https://www.youtube.com/feeds/videos.xml?channel_id=UCxyz789', 'resolve from page html');
assert.equal(parseYoutube('<html><body>not a feed</body></html>', { feed }).items.length, 0, 'channel HTML page → 0 items (triggers autodiscovery)');

// into the store
const store = new Store(await VFS.create());
await store._hydrate();
await store.putFeed({ id: 'happery', name: 'Happery', adapter: 'youtube', url: 'http://x' });
const r = await store.upsertItems(items);
assert.deepEqual(r, { inserted: 1, updated: 0, skipped: 0 }, 'video stored');
assert.equal(store.query({ type: 'video' }).length, 1, 'queryable as video');

console.log('youtube smoke ok:', JSON.stringify({ id: v.id, views: v.structured.views }));
