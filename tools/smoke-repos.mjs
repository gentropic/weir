// Repos as a first-class source (SPEC-repos-as-source): the agent hands a repo's docs
// + a commit anchor to weir; weir stores them as a synthetic, non-polled source whose
// `doc` items are searchable/relatable/citable. Refresh = re-ingest the delta + advance
// the anchor. weir never reads the repo or runs git. Run: node tools/smoke-repos.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { buildWeirTools } from '../src/js/webmcp.js';
import { facetsOf } from '../src/js/glass.js';
import { hash32 } from '../src/js/store/schema.js';

const store = new Store(await VFS.create()); await store._hydrate();
const app = { renderAll() {} };
const t = buildWeirTools({ store, app });

// ── first ingest: creates the source (an agent proposal) + the doc items ──
const r1 = await t.ingestRepo({
  repo: '../auditable', name: 'auditable (repo)', anchor: 'aaaa111',
  rationale: 'GCU constellation map',
  docs: [
    { path: 'README.md', title: 'auditable', markdown: '# auditable\n\nthe works surface' },
    { path: 'docs/SPEC.md', title: 'SPEC', markdown: '# SPEC\n\nthe totality security boundary' },
  ],
}, { identity: 'claude:librarian' });
assert.ok(r1.ok && r1.source.id === 'repo:auditable', 'source keyed by repo basename');
assert.equal(r1.inserted, 2, 'two docs ingested'); assert.equal(r1.anchor, 'aaaa111', 'anchor stored');
const feed = store.getFeed('repo:auditable');
assert.equal(feed.adapter, 'repo', 'synthetic repo adapter');
assert.equal(feed.config.kind, 'repo', 'config marks it a repo source');
assert.ok((feed.next_poll_at || 0) >= 8.64e15, 'never polled (poller skips it)');
assert.equal(feed.source, 'agent', 'agent-added → a proposal'); assert.equal(feed.added_by, 'claude:librarian', 'identity stamped');
assert.ok(store.pendingProposals().feeds.some((f) => f.id === 'repo:auditable'), 'shows in the review queue as a feed proposal');

// doc items: type 'doc', stable ids, content stored, searchable
const docs = (await t.queryItems({ feed: 'repo:auditable' })).items;
assert.equal(docs.length, 2, 'both docs are items under the source');
assert.ok(docs.every((d) => d.type === 'doc'), 'items are type:doc');
const readme = store.getItem('repo:auditable:' + (await import('../src/js/store/schema.js')).hash32('README.md'));
assert.ok(readme && readme.has_content, 'stable id + content stored');
assert.equal(await store.getContent(readme.id), '# auditable\n\nthe works surface', 'doc body round-trips');
const found = await t.search({ q: 'totality' });
assert.ok(found.items.some((i) => i.id.startsWith('repo:auditable:')), 'doc body is searchable');

// ── refresh: re-ingest a CHANGED doc + a NEW one, advance the anchor, never reset state ──
store.setState(readme.id, { read: true });
const r2 = await t.ingestRepo({
  repo: '../auditable', anchor: 'bbbb222',
  docs: [
    { path: 'README.md', title: 'auditable', markdown: '# auditable\n\nNOW WITH EDITS' },   // changed
    { path: 'ROADMAP.md', title: 'ROADMAP', markdown: '# ROADMAP\n\nwhat is next' },        // new
  ],
});
assert.equal(r2.inserted, 1, 'the new doc inserted'); assert.equal(r2.updated, 1, 'the changed doc updated');
assert.equal(r2.anchor, 'bbbb222', 'anchor advanced');
assert.equal(store.getFeed('repo:auditable').config.anchor, 'bbbb222', 'anchor persisted on the source');
assert.equal(store.getItem(readme.id).read, true, 'read-state survived the re-ingest (never reset)');
assert.equal(await store.getContent(readme.id), '# auditable\n\nNOW WITH EDITS', 'changed doc body updated in place');

// the agent reads the anchor back from listSources (to diff next time)
const src = await t.listSources({ q: 'auditable' });
assert.ok(src.feeds.some((f) => f.kind === 'repo' && f.anchor === 'bbbb222'), 'listSources surfaces the stored anchor');

// ── removed: a deleted doc is archived, never deleted ──
const r3 = await t.ingestRepo({ repo: '../auditable', anchor: 'cccc333', removed: ['docs/SPEC.md'] });
assert.equal(r3.removed, 1, 'one doc archived');
const specId = 'repo:auditable:' + (await import('../src/js/store/schema.js')).hash32('docs/SPEC.md');
assert.equal(store.getItem(specId).archived, true, 'removed doc archived (not deleted)');
assert.ok(store.getItem(specId), 'bytes/record survive in the standing archive');

// ── graph integration: relate a stacks-style dive-map item to a repo doc by id ──
await store.putFeed({ id: 'stacks', name: 'Stacks', adapter: 'stacks', url: '', next_poll_at: 8.64e15 });
await store.upsertItems([{ id: 'stacks:map1', feed_id: 'stacks', type: 'note', title: 'auditable map', content: 'my dive-map of auditable' }]);
const made = await t.relate({ from: 'stacks:map1', to: readme.id, type: 'same-topic', rationale: 'the map covers this repo' });
assert.equal(made.related, true, 'dive-map relates to a repo doc (both auto-carded if needed)');
const rel = await t.relatedTo({ id: readme.id });
assert.ok(rel.backlinks.some((b) => b.id === 'stacks:map1'), 'the repo doc is back-linked from the dive-map');

// ── pilot punch-list fixes (SPEC-repos-as-source-fixes) ──
// #1: refresh updates the still-pending proposal's rationale in place
assert.equal(store.getFeed('repo:auditable').rationale, 'GCU constellation map', 'rationale stored at creation');
await t.ingestRepo({ repo: '../auditable', anchor: 'dddd444', rationale: 'a better blurb' });
assert.equal(store.getFeed('repo:auditable').rationale, 'a better blurb', '#1 refresh updated the rationale in place');

// #2: an oversized rationale is clamped at the MCP boundary (can't wall the queue)
await t.ingestRepo({ repo: '../auditable', anchor: 'eeee555', rationale: 'x'.repeat(2000) });
const clamped = store.getFeed('repo:auditable').rationale;
assert.ok(clamped.length <= 500 && clamped.endsWith('…'), '#2 oversized rationale clamped + ellipsized');

// #3: repo docs get their own catalog `form` (not 'article'), so the corpus can scope to project docs
assert.deepEqual(facetsOf(store.getItem(readme.id), store.getFeed('repo:auditable')).form, ['doc'], '#3 form facet = doc');

// #4: the repo source summarizes itself in the review queue (N docs @ anchor), not via rationale text
const rp = store.pendingProposals().feeds.find((f) => f.id === 'repo:auditable');
assert.ok(rp && rp.kind === 'repo' && rp.docs >= 1 && rp.anchor === 'eeee555', '#4 pendingProposals carries repo docs + anchor');
const rq = await t.reviewQueue({ kind: 'feed' });
const ritem = rq.items.find((i) => i.id === 'repo:auditable');
assert.ok(ritem && ritem.repo === true && ritem.docs >= 1 && ritem.anchor, '#4 reviewQueue surfaces the repo summary');

// ── #5: path-based ingest reads named files from a (mocked) read-only repos mount ──
// No verbatim conduit: the agent names paths; weir reads the bytes. Here a memory VFS
// stands in for the FSA mount (the real app.readRepoDoc reads via the read-only handle).
{
  const mem = await VFS.create();
  await mem.mkdir('/pathtest/docs', { recursive: true });
  await mem.writeFile('/pathtest/README.md', '# pathtest (full)\n\nthe complete readme, not abridged through a tool call');
  await mem.writeFile('/pathtest/docs/SPEC.md', '# SPEC full body');
  const appM = {
    renderAll() {},
    async readRepoDoc(dir, path) {                       // mirrors the real method's contract
      const clean = String(path).replace(/\\/g, '/').replace(/^\/+/, '');
      if (clean.split('/').includes('..')) throw new Error('invalid path (no .. traversal)');
      try { return await mem.readFile(`/${dir}/${clean}`, 'utf8'); } catch { return null; }
    },
  };
  const tm = buildWeirTools({ store, app: appM });
  const rp = await tm.ingestRepo({ repo: 'pathtest', anchor: 'p1', paths: ['README.md', { path: 'docs/SPEC.md', title: 'Spec' }, 'missing.md'] });
  assert.equal(rp.inserted, 2, '#5 two named files read from the mount + ingested');
  assert.ok(rp.skipped && rp.skipped.some((s) => s.path === 'missing.md'), '#5 a missing path is reported in skipped, not fatal');
  assert.match(await store.getContent('repo:pathtest:' + hash32('README.md')), /not abridged through a tool call/, '#5 full body read from disk (no conduit)');
  // traversal is blocked + reported, never fatal
  const trav = await tm.ingestRepo({ repo: 'pathtest', anchor: 'p2', paths: ['../escape.md'] });
  assert.ok(trav.skipped.some((s) => /traversal/.test(s.error)), '#5 .. traversal blocked + reported');
  // hybrid: paths + inline docs in one call
  const hy = await tm.ingestRepo({ repo: 'pathtest', anchor: 'p3', paths: ['README.md'], docs: [{ path: 'CLAUDE.md', markdown: '# charter (gitignored, passed inline)' }] });
  assert.ok(hy.inserted >= 1 && hy.updated >= 1, '#5 hybrid paths + inline docs both land');
  // paths with no mount → a clear error (not a silent miss)
  await assert.rejects(buildWeirTools({ store, app: { renderAll() {} } }).ingestRepo({ repo: 'pathtest', paths: ['README.md'] }), /not mounted/, '#5 paths without a mount errors clearly');
}

// ── bodyless signal: a metadata-only doc (no markdown) is flagged, not silently stored empty ──
const bl = await t.ingestRepo({ repo: '../auditable', anchor: 'f1', docs: [{ path: 'EMPTY.md', title: 'empty' }, { path: 'docs/full.md', markdown: '# Full\n\nreal body here' }] });
assert.deepEqual(bl.bodyless, ['EMPTY.md'], 'metadata-only doc flagged in bodyless; the one with markdown is not');
assert.ok(!store.getItem('repo:auditable:' + hash32('EMPTY.md')).has_content, 'the bodyless doc has no content (would skip cataloging)');
assert.ok(store.getItem('repo:auditable:' + hash32('docs/full.md')).has_content, 'the doc with markdown has content');

// ── validation ──
await assert.rejects(t.ingestRepo({}), /repo/, 'needs a repo');
await assert.rejects(t.ingestRepo({ repo: 'x' }), /docs.*removed.*anchor|pass/, 'needs something to do');
await assert.rejects(t.ingestRepo({ repo: 'x', docs: [{ markdown: 'no path' }] }), /path/, 'each doc needs a path');

console.log('repos-as-source smoke ok:', JSON.stringify({ sources: 1, docs: docs.length, anchor: r3.anchor }));
