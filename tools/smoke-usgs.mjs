// USGS earthquake adapter — the first gauge source. Parses GeoJSON summary feeds
// into `event` items. Run: node tools/smoke-usgs.mjs

import assert from 'node:assert';
import { parseUsgs, usgsAdapter, usgsName } from '../src/js/adapters/usgs.js';

const SAMPLE = JSON.stringify({
  metadata: { title: 'USGS Magnitude 4.5+ Earthquakes, Past Day' },
  features: [
    {
      type: 'Feature', id: 'us7000abcd',
      properties: { mag: 5.2, place: '120 km SSW of Somewhere', time: 1717400000000, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd', felt: 12, tsunami: 0, title: 'M 5.2 - 120 km SSW of Somewhere' },
      geometry: { type: 'Point', coordinates: [-72.5, -33.1, 35.2] },
    },
    {
      type: 'Feature', id: 'us7000efgh',
      properties: { mag: null, place: 'Near the coast', time: 1717390000000, url: 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000efgh', tsunami: 1 },
      geometry: { type: 'Point', coordinates: [10, 20, 8] },
    },
  ],
});

const { meta, items } = parseUsgs(SAMPLE, { feed: { id: 'usgs' } });
assert.equal(items.length, 2, 'two quakes parsed');
assert.match(meta.title, /Magnitude 4.5/, 'feed title from metadata');

const a = items[0];
assert.equal(a.id, 'usgs:us7000abcd', 'stable USGS event id → dedup key');
assert.equal(a.type, 'event', 'mapped to event type');
assert.equal(a.title, 'M 5.2 - 120 km SSW of Somewhere', 'title from USGS');
assert.equal(a.published_at, 1717400000000, 'event time → published_at');
assert.equal(a.url, 'https://earthquake.usgs.gov/earthquakes/eventpage/us7000abcd', 'event page URL');
assert.equal(a.structured.mag, 5.2, 'magnitude');
assert.deepEqual(a.structured.coords, [-72.5, -33.1], 'lon/lat (depth dropped from coords)');
assert.equal(a.structured.depth_km, 35.2, 'depth');
assert.equal(a.structured.felt, 12, 'felt reports');
assert.match(a.content, /5\.2/, 'body mentions magnitude');

const b = items[1];
assert.match(b.title, /^M \? - /, 'null magnitude renders as "?"');
assert.equal(b.structured.tsunami, 1, 'tsunami flag carried');
assert.equal(b.structured.felt, undefined, 'no felt → omitted');

// adapter wiring + naming
assert.ok(usgsAdapter.match('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_day.geojson'), 'matches a USGS geojson URL');
assert.ok(!usgsAdapter.match('https://example.com/feed.xml'), 'does not match a normal feed');
assert.ok(!usgsAdapter.match('https://earthquake.usgs.gov/earthquakes/map'), 'does not match a non-geojson USGS page');
assert.equal(usgsName('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson'), 'USGS Earthquakes (M4.5+, week)', 'friendly tiered name');
assert.equal(usgsName('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/significant_month.geojson'), 'USGS Earthquakes (significant, month)', 'significant tier name');

assert.deepEqual(parseUsgs('not json', {}).items, [], 'bad input → no items');
console.log('usgs smoke ok:', JSON.stringify({ items: items.length }));
