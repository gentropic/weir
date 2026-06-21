// Unified review queue tests (SPEC-librarian §3): one queue for cataloger
// low-confidence cards + agent structural proposals (feeds, relation edges), tagged
// by `kind`, with a single ratify/dismiss gesture. Catalog kind needs the running app
// (_cardReview), so this exercises the store-level proposal half + the webmcp
// reviewQueue/ratify over it. Run: node tools/smoke-review.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { buildWeirTools } from '../src/js/webmcp.js';

const store = new Store(await VFS.create()); await store._hydrate();

// feeds: one agent-proposed, one human (UI) — only the agent's is a proposal
await store.putFeed({ id: 'human-feed', name: 'Human Feed', adapter: 'feed', url: 'http://h' });
await store.putFeed({ id: 'agent-feed', name: 'Agent Feed', adapter: 'feed', url: 'http://a', source: 'agent', added_by: 'claude:dev' });

// cards + edges: one agent-proposed edge, one human edge
const card = (gid, title) => ({ dublin_core: { title }, glass: { glass_id: gid, document_ref: 'i-' + gid, related: [] }, facets: {} });
await store.writeCard(card('g1', 'A')); await store.writeCard(card('g2', 'B')); await store.writeCard(card('g3', 'C'));
store.relateCards('g1', 'g2', { type: 'related', source: 'agent', by: 'claude:dev' });   // an agent proposal
store.relateCards('g1', 'g3', { type: 'related', source: 'human' });                       // human-made (not a proposal)

const tools = buildWeirTools({ store });

// ── store.pendingProposals: only agent-authored, unratified ──
let p = store.pendingProposals();
assert.equal(p.feeds.length, 1, 'only the agent feed pends'); assert.equal(p.feeds[0].id, 'agent-feed');
assert.equal(p.relations.length, 1, 'only the agent edge pends'); assert.equal(p.relations[0].to, 'g2');

// ── unified queue (no app → catalog empty; proposals present), tagged + ratifyWith ──
let q = await tools.reviewQueue({});
assert.deepEqual({ c: q.counts.catalog, f: q.counts.feed, r: q.counts.relation, t: q.counts.total }, { c: 0, f: 1, r: 1, t: 2 }, 'counts by kind');
assert.ok(q.items.find((i) => i.kind === 'feed' && i.ratifyWith === 'weir_ratify'), 'feed item points at weir_ratify');
assert.ok(q.items.find((i) => i.kind === 'relation' && i.by === 'claude:dev'), 'relation item carries the agent identity');
assert.equal((await tools.reviewQueue({ kind: 'feed' })).items.every((i) => i.kind === 'feed'), true, 'kind filter narrows');

// ── ratify a feed → stays, marked ratified, leaves the queue ──
let r = await tools.ratify({ kind: 'feed', feedId: 'agent-feed', action: 'ratify' });
assert.ok(r.ratified_at, 'feed stamped ratified_at');
assert.ok(store.getFeed('agent-feed'), 'a ratified feed still exists');
assert.equal(store.pendingProposals().feeds.length, 0, 'ratified feed left the queue');

// ── ratify a relation → edge marked, leaves the queue, edge still present ──
r = await tools.ratify({ kind: 'relation', from: 'g1', to: 'g2', action: 'ratify' });
assert.equal(r.ratified, true, 'edge ratified');
assert.equal(store.pendingProposals().relations.length, 0, 'ratified edge left the queue');
assert.ok(store.relatedOf('g1').outgoing.some((e) => e.glass_id === 'g2'), 'ratified edge is still there');

// ── dismiss a feed → undo the un-ratified add ──
await store.putFeed({ id: 'agent-feed-2', name: 'Agent Feed 2', adapter: 'feed', url: 'http://a2', source: 'agent', added_by: 'claude:dev' });
r = await tools.ratify({ kind: 'feed', feedId: 'agent-feed-2', action: 'dismiss' });
assert.ok(r.removed && !store.getFeed('agent-feed-2'), 'dismissed feed removed');

// ── dismiss a relation → unrelate ──
store.relateCards('g2', 'g3', { type: 'related', source: 'agent', by: 'claude:dev' });
r = await tools.ratify({ kind: 'relation', from: 'g2', to: 'g3', action: 'dismiss' });
assert.ok(r.removed >= 1, 'dismissed edge unrelated');
assert.equal(store.pendingProposals().relations.length, 0, 'no proposals left');

// ── validation ──
await assert.rejects(tools.ratify({ kind: 'feed', feedId: 'nope' }), /no feed/, 'unknown feed rejected');
await assert.rejects(tools.ratify({ kind: 'bogus' }), /kind must be/, 'bad kind rejected');
await assert.rejects(tools.ratify({ kind: 'relation', from: 'g1' }), /from.*and.*to/, 'relation needs from + to');

console.log('review queue (unified ratify) smoke ok');
