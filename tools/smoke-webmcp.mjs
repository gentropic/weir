// WebMCP adapter tool logic (buildWeirTools) over a real Store — no browser.
// Run: node tools/smoke-webmcp.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { buildWeirTools } from '../src/js/webmcp.js';
import { StacksStore } from '../src/js/stacks.js';

const store = new Store(await VFS.create()); await store._hydrate();
await store.putFeed({ id: 'f', name: 'Boing Boing', adapter: 'feed', url: 'http://b/f' });
await store.upsertItems([
  { id: 'a1', feed_id: 'f', type: 'article', title: 'Jack Daniel preacher', author: 'Jason', url: 'http://b/1', excerpt: 'whiskey history', published_at: Date.parse('2026-05-01'), tags: ['whiskey'], content: '<p>full whiskey text here</p>' },
  { id: 'v1', feed_id: 'f', type: 'video', title: '3D Print Farm', url: 'http://b/2', published_at: Date.parse('2026-05-02') },
]);

const tools = buildWeirTools({ store });

// ── queryItems ──
const all = await tools.queryItems({});
assert.equal(all.count, 2, 'all items');
assert.ok(all.items.every((i) => i.id && i.title && i.feed === 'Boing Boing'), 'compact projection');

const q = await tools.queryItems({ q: 'whiskey' });
assert.equal(q.count, 1); assert.equal(q.items[0].id, 'a1', 'text search hits a1');
assert.ok(q.items[0].published.startsWith('2026-05-01'), 'published as ISO');

const vids = await tools.queryItems({ type: 'video' });
assert.equal(vids.count, 1); assert.equal(vids.items[0].id, 'v1', 'type filter');

const capped = await tools.queryItems({ limit: 999 });
assert.equal(capped.count, 2, 'limit cap does not error');

// ── pagination: keyset cursor, newest first (v1 2026-05-02 before a1 2026-05-01) ──
const p1 = await tools.queryItems({ limit: 1 });
assert.equal(p1.count, 1); assert.equal(p1.total, 2); assert.equal(p1.hasMore, true);
assert.equal(p1.items[0].id, 'v1', 'page 1 = newest'); assert.ok(p1.nextCursor, 'nextCursor present');
const p2 = await tools.queryItems({ limit: 1, cursor: p1.nextCursor });
assert.equal(p2.items[0].id, 'a1', 'page 2 = next item, no overlap');
assert.equal(p2.hasMore, false, 'no more after last'); assert.ok(!p2.nextCursor, 'no cursor at the end');
const pBad = await tools.queryItems({ cursor: 'garbage!!' });
assert.equal(pBad.count, 2, 'bad cursor → ignored, full set');

// ── feed filter (by id or name) + listSources ──
assert.equal((await tools.queryItems({ feed: 'f' })).count, 2, 'feed filter by id');
assert.equal((await tools.queryItems({ feed: 'Boing Boing' })).count, 2, 'feed filter by display name');
assert.equal((await tools.queryItems({ feed: 'boing boing' })).count, 2, 'feed name is case-insensitive');
assert.equal((await tools.queryItems({ feed: 'Nope' })).count, 0, 'unknown feed → empty set');
const srcs = await tools.listSources();   // overview (no per-feed dump)
assert.equal(srcs.feedCount, 1, 'listSources: one feed');
assert.ok(srcs.folders.some((c) => c.feeds === 1 && c.inbox === 2), 'overview: folder summary with count + inbox');
assert.ok(!srcs.sources, 'overview does not inline every feed');
const det = await tools.listSources({ category: '' });   // detail for the ungrouped folder
assert.ok(det.feeds.some((f) => f.name === 'Boing Boing' && f.inbox === 2), 'category detail lists the feed');

// ── getItem ──
const it = await tools.getItem({ id: 'a1', content: true });
assert.equal(it.title, 'Jack Daniel preacher');
assert.equal(it.author, 'Jason');
assert.match(it.content_text, /full whiskey text here/, 'content_text extracted + stripped');
await assert.rejects(tools.getItem({ id: 'ghost' }), /No item/, 'missing id errors helpfully');
await assert.rejects(tools.getItem({}), /No item/, 'missing id param errors');

// ── listFacets (Stage-0 deterministic) — bounded { total, terms, omitted } ──
const f = await tools.listFacets();
assert.ok(f.form.terms.find((t) => t.term === 'article' && t.count === 1), 'form: article');
assert.ok(f.form.terms.find((t) => t.term === 'video' && t.count === 1), 'form: video');
assert.equal(f.form.total, 2, 'form total');
assert.ok(f.provenance.terms.find((t) => t.term === 'web-feed' && t.count === 2), 'provenance: web-feed ×2');
assert.ok(f.temporal.terms.find((t) => t.term === '2026' && t.count === 2), 'temporal: 2026 ×2');
assert.ok(f.entity.terms.find((t) => t.term === 'whiskey' && t.count === 1), 'entity from tags');

// caps: limit + facet drill-down + omitted bookkeeping
const cap = await tools.listFacets({ facet: 'form', limit: 1 });
assert.deepEqual(Object.keys(cap), ['form'], 'facet filter returns only that facet');
assert.equal(cap.form.terms.length, 1, 'limit caps terms');
assert.equal(cap.form.omitted, 1, 'omitted = total - shown');

// archived items are excluded from facets + default query
store.setState('v1', { archived: true });
const f2 = await tools.listFacets();
assert.ok(!(f2.form.terms.find((t) => t.term === 'video')), 'archived item dropped from facets');
const inbox = await tools.queryItems({});
assert.equal(inbox.count, 1, 'archived item dropped from default query');

// ── mutations: setState (read/saved/archived, reversible) ──
const upd = await tools.setState({ id: 'a1', saved: true, read: true });
assert.equal(upd.saved, true); assert.equal(upd.read, true, 'setState applied');
assert.equal(store.getItem('a1').saved, true, 'persisted to store');
await tools.setState({ id: 'a1', saved: false });
assert.equal(store.getItem('a1').saved, false, 'reversible');
await assert.rejects(tools.setState({ id: 'a1' }), /at least one/, 'needs a field');
await assert.rejects(tools.setState({ id: 'ghost', read: true }), /No item/);

// ── tag (merged): single item by id (llm provenance) ──
const tg = await tools.tag({ id: 'a1', add: ['ml', 'geo'] });
assert.ok(tg.tags.includes('ml') && tg.tags.includes('geo'), 'tag(id) added tags');
assert.equal(store.getItem('a1').tag_src.ml, 'llm', 'WebMCP tags stamped source:llm');
await tools.tag({ id: 'a1', remove: ['geo'] });
assert.ok(!store.getItem('a1').tags.includes('geo') && store.getItem('a1').tags.includes('ml'), 'tag(id) removed only the named tag');
await assert.rejects(tools.tag({ id: 'a1' }), /add and\/or remove/, 'needs add or remove');
await assert.rejects(tools.tag({ id: 'ghost', add: ['x'] }), /No item/);

// ── tag (merged): bulk over a query — scopes like queryItems ──
const bt = await tools.tag({ type: 'article', add: ['swept'] });
assert.ok(bt.matched >= 1 && bt.changed >= 1, 'tag(query) matched + changed the article');
assert.ok(store.getItem('a1').tags.includes('swept'), 'bulk tag landed on the matching item');
assert.equal(store.getItem('a1').tag_src.swept, 'llm', 'bulk WebMCP tag stamped source:llm');
assert.equal((await tools.tag({ q: 'no-such-text', add: ['x'] })).matched, 0, 'empty match → 0, no throw');
await assert.rejects(tools.tag({ type: 'article' }), /add and\/or remove/, 'tag(query) needs add or remove');

// ── setState: bulk over a query + scope guard + action guard ──
store.setState('a1', { read: false });
const bulkRead = await tools.setState({ type: 'article', read: true });
assert.equal(bulkRead.matched, 1, 'bulk setState matched the article');
assert.equal(store.getItem('a1').read, true, 'bulk read applied');
await assert.rejects(tools.setState({ saved: true }), /scope a bulk change/, 'bulk needs a scoping filter (no whole-corpus)');
await assert.rejects(tools.setState({ feed: 'f' }), /at least one of: read/, 'needs an action');

// ── search: substring fallback when no app/index ──
const sf = await tools.search({ q: 'whiskey' });
assert.equal(sf.ranked, false, 'no index → substring fallback');
assert.ok(sf.items.some((i) => i.id === 'a1'), 'search found a1');
await assert.rejects(tools.search({}), /provide ..?q/, 'search needs a query');

// ── feed mgmt: addFeed needs app; updateFeed curates; listSources surfaces health ──
await assert.rejects(tools.addFeed({ url: 'http://x/f' }), /only available/, 'addFeed needs the running app');
const uf = await tools.updateFeed({ id: 'f', category: 'news', name: 'BB' });
assert.equal(uf.category, 'news'); assert.equal(store.getFeed('f').name, 'BB', 'feed renamed');
await assert.rejects(tools.updateFeed({ id: 'nope', name: 'x' }), /No feed/, 'unknown feed errors');
store.getFeed('f').etag = 'stale-etag';
const ufu = await tools.updateFeed({ id: 'f', url: 'http://new.example/feed.xml' });
assert.equal(ufu.url, 'http://new.example/feed.xml', 'updateFeed changed the URL');
assert.equal(store.getFeed('f').url, 'http://new.example/feed.xml', 'persisted');
assert.equal(store.getFeed('f').etag, undefined, 'stale validators cleared on URL change');
store.getFeed('f').state = 'failing';
store.getFeed('f').feed_health = { consecutive_failures: 3, last_error: 'HTTP 500' };
const ls2 = await tools.listSources();
assert.equal(ls2.health.failing, 1, 'health tally counts the failing feed');
const ff = (ls2.troubled || []).find((x) => x.id === 'f');
assert.ok(ff && ff.fails === 3 && ff.lastError === 'HTTP 500', 'troubled list surfaces fails + last error');

// ── removeFeed: gated on the mcp_allow_feed_removal setting; deletes feed + items ──
await store.putFeed({ id: 'dead', name: 'Dead Feed', adapter: 'feed', url: 'http://dead/f' });
await store.upsertItems([{ id: 'd1', feed_id: 'dead', type: 'article', title: 'old' }]);
const rm = await tools.removeFeed({ id: 'dead' });
assert.equal(rm.removed, 'dead'); assert.ok(rm.items >= 1, 'reports erased item count');
assert.equal(store.getFeed('dead'), null, 'feed gone after removeFeed');
await store.setSettings({ mcp_allow_feed_removal: false });
await store.putFeed({ id: 'dead2', name: 'D2', adapter: 'feed', url: 'http://d2/f' });
await assert.rejects(tools.removeFeed({ id: 'dead2' }), /disabled/, 'gated off → refuses, points to UI');
await store.setSettings({ mcp_allow_feed_removal: true });

// ── listSources q: find a feed by URL / name across all folders (incl. its url) ──
const foundByUrl = await tools.listSources({ q: 'new.example' });
assert.ok(foundByUrl.feeds.some((x) => x.id === 'f'), 'listSources q finds a feed by URL substring');
assert.ok(foundByUrl.feeds.every((x) => 'url' in x), 'q results include the url (so a feed is recognizable)');
assert.ok((await tools.listSources({ q: 'bb' })).feeds.some((x) => x.id === 'f'), 'and finds it by name');

// ── renameFeed: re-key a feed id (clean up an auto-derived id) ──
await store.putFeed({ id: 'bsky-app', name: 'bsky.app', adapter: 'feed', url: 'https://bsky.app/profile/did:plc:zzz/rss' });
await store.upsertItems([{ id: 'bsky-app:1', feed_id: 'bsky-app', type: 'article', title: 'a post' }]);
const rf = await tools.renameFeed({ id: 'bsky-app', newId: 'Arne (androidarts)' });
assert.equal(rf.renamed, 'arne-androidarts', 'newId slugified');
assert.ok(store.getFeed('arne-androidarts') && !store.getFeed('bsky-app'), 'feed re-keyed');
assert.ok(store.items.get('arne-androidarts:1') && !store.items.get('bsky-app:1'), 'item id re-keyed');
await assert.rejects(tools.renameFeed({ id: 'nope', newId: 'x' }), /No feed/, 'unknown feed errors');
await assert.rejects(tools.renameFeed({ id: 'arne-androidarts' }), /newId/, 'missing newId errors');
await assert.rejects(tools.renameFeed({ id: 'arne-androidarts', newId: 'f' }), /already exists/, 'collision rejected');
await store.removeFeed('arne-androidarts');   // restore the shared store's baseline counts

// ── repoll: force-refresh a feed (guard + forwards force:true to the poller) ──
await assert.rejects(tools.repoll({ id: 'f' }), /only available/, 'repoll needs the running app');
{
  let forced = null;
  const rpApp = { poller: { pollFeed: async (feed, opts) => { forced = { id: feed.id, opts }; return { inserted: 0, updated: 3, skipped: 0 }; } }, renderAll() {} };
  const rpTools = buildWeirTools({ store, app: rpApp });
  const rr = await rpTools.repoll({ id: 'f' });
  assert.equal(rr.updated, 3, 'returns the poll result');
  assert.deepEqual(forced.opts, { force: true }, 'forwards force:true to pollFeed');
  await assert.rejects(rpTools.repoll({ id: 'nope' }), /No feed/, 'unknown feed errors');
}

// ── recover: queue dead feeds for Wayback recovery (drip) or recover one now ──
await assert.rejects(tools.recover({ id: 'f' }), /only available/, 'recover needs the running app');
{
  const queued = [];
  let recoveredNow = null;
  const recApp = {
    recovery: { enqueue: async (ids) => { queued.push(...ids); }, status: () => ({ queued: queued.length, current: null, done: 0, running: false }) },
    recoverHistory: async (id) => { recoveredNow = id; return { inserted: 7, fetched: 12, total: 40 }; },
  };
  await store.putFeed({ id: 'dead-a', name: 'Dead A', adapter: 'feed', url: 'http://a/f', category: 'gone' });
  await store.putFeed({ id: 'dead-b', name: 'Dead B', adapter: 'feed', url: 'http://b/f', category: 'gone' });
  const recTools = buildWeirTools({ store, app: recApp });
  // queue a list
  const ql = await recTools.recover({ ids: ['dead-a', 'dead-b', 'ghost'] });
  assert.equal(ql.mode, 'drip', 'default mode queues the drip');
  assert.equal(ql.queued, 2, 'only existing feeds queued (ghost dropped)');
  assert.deepEqual(queued, ['dead-a', 'dead-b'], 'enqueued the real ids');
  // queue a whole category
  const qc = await recTools.recover({ category: 'gone' });
  assert.equal(qc.queued, 2, 'category queues both feeds in the folder');
  // recover one NOW (foreground)
  const rn = await recTools.recover({ id: 'dead-a', now: true });
  assert.equal(rn.mode, 'now'); assert.equal(rn.inserted, 7, 'now-mode returns recovery counts');
  assert.equal(recoveredNow, 'dead-a', 'foreground recoverHistory invoked for the feed');
  await assert.rejects(recTools.recover({}), /id, ids\[\], or category/, 'needs a scope');
  await assert.rejects(recTools.recover({ ids: ['ghost'] }), /no matching feeds/, 'all-unknown → errors');
  await store.removeFeed('dead-a'); await store.removeFeed('dead-b');   // restore baseline
}

// ── catalog control (mock app) ──
const calls = [];
const mockApp = {
  catalogAll: () => { calls.push('start'); return { running: true, todo: 3 }; },
  catalogScope: (scope) => { calls.push('scope:' + JSON.stringify(scope)); return { running: true, todo: 1, scope }; },
  stopCatalog: () => { calls.push('stop'); return true; },
  catalogStatus: () => ({ running: false, progress: { total: 3, done: 1, failed: 0 } }),
  catalogItem: async (id) => { calls.push('item:' + id); store.getItem(id).glass_id = 'glass-x'; return { ok: true, card: { facets: { domain: ['x'] } } }; },
};
const ctlTools = buildWeirTools({ store, app: mockApp });
assert.deepEqual(await ctlTools.catalogControl({ action: 'start' }), { running: true, todo: 3 }, 'unscoped start → catalogAll');
// scoped start → catalogScope (no scope keys → whole-corpus catalogAll)
const scCat = await ctlTools.catalogControl({ action: 'start', category: 'News' });
assert.deepEqual(scCat.scope, { category: 'News' }, 'category scope routed to catalogScope');
const scType = await ctlTools.catalogControl({ action: 'start', type: 'video' });
assert.deepEqual(scType.scope, { type: 'video' }, 'type scope routed to catalogScope');
assert.ok(calls.includes('scope:{"category":"News"}'), 'catalogScope invoked, not catalogAll');
const status = await ctlTools.catalogControl({});   // default status
assert.equal(status.running, false); assert.equal(status.total, 2); assert.ok('cataloged' in status, 'status has counts');
assert.deepEqual(await ctlTools.catalogControl({ action: 'stop' }), { stopped: true }, 'stop');
// clear: writes a card, then clears it
await store.writeCard({ glass: { document_ref: 'a1', cataloged: '2026-06-01' }, facets: {}, dublin_core: {} });
assert.ok((await store.catalogCount()) >= 1, 'a card exists');
const cleared = await ctlTools.catalogControl({ action: 'clear' });
assert.ok(cleared.cleared >= 1, 'clear removed cards');
assert.equal(await store.catalogCount(), 0, 'catalog empty after clear');
await assert.rejects(ctlTools.catalogControl({ action: 'nope' }), /start \| stop \| clear \| status/);
// catalogItem requires app
await assert.rejects(tools.catalogItem({ id: 'a1' }), /only available/, 'catalogItem needs app');

// ── review queue: markCardReviewed + reviewQueue/reviewItem (mock app) ──
await store.writeCard({ glass: { document_ref: 'a1', cataloged: '2026-06-01', needs_review: true, confidence: 0.2 }, facets: { scale: ['global'], domain: ['x'] }, dublin_core: {} });
const a1card = await store.getCard(store.getItem('a1').glass_id);
const reviewApp = {
  _cardReview: new Map([['a1', { needs_review: true, confidence: 0.2 }]]),
  _cardFacets: new Map([['a1', a1card.facets]]),
  renderReviewStatus() {},
};
const rvTools = buildWeirTools({ store, app: reviewApp, ensureCards: async () => {} });
const queue = await rvTools.reviewQueue({});
assert.equal(queue.total, 1); assert.equal(queue.items[0].id, 'a1'); assert.equal(queue.items[0].confidence, 0.2, 'queue carries confidence');
// correct facets + approve
const fixed = await rvTools.reviewItem({ id: 'a1', facets: { scale: [] } });
assert.deepEqual(fixed.facets.scale, [], 'facet correction applied');
assert.deepEqual(fixed.facets.domain, ['x'], 'untouched facet preserved');
const card2 = await store.getCard(store.getItem('a1').glass_id);
assert.equal(card2.glass.needs_review, false, 'needs_review cleared');
assert.equal(card2.glass.reviewer, 'human', 'stamped human review');
assert.equal(reviewApp._cardReview.get('a1').needs_review, false, 'app cache updated');
const queue2 = await rvTools.reviewQueue({});
assert.equal(queue2.total, 0, 'queue empty after review');
await assert.rejects(rvTools.reviewItem({ id: 'v1' }), /isn’t cataloged|not cataloged|isn't cataloged/, 'uncataloged item rejected');

// ── setCatalog: writes config (not the key), clamps; listModels needs app ──
const cfg = await tools.setCatalog({ provider: 'nanogpt', model: 'deepseek/deepseek-v3.2', paceMs: 0, maxBodyChars: 99999 });
assert.equal(cfg.provider, 'nanogpt'); assert.equal(cfg.model, 'deepseek/deepseek-v3.2');
assert.equal(cfg.paceMs, 0, 'pace set'); assert.equal(cfg.maxBodyChars, 20000, 'maxBody clamped to 20000');
assert.equal(store.getSettings().catalog_provider, 'nanogpt', 'persisted to settings');
assert.ok(!('catalog_key' in store.getSettings()), 'no key field written');
await assert.rejects(tools.setCatalog({}), /nothing to set/, 'empty patch rejected');
await assert.rejects(tools.listProviderModels({}), /only available/, 'listModels needs app');
// listModels with a mock app + injected fetch
const lmApp = { poller: { fetch: async () => ({ ok: true, async json() { return { data: [{ id: 'm1' }, { id: 'm2' }] }; } }) } };
const lmTools = buildWeirTools({ store, app: lmApp });
const lm = await lmTools.listProviderModels({ provider: 'nanogpt' });
assert.equal(lm.count, 2); assert.deepEqual(lm.models, ['m1', 'm2'], 'models listed');

// ── stacks tools (STACKS.md §6): co-curation over a real StacksStore ──
{
  const s = new Store(await VFS.create()); await s._hydrate();
  const stacks = new StacksStore(s); await stacks.ensure();
  const stApp = { stacks, renderStacks() {}, renderStream() {}, stackFilter: false };
  const st = buildWeirTools({ store: s, app: stApp });

  // write (create) → list → read
  const w = await st.stacksWrite({ path: 'specs/weir/idea.md', markdown: '# Idea\n\nA [[abc]] link.', tags: ['Spec', 'weir'] });
  assert.ok(w.ok && w.path === 'specs/weir/idea.md', 'stacksWrite created at the given path');
  assert.equal(w.id, `stacks:${w.uid}`, 'returns the composing item id');
  assert.deepEqual(w.tags, ['spec', 'weir'], 'tags lowercased + set');
  const list = await st.stacksList({});
  assert.equal(list.count, 1, 'one entry'); assert.ok(list.folders.includes('specs/weir'), 'folder surfaced');
  assert.equal((await st.stacksList({ path: 'specs' })).count, 1, 'folder scope (recursive) matches');
  assert.equal((await st.stacksList({ path: 'other' })).count, 0, 'out-of-scope folder excluded');
  const rd = await st.stacksRead({ path: 'specs/weir/idea.md' });
  assert.match(rd.markdown, /# Idea/, 'read returns the note body'); assert.ok(!rd.markdown.includes('uid'), 'body has no frontmatter');

  // write (update) preserves uid + identity
  const w2 = await st.stacksWrite({ path: 'specs/weir/idea.md', markdown: '# Idea v2\n\nupdated.' });
  assert.equal(w2.uid, w.uid, 'update kept the uid (no dupe)');
  assert.match((await st.stacksRead({ path: 'specs/weir/idea.md' })).markdown, /v2/, 'body updated in place');
  // authoritative save REPLACES the tag set (can remove, not only add)
  const w3 = await st.stacksWrite({ path: 'specs/weir/idea.md', markdown: '# Idea v3', tags: ['spec', 'kept'] });
  assert.deepEqual(w3.tags.slice().sort(), ['kept', 'spec'], 'write set the new tag list');
  assert.deepEqual(s.getItem(w.id).tags.slice().sort(), ['kept', 'spec'], 'and dropped "weir" (replace, not union)');

  // tag → mirrored to frontmatter on disk
  await st.stacksTag({ path: 'specs/weir/idea.md', add: ['Reviewed'], remove: ['weir'] });
  const tagged = s.getItem(w.id);
  assert.ok(tagged.tags.includes('reviewed') && !tagged.tags.includes('weir'), 'tags add/remove applied');
  assert.equal(tagged.tag_src.reviewed, 'llm', 'MCP stacks tag stamped llm');
  const fileRaw = await s.vfs.readFile('/stacks/specs/weir/idea.md', 'utf8');
  assert.ok(fileRaw.includes('reviewed') && !/\bweir\b/.test(fileRaw.split('---')[1] || ''), 'frontmatter mirrors the tag change');

  // move keeps identity + state
  s.setState(w.id, { read: true });
  const mv = await st.stacksMove({ path: 'specs/weir/idea.md', toFolder: 'archive/specs' });
  assert.equal(mv.movedFrom, 'specs/weir/idea.md'); assert.equal(mv.path, 'archive/specs/idea.md', 'moved');
  assert.equal(mv.uid, w.uid, 'uid preserved across move');
  assert.equal(s.getItem(w.id).read, true, 'read-state rode along the move');
  assert.equal(await s.vfs.exists('/stacks/specs/weir/idea.md'), false, 'old file gone');

  // trash → never-delete (file survives in .trash, dropped from index) → restore
  const tr = await st.stacksTrash({ path: 'archive/specs/idea.md' });
  assert.ok(tr.ok && tr.dest.startsWith('.trash/'), 'trash moved to .trash');
  assert.equal(s.getItem(w.id), null, 'entry dropped from index');
  assert.equal(await s.vfs.exists('/stacks/archive/specs/idea.md'), false, 'file gone from its path');
  assert.equal(await s.vfs.exists(`/stacks/${tr.dest}`), true, 'bytes survive in .trash (never really deleted)');
  assert.equal((await st.stacksList({})).count, 0, 'list no longer shows it');
  const restored = await stacks.restoreFromTrash(tr.dest, tr.trashed); await s.flush();
  assert.ok(restored && restored.uid === w.uid, 'restore re-indexes with the same uid');
  assert.equal((await st.stacksList({})).count, 1, 'back in the list after restore');

  // errors
  await assert.rejects(st.stacksRead({ path: 'nope.md' }), /No stacks entry/, 'missing path errors');
  await assert.rejects(st.stacksWrite({}), /markdown/, 'write needs a body');
  await assert.rejects(buildWeirTools({ store: s }).stacksList({}), /only available in the running app/, 'no app.stacks → guarded');
}

// ── getItem link graph (links + backlinks) ──
{
  const s2 = new Store(await VFS.create()); await s2._hydrate();
  const k = new StacksStore(s2); await k.ensure();
  const t2 = buildWeirTools({ store: s2, app: { stacks: k, renderStacks() {}, renderStream() {} } });
  const a = await t2.stacksWrite({ path: 'a.md', markdown: '# A' });
  const b = await t2.stacksWrite({ path: 'b.md', markdown: `links to [[${a.uid}]]` });
  const gia = await t2.getItem({ id: a.id });
  assert.ok((gia.backlinks || []).some((x) => x.id === b.id), 'getItem: backlinks lists the linking note');
  const gib = await t2.getItem({ id: b.id });
  assert.ok((gib.links || []).some((l) => l.ref === a.uid && l.id === a.id), 'getItem: links resolve [[ref]] → target');
}

console.log('webmcp tools smoke ok:', JSON.stringify({ items: all.count, facets: Object.keys(f).length, mutations: calls.length }));
