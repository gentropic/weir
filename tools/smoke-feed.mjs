// Parser/adapter tests against inline fixtures (no network). Covers RSS 2.0,
// Atom 1.0, JSON Feed: stable ids, date parsing, sanitization, podcast/media,
// and a full parse → store.upsertItems round-trip. Run: node tools/smoke-feed.mjs

import assert from 'node:assert';
import { parseFeed, feedAdapter } from '../src/js/adapters/feed.js';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';

const feed = { id: 'demo', images_allowed: false };

// ── RSS 2.0 ──
const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
  <channel>
    <title>Demo Feed</title>
    <link>https://demo.example/</link>
    <item>
      <title>First &amp; foremost</title>
      <link>https://demo.example/1</link>
      <guid isPermaLink="false">tag:demo,2026:1</guid>
      <pubDate>Tue, 10 Jun 2025 04:00:00 GMT</pubDate>
      <content:encoded><![CDATA[<p>Hello <img src="https://t.example/pixel.gif"> world</p><script>alert(1)</script>]]></content:encoded>
    </item>
    <item>
      <title>Episode 2</title>
      <link>https://demo.example/2</link>
      <enclosure url="https://demo.example/2.mp3" type="audio/mpeg" length="123"/>
      <itunes:duration>1:02:03</itunes:duration>
      <pubDate>Wed, 11 Jun 2025 04:00:00 GMT</pubDate>
      <description>An audio episode</description>
    </item>
  </channel>
</rss>`;

let r = parseFeed(RSS, { feed });
assert.equal(r.meta.title, 'Demo Feed', 'rss channel title');
assert.equal(r.items.length, 2, 'rss item count');
assert.equal(r.items[0].id, 'demo:tag:demo,2026:1', 'rss stable id from guid, feed-scoped');
assert.equal(r.items[0].title, 'First & foremost', 'entity decoded in title');
assert.equal(typeof r.items[0].published_at, 'number', 'rss RFC822 date parsed');
assert.ok(!/<script/i.test(r.items[0].content), 'script stripped');
assert.ok(/data-weir-src/.test(r.items[0].content), 'img src suppressed → data-weir-src');
assert.equal(r.items[1].type, 'podcast', 'audio enclosure → podcast');
assert.equal(r.items[1].media.audio_url, 'https://demo.example/2.mp3', 'audio url');
assert.equal(r.items[1].media.duration_seconds, 3723, 'itunes duration HH:MM:SS → seconds');

// ── Atom 1.0 ──
const ATOM = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Demo</title>
  <link rel="alternate" href="https://atom.example/"/>
  <entry>
    <title>Atom one</title>
    <id>urn:uuid:abc-123</id>
    <link rel="alternate" href="https://atom.example/one"/>
    <published>2025-06-10T12:00:00Z</published>
    <author><name>Ada</name></author>
    <content type="html">&lt;p&gt;body&lt;/p&gt;</content>
  </entry>
</feed>`;

r = parseFeed(ATOM, { feed });
assert.equal(r.meta.title, 'Atom Demo', 'atom title');
assert.equal(r.items.length, 1, 'atom entry count');
assert.equal(r.items[0].id, 'demo:urn:uuid:abc-123', 'atom id from <id>');
assert.equal(r.items[0].url, 'https://atom.example/one', 'atom alternate link');
assert.equal(r.items[0].author, 'Ada', 'atom author name');
assert.equal(r.items[0].content, '<p>body</p>', 'atom escaped html decoded');
assert.equal(new Date(r.items[0].published_at).toISOString(), '2025-06-10T12:00:00.000Z', 'atom ISO date');

// ── JSON Feed ──
const JSONF = JSON.stringify({
  version: 'https://jsonfeed.org/version/1.1',
  title: 'JSON Demo',
  home_page_url: 'https://json.example/',
  items: [
    { id: 'j1', url: 'https://json.example/1', title: 'JSON one', date_published: '2025-06-12T08:00:00Z', content_html: '<p>hi</p>', author: { name: 'Lin' } },
  ],
});
r = parseFeed(JSONF, { feed, contentType: 'application/feed+json' });
assert.equal(r.items.length, 1, 'json item count');
assert.equal(r.items[0].id, 'demo:j1', 'json id');
assert.equal(r.items[0].author, 'Lin', 'json author');

// ── detectFeedUrl ──
const url = feedAdapter.detectFeedUrl('https://site.example/blog', '<link rel="alternate" type="application/rss+xml" href="/feed.xml">');
assert.equal(url, 'https://site.example/feed.xml', 'autodiscovery resolves relative href');

// ── End-to-end into the store ──
const store = new Store(await VFS.create());
await store._hydrate();
await store.putFeed({ id: 'demo', name: 'Demo', adapter: 'feed', url: 'https://demo.example/' });
const res = await store.upsertItems(parseFeed(RSS, { feed: store.getFeed('demo') }).items);
assert.deepEqual(res, { inserted: 2, updated: 0, skipped: 0 }, 'parsed items stored');
assert.equal(store.counts().inbox, 2, 'two in inbox');
assert.match(await store.getContent('demo:tag:demo,2026:1'), /Hello/, 'content persisted');

// ── gallery thumbnail fallback: first content <img> when no media tag ──
const IMGRSS = `<rss version="2.0"><channel><title>Img</title>
  <item><title>Has media</title><guid>m1</guid>
    <media:thumbnail xmlns:media="http://search.yahoo.com/mrss/" url="https://cdn.example/explicit.jpg"/>
    <description><![CDATA[<p>text <img src="https://cdn.example/inline.jpg"> more</p>]]></description></item>
  <item><title>Inline only</title><guid>m2</guid>
    <description><![CDATA[<p>lead <img src="https://blog.example/cover.png" alt=""> body</p>]]></description></item>
  <item><title>Tracker only</title><guid>m3</guid>
    <description><![CDATA[<img src="https://feeds.feedburner.com/~r/x/pixel.gif" width="1" height="1">words]]></description></item>
  <item><title>No image</title><guid>m4</guid><description>just words</description></item>
</channel></rss>`;
const imgItems = parseFeed(IMGRSS, { feed }).items;
assert.equal(imgItems[0].media.thumbnail, 'https://cdn.example/explicit.jpg', 'explicit media:thumbnail wins over inline img');
assert.equal(imgItems[1].media.thumbnail, 'https://blog.example/cover.png', 'inline content <img> used as fallback thumbnail');
assert.equal(imgItems[2].media, undefined, 'tracking pixel skipped → no thumbnail');
assert.equal(imgItems[3].media, undefined, 'no image → no media');

console.log('feed smoke ok:', JSON.stringify(store.counts()));
