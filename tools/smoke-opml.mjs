// OPML import/export tests (node). Run: node tools/smoke-opml.mjs

import assert from 'node:assert';
import { parseOpml, buildOpml } from '../src/js/opml.js';

const OPML = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="1.0">
  <head><title>Test</title></head>
  <body>
    <outline text="Top Blog" title="Top Blog" type="rss" xmlUrl="https://a.example/feed" htmlUrl="https://a.example/"/>
    <outline text="geo" title="geo">
      <outline text="Geo Blog" type="rss" xmlUrl="https://geo.example/rss"/>
      <outline text="Chan" type="rss" xmlUrl="https://www.youtube.com/feeds/videos.xml?channel_id=UC123" htmlUrl="https://youtube.com/channel/UC123"/>
    </outline>
  </body>
</opml>`;

const feeds = parseOpml(OPML);
assert.equal(feeds.length, 3, 'three feeds (flat + nested)');
assert.equal(feeds[0].category, undefined, 'top-level feed has no category');
assert.equal(feeds[1].category, 'geo', 'nested feed inherits folder category');
assert.equal(feeds[1].kind, 'feed', 'plain feed kind');
assert.equal(feeds[2].kind, 'youtube', 'youtube feed flagged');
assert.equal(feeds[2].category, 'geo', 'youtube feed category');

// build → parse roundtrip (categories preserved)
const stored = feeds.map((f) => ({ name: f.title, url: f.xmlUrl, site_url: f.htmlUrl, category: f.category }));
const round = parseOpml(buildOpml(stored, 'weir feeds'));
assert.equal(round.length, 3, 'roundtrip count');
assert.equal(round.find((f) => f.title === 'Geo Blog').category, 'geo', 'roundtrip preserves category');

// empty / malformed tolerance
assert.deepEqual(parseOpml('<opml><body></body></opml>'), [], 'empty body');
assert.deepEqual(parseOpml('not xml at all'), [], 'garbage → no feeds');

console.log('opml smoke ok:', feeds.length, 'feeds,', feeds.filter((f) => f.kind === 'youtube').length, 'youtube');
