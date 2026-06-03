// Multi-format link import: parsers + store round-trip (dedup / never-reset).
// Run: node tools/smoke-import.mjs
import assert from 'node:assert';
import { detectImport, parseTelegramExport, parseUrlList, parseLibraryThing, messageLinks, isWrappedUrl, isSkippedUrl } from '../src/js/importers.js';
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
    { id: 7, type: 'message', from: 'aeDB', date: '2026-05-06T10:00:00', date_unixtime: '1778054400',
      text: 'you might also like https://bot-suggestion.example/x' },   // bot's OWN link — must be excluded
    { id: 8, type: 'message', from: 'Me', date: '2026-05-07T10:00:00', date_unixtime: '1778140800',
      text: 'saved! https://holo.stdgeo.com/links/123' },   // Holocene-internal pointer — must be skipped
    { id: 9, type: 'message', from: 'aeDB', date: '2026-05-08T10:00:00', date_unixtime: '1778227200',
      text: '✅ Link Added Cool Thing 📋 Link ID: 99 https://bot-echo.example/real' },   // bot confirmation w/ a REAL url — must be excluded by chat-name
  ],
};

const links = parseTelegramExport(TG);   // TG.name='aeDB', type='bot_chat' → bot = 'aeDB'
assert.ok(!links.some((l) => /bot-suggestion/.test(l.url)), "bot's own link excluded (chat name = bot)");
assert.ok(!links.some((l) => /bot-echo/.test(l.url)), "bot's Link-Added confirmation (real url, bot title) excluded by chat name");
assert.ok(!links.some((l) => /holo\.stdgeo/.test(l.url)), 'Holocene-internal host (holo.stdgeo.com) skipped');
assert.equal(isSkippedUrl('https://holo.stdgeo.com/x'), true, 'isSkippedUrl: holo.stdgeo.com');
assert.equal(isSkippedUrl('https://hackaday.com/x'), false, 'isSkippedUrl: real host not skipped');
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

// ── messageLinks: live getUpdates message → link records (or [] for a note) ──
// a Google Discover share (blurb + wrapped link) → ONE link, blurb as title
const share = messageLinks('Huge trackball mouse | Tom’s Hardware https://share.google/abc', []);
assert.equal(share.length, 1, 'share message → one link');
assert.equal(share[0].url, 'https://share.google/abc', 'url extracted from text');
assert.equal(share[0].title, 'Huge trackball mouse | Tom’s Hardware', 'blurb becomes the title');
assert.equal(share[0].wrapped, true, 'share.google flagged for unwrap');
// a text_link entity (button-style link, url not in the visible text)
const ent = messageLinks('read this', [{ type: 'text_link', offset: 0, length: 9, url: 'https://hackaday.com/x' }]);
assert.equal(ent[0].url, 'https://hackaday.com/x', 'text_link entity url extracted');
// a 'url' entity (url IS the visible text)
const ent2 = messageLinks('see https://github.com/a/b here', [{ type: 'url', offset: 4, length: 21 }]);
assert.ok(ent2.some((l) => l.url === 'https://github.com/a/b'), 'url entity extracted from offset/length');
// a pure-text note → [] (caller treats as a note)
assert.deepEqual(messageLinks('just a thought, no link', []), [], 'no url → [] (a note)');
assert.deepEqual(messageLinks('', []), [], 'empty → []');
// skipped host filtered even if present
assert.deepEqual(messageLinks('saved https://web.archive.org/web/x', []), [], 'archive.org skipped → treated as note');

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

// ── LibraryThing export → books (defensive field shapes) ──
const LT = {
  101: { books_id: '101', title: 'Introduction to Algorithms', authors: [{ lf: 'Cormen, Thomas H.', fl: 'Thomas H. Cormen' }], ISBNs: ['9780262033848'], date: '2009', ddc: { code: ['005.1'], description: [['Computer programming']] }, lcc: { code: 'QA76.6' }, tags: ['algorithms', 'cs'], comment: 'The CLRS bible.' },
  102: { book_id: '102', title: 'The Nature of Geographic Information', primaryauthor: 'David DiBiase', isbn: '0-9772521-0-1', date: 'c2014', ddc: '910', tags: 'gis, maps' },
  103: { title: 'No-ISBN Book', authors: ['Anon'] },
  104: { books_id: '104', title: 'Object-ISBN Book', authors: [{ fl: 'X Y' }], isbn: { 0: '8550811769', 2: '9788550811765' }, comment: 'a real note' },
  junk: { not: 'a book' },
};
const books = parseLibraryThing(LT);
const byId = Object.fromEntries(books.map((b) => [b.lt_id, b]));
assert.equal(books.length, 4, 'four books parsed (junk skipped)');
assert.equal(byId['104'].isbn, '9788550811765', 'ISBN from an object-shaped {"0":…,"2":…} field, ISBN-13 preferred');
assert.equal(byId['104'].excerpt, 'a real note', 'excerpt from a real comment');
assert.equal(byId['101'].author, 'Thomas H. Cormen', 'author from fl');
assert.equal(byId['101'].isbn, '9780262033848', 'ISBN from ISBNs array');
assert.equal(byId['101'].ddc, '005.1', 'ddc from {code:[…]}');
assert.equal(byId['101'].lcc, 'QA76.6', 'lcc from {code}');
assert.deepEqual(byId['101'].tags, ['algorithms', 'cs'], 'tags array preserved');
assert.equal(byId['101'].date, Date.UTC(2009, 0, 1), 'publication year → date');
assert.equal(byId['102'].author, 'David DiBiase', 'primaryauthor (bare string)');
assert.equal(byId['102'].isbn, '0977252101', 'hyphenated ISBN-10 normalized');
assert.equal(byId['102'].ddc, '910', 'ddc as a bare string');
assert.deepEqual(byId['102'].tags, ['gis', 'maps'], 'comma-string tags split');
assert.equal(detectImport(JSON.stringify(LT)).format, 'librarything', 'librarything export detected');
assert.equal(detectImport(JSON.stringify(LT)).books.length, 4, 'detect carries the parsed books');

// idempotent book holdings round-trip (mirrors app.importBooks)
const bstore = new Store(await VFS.create()); await bstore._hydrate();
await bstore.putFeed({ id: 'books', name: 'Books', adapter: 'books', url: '', next_poll_at: 8.64e15 });
const bookRaws = books.map((b) => ({ id: `book:${b.lt_id || `h${hash32((b.isbn || b.title || '').toLowerCase())}`}`, feed_id: 'books', type: 'book', title: b.title, tags: b.tags, structured: (b.ddc || b.lcc || b.isbn) ? { ddc: b.ddc, lcc: b.lcc, isbn: b.isbn } : undefined }));
const bk1 = await bstore.upsertItems(bookRaws);
assert.equal(bk1.inserted, 4, 'four books inserted');
assert.equal(bstore.getItem('book:101').type, 'book', 'type is book');
assert.equal(bstore.getItem('book:101').structured.ddc, '005.1', 'DDC carried in structured');
await bstore.setState('book:101', { read: true });
const bk2 = await bstore.upsertItems(bookRaws);
assert.deepEqual({ i: bk2.inserted, u: bk2.updated }, { i: 0, u: 4 }, 're-import updates, never dupes (stable id)');
assert.equal(bstore.getItem('book:101').read, true, 'reading state survives a re-import');

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
