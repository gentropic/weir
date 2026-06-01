// Multi-format link import: parsers + store round-trip (dedup / never-reset).
// Run: node tools/smoke-import.mjs
import assert from 'node:assert';
import { detectImport, parseTelegramExport, parseUrlList, isWrappedUrl } from '../src/js/importers.js';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { hash32 } from '../src/js/store/schema.js';

// ── a tiny Telegram bot-export fixture ──
const TG = {
  name: 'aeDB', type: 'bot_chat', id: 123,
  messages: [
    { id: 1, type: 'message', from: 'Me', date: '2026-05-01T10:00:00', date_unixtime: '1777622400',
      text: 'http://www.e-basteln.de/papertape/' },
    { id: 2, type: 'message', from: 'Me', date: '2026-05-02T10:00:00', date_unixtime: '1777708800',
      text: [ 'Huge trackball mouse | Tom’s Hardware ', { type: 'link', text: 'https://share.google/abc123' } ] },
    { id: 3, type: 'message', from: 'aeDB', date: '2026-05-02T10:00:05', date_unixtime: '1777708805',
      text: 'Saved! Archived at https://web.archive.org/web/2026/https://share.google/abc123' },
    { id: 4, type: 'message', from: 'Me', date: '2026-05-03T10:00:00', date_unixtime: '1777795200',
      text: 'cool build https://youtu.be/dQw4w9WgXcQ' },
    { id: 5, type: 'message', from: 'Me', date: '2026-05-04T10:00:00', date_unixtime: '1777881600',
      text: 'this is just a note, no link' },
    { id: 6, type: 'message', from: 'Me', date: '2026-05-05T10:00:00', date_unixtime: '1777968000',
      text: 'http://www.e-basteln.de/papertape/' },   // dup of #1
  ],
};

const links = parseTelegramExport(TG);
const byUrl = Object.fromEntries(links.map((l) => [l.url, l]));
assert.equal(links.length, 3, 'three unique importable links (dup + note + archive echo dropped)');
assert.ok(byUrl['http://www.e-basteln.de/papertape/'], 'bare url kept');
assert.ok(byUrl['https://share.google/abc123'], 'wrapped url kept');
assert.equal(byUrl['https://share.google/abc123'].title, 'Huge trackball mouse | Tom’s Hardware', 'in-text title parsed (url stripped)');
assert.equal(byUrl['https://share.google/abc123'].wrapped, true, 'share.google flagged for unwrap');
assert.equal(byUrl['https://youtu.be/dQw4w9WgXcQ'].wrapped, false, 'youtu.be not a wrapper');
assert.equal(byUrl['http://www.e-basteln.de/papertape/'].date, 1777622400000, 'date from date_unixtime (ms)');
assert.ok(!links.some((l) => /archive\.org/.test(l.url)), 'archive.org echo skipped');
assert.ok(!links.some((l) => l.title === null && /papertape/.test(l.url) === false), 'sanity');

// ── isWrappedUrl ──
assert.equal(isWrappedUrl('https://share.google/x'), true);
assert.equal(isWrappedUrl('https://bit.ly/x'), true);
assert.equal(isWrappedUrl('https://hackaday.com/x'), false);

// ── detectImport routing ──
assert.equal(detectImport(JSON.stringify(TG)).format, 'telegram', 'telegram json detected');
assert.equal(detectImport('<?xml version="1.0"?><opml><body><outline xmlUrl="http://x/f"/></body></opml>').format, 'opml', 'opml detected (no links)');
assert.equal(detectImport('<opml><body></body></opml>').links, undefined, 'opml carries no links');
const urlList = detectImport('Some title — https://hackaday.com/a\nhttps://github.com/b\njust text\n');
assert.equal(urlList.format, 'urls');
assert.equal(urlList.links.length, 2, 'two urls from the list');
assert.equal(urlList.links[0].title, 'Some title', 'url-list title parsed');
const jsonLinks = detectImport(JSON.stringify([{ url: 'https://x.com/a', title: 'A' }, { url: 'https://archive.org/skip' }]));
assert.equal(jsonLinks.format, 'json-links');
assert.equal(jsonLinks.links.length, 1, 'json-links: archive.org filtered');
assert.equal(detectImport('not importable at all'), null, 'unknown → null');
assert.deepEqual(parseUrlList('').length !== undefined ? [] : null, [], 'empty url list safe');

// ── store round-trip: dedup + never-reset (mirrors app.importLinks item build) ──
const store = new Store(await VFS.create()); await store._hydrate();
await store.putFeed({ id: 'saved', name: 'Saved Links', adapter: 'saved', url: '', next_poll_at: 8.64e15 });
const toRaws = (ls) => ls.map((l) => ({
  id: `saved:h${hash32(String(l.url).toLowerCase())}`,
  feed_id: 'saved', url: l.url, title: l.title || l.url,
  type: /(?:youtube\.com|youtu\.be)\//i.test(l.url) ? 'video' : 'article',
  published_at: l.date || undefined, tags: [],
}));
const r1 = await store.upsertItems(toRaws(links));
assert.equal(r1.inserted, 3, 'first import inserts all three');
const vidId = `saved:h${hash32('https://youtu.be/dqw4w9wgxcq')}`;
assert.equal(store.getItem(vidId).type, 'video', 'youtube link → video item');
// user saves one, then re-imports the same export
await store.setState(`saved:h${hash32('http://www.e-basteln.de/papertape/')}`, { saved: true, read: true });
const r2 = await store.upsertItems(toRaws(links));
assert.equal(r2.inserted, 0, 're-import inserts nothing (stable url-hash ids)');
assert.equal(r2.updated, 3, 're-import updates in place');
const reimported = store.getItem(`saved:h${hash32('http://www.e-basteln.de/papertape/')}`);
assert.equal(reimported.saved, true, 'saved flag NOT reset on re-import');
assert.equal(reimported.read, true, 'read flag NOT reset on re-import');

console.log('import smoke ok:', JSON.stringify({ links: links.length, inserted: r1.inserted, reimport_updated: r2.updated }));
