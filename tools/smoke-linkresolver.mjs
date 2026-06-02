// Link resolver: OpenGraph parsing + resolve-and-enrich over a store (mock fetch).
// Run: node tools/smoke-linkresolver.mjs
import assert from 'node:assert';
import { parseLinkMeta, LinkResolver } from '../src/js/linkresolver.js';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { hash32 } from '../src/js/store/schema.js';

// ── parseLinkMeta ──
const m = parseLinkMeta(`<html><head>
  <title>Fallback</title>
  <meta property="og:title" content="Real &amp; Good Title">
  <meta property="og:image" content="https://cdn.example.com/img.jpg">
  <meta name="og:description" content="A short description.">
</head><body>x</body></html>`);
assert.equal(m.title, 'Real & Good Title', 'og:title (entity-decoded)');
assert.equal(m.image, 'https://cdn.example.com/img.jpg', 'og:image');
assert.equal(m.description, 'A short description.', 'og:description');
assert.equal(parseLinkMeta('<head><title>Only Title</title></head>').title, 'Only Title', 'title-tag fallback');
assert.equal(parseLinkMeta('<head><meta name="twitter:image" content="https://x/y.png"></head>').image, 'https://x/y.png', 'twitter:image fallback');
assert.equal(parseLinkMeta('').image, null, 'empty → null');
// a value containing the other quote type must NOT truncate (the "That an app" bug)
assert.equal(
  parseLinkMeta(`<meta property="og:title" content="That an app 'Fits on a Floppy' is still useful">`).title,
  "That an app 'Fits on a Floppy' is still useful",
  'apostrophe inside double-quoted content not truncated');
assert.equal(
  parseLinkMeta(`<meta property='og:title' content='Bob&#39;s "big" day'>`).title,
  'Bob\'s "big" day',
  'double-quote inside single-quoted content not truncated (+ entity decoded)');

// ── enrichOne: resolve wrapper + parse og + update in place ──
const store = new Store(await VFS.create()); await store._hydrate();
await store.putFeed({ id: 'saved', name: 'Saved Links', adapter: 'saved', url: '', next_poll_at: 8.64e15, retention: { unread_days: 'forever' } });
const id = `saved:h${hash32('https://share.google/abc')}`;
await store.upsertItems([{ id, feed_id: 'saved', url: 'https://share.google/abc', title: 'share.google', type: 'article' }]);

const mockFetch = async (u) => ({
  ok: true, status: 200,
  url: u.includes('share.google') ? 'https://hackaday.com/real-article' : u,
  async text() { return '<head><meta property="og:title" content="Real Article"><meta property="og:image" content="/thumb.png"><meta property="og:description" content="the desc"></head>'; },
});
const lr = new LinkResolver(store, { fetch: mockFetch });
const patch = await lr.enrichOne(store.getItem(id));
assert.equal(patch.ok, true, 'enrichOne reports ok');
const it = store.getItem(id);
assert.equal(it.url, 'https://hackaday.com/real-article', 'wrapper resolved to real url');
assert.equal(it.media.thumbnail, 'https://hackaday.com/thumb.png', 'relative og:image resolved against the FINAL url');
assert.equal(it.title, 'Real Article', 'weak (hostname-ish) title upgraded to og:title');
assert.equal(it.excerpt, 'the desc', 'og:description → excerpt');
assert.equal(it.id, id, 'id unchanged (hashed from original url — stable identity)');
assert.equal(it.enriched, true, 'resolved wrapper marked enriched (won’t re-fetch)');
assert.equal(lr._pending().length, 0, 'resolved item no longer pending');

// ── direct (non-wrapped) links also enrich + get marked ──
const id3 = `saved:h${hash32('https://hackaday.com/direct')}`;
await store.upsertItems([{ id: id3, feed_id: 'saved', url: 'https://hackaday.com/direct', title: 'Direct', type: 'article' }]);
await lr.enrichOne(store.getItem(id3));
assert.equal(store.getItem(id3).enriched, true, 'direct link marked enriched');
assert.ok(store.getItem(id3).media?.thumbnail, 'direct link got a thumbnail too');
assert.ok(!lr._pending().some((r) => r.id === id3), 'enriched item drops out of pending');

// ── an unresolvable wrapper stays pending (not marked enriched) ──
const id4 = `saved:h${hash32('https://share.google/stuck')}`;
await store.upsertItems([{ id: id4, feed_id: 'saved', url: 'https://share.google/stuck', title: 'share.google', type: 'article' }]);
const lrStuck = new LinkResolver(store, { fetch: async (u) => ({ ok: true, status: 200, url: u, async text() { return ''; } }) });
const stuckRes = await lrStuck.enrichOne(store.getItem(id4));
assert.equal(stuckRes.ok, false, 'no redirect surfaced → not ok');
assert.equal(stuckRes.reason, 'no-redirect', 'failure reason classified');
assert.ok(!store.getItem(id4).enriched, 'unresolvable wrapper NOT marked enriched');
assert.ok(lrStuck._pending().some((r) => r.id === id4), 'stays pending for a later retry');

// ── run log: tally reasons + park after maxMisses (throttle visibility) ──
const ls = new Store(await VFS.create()); await ls._hydrate();
await ls.putFeed({ id: 'saved', name: 'Saved Links', adapter: 'saved', url: '', next_poll_at: 8.64e15, retention: { unread_days: 'forever' } });
await ls.upsertItems([{ id: 'saved:tA', feed_id: 'saved', url: 'https://share.google/throttled', title: 'share.google', type: 'article' }]);
const lr429 = new LinkResolver(ls, { fetch: async () => ({ ok: false, status: 429, async text() { return ''; } }), maxMisses: 2 });
await lr429.tick(); await lr429.tick();   // two failed ticks → parked (maxMisses 2)
assert.equal(lr429.log.reasons['http-429'], 2, 'each throttled try tallied as http-429 (share.google throttling shows up)');
assert.equal(lr429.log.parked, 1, 'parked after maxMisses');
assert.equal(lr429.log.recent[0].host, 'share.google', 'recent park records the host');
assert.equal(lr429.log.resolved, 0, 'nothing resolved');
// durable park: the dead link is marked on the ITEM so a reload (fresh _misses) can't resurface it
assert.equal(ls.getItem('saved:tA').resolve_parked, true, 'parked link marked durably on the item');
const lrReload = new LinkResolver(ls, { fetch: async () => ({}) });   // fresh instance = empty _misses, like a page reload
assert.ok(!lrReload._pending().some((r) => r.id === 'saved:tA'), 'durably-parked link stays OUT of the queue after reload (no thrash)');
// an explicit re-enrich is a deliberate retry → un-parks it
const reParked = await lrReload.reEnrich((r) => r.id === 'saved:tA');
lrReload.stop();
assert.equal(reParked, 1, 're-enrich re-queues the parked link');
assert.equal(ls.getItem('saved:tA').resolve_parked, undefined, 're-enrich clears resolve_parked');
assert.ok(lrReload._pending().some((r) => r.id === 'saved:tA'), 'un-parked link is back in the queue');
// log persists + reloads
await lr429._saveLog(true);
const lr429b = new LinkResolver(ls, { fetch: async () => ({}) });
await lr429b._loadLog();
assert.equal(lr429b.log.parked, 1, 'run log survives reload');

// a strong message title is NOT clobbered
const id2 = `saved:h${hash32('https://share.google/def')}`;
await store.upsertItems([{ id: id2, feed_id: 'saved', url: 'https://share.google/def', title: 'My Good Title | Hackaday', type: 'article' }]);
await lr.enrichOne(store.getItem(id2));
assert.equal(store.getItem(id2).title, 'My Good Title | Hackaday', 'meaningful title preserved');

// ── content extraction from the same fetch (injected extractor) ──
const id5 = `saved:h${hash32('https://share.google/withbody')}`;
await store.upsertItems([{ id: id5, feed_id: 'saved', url: 'https://share.google/withbody', title: 'share.google', type: 'article' }]);
const lrX = new LinkResolver(store, {
  fetch: async () => ({ ok: true, status: 200, url: 'https://hackaday.com/body', async text() { return '<html><head><meta property="og:title" content="Body Article"></head><body><article><p>x</p></article></body></html>'; } }),
  extract: (html, url) => `<p>extracted body of ${url}</p>`,
});
await lrX.enrichOne(store.getItem(id5));
assert.equal(store.getItem(id5).has_content, true, 'content stored (has_content) from the same fetch');
assert.match(await store.getContent(id5), /extracted body of https:\/\/hackaday\.com\/body/, 'stored body is the extractor output, against the FINAL url');

// ── rework: reEnrichWeakTitles re-queues only weak-title links ("Source: X" fix) ──
const wr = new Store(await VFS.create()); await wr._hydrate();
await wr.putFeed({ id: 'saved', name: 'Saved Links', adapter: 'saved', url: '', next_poll_at: 8.64e15, retention: { unread_days: 'forever' } });
await wr.upsertItems([
  { id: 'saved:weak', feed_id: 'saved', url: 'https://hackaday.com/a', title: 'Source: Hackaday', type: 'article' },             // prefix attribution
  { id: 'saved:sfx', feed_id: 'saved', url: 'https://hackaday.com/c', title: 'A Forth OS In 46 Bytes Source: Hackaday Shared via the Google App', type: 'article' }, // Google App suffix cruft
  { id: 'saved:trail', feed_id: 'saved', url: 'https://hackaday.com/d', title: 'Custom Touchpad PCBs Without The Pain Source: Hackaday', type: 'article' },           // trailing attribution
  { id: 'saved:good', feed_id: 'saved', url: 'https://hackaday.com/b', title: 'A Real Article Title', type: 'article' },
]);
await wr.upsertItems(['saved:weak', 'saved:sfx', 'saved:trail', 'saved:good'].map((id) => ({ id, feed_id: 'saved', enriched: true })));
const wlr = new LinkResolver(wr, { fetch: async () => ({ ok: false, status: 0 }) });
const requeued = await wlr.reEnrichWeakTitles();
wlr.stop();
assert.equal(requeued, 3, 'prefix + suffix + trailing-attribution titles all re-queued; clean title left alone');
assert.equal(wr.getItem('saved:weak').enriched, false, 'prefix "Source: X" re-queued');
assert.equal(wr.getItem('saved:sfx').enriched, false, '"Shared via the Google App" suffix re-queued');
assert.equal(wr.getItem('saved:trail').enriched, false, 'trailing "… Source: Hackaday" re-queued');
assert.equal(wr.getItem('saved:good').enriched, true, 'clean title left enriched (untouched)');

console.log('linkresolver smoke ok:', JSON.stringify({ title: it.title, thumb: !!it.media.thumbnail, pending: lr._pending().length, content: store.getItem(id5).has_content, reEnriched: requeued }));
