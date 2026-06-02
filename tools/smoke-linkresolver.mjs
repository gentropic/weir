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
assert.ok(patch, 'enrichOne returned a patch');
const it = store.getItem(id);
assert.equal(it.url, 'https://hackaday.com/real-article', 'wrapper resolved to real url');
assert.equal(it.media.thumbnail, 'https://hackaday.com/thumb.png', 'relative og:image resolved against the FINAL url');
assert.equal(it.title, 'Real Article', 'weak (hostname-ish) title upgraded to og:title');
assert.equal(it.excerpt, 'the desc', 'og:description → excerpt');
assert.equal(it.id, id, 'id unchanged (hashed from original url — stable identity)');
assert.equal(lr._pending().length, 0, 'resolved item no longer pending');

// a strong message title is NOT clobbered
const id2 = `saved:h${hash32('https://share.google/def')}`;
await store.upsertItems([{ id: id2, feed_id: 'saved', url: 'https://share.google/def', title: 'My Good Title | Hackaday', type: 'article' }]);
await lr.enrichOne(store.getItem(id2));
assert.equal(store.getItem(id2).title, 'My Good Title | Hackaday', 'meaningful title preserved');

console.log('linkresolver smoke ok:', JSON.stringify({ title: it.title, thumb: !!it.media.thumbnail, pending: lr._pending().length }));
