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

// feeds: one agent-proposed (with a rationale), one human (UI) — only the agent's pends
await store.putFeed({ id: 'human-feed', name: 'Human Feed', adapter: 'feed', url: 'http://h' });
await store.putFeed({ id: 'agent-feed', name: 'Agent Feed', adapter: 'feed', url: 'http://a', source: 'agent', added_by: 'claude:dev', rationale: 'fills the ESP32 gap' });

// cards + edges: one agent-proposed edge (with a rationale), one human edge
const card = (gid, title) => ({ dublin_core: { title }, glass: { glass_id: gid, document_ref: 'i-' + gid, related: [] }, facets: {} });
await store.writeCard(card('g1', 'A')); await store.writeCard(card('g2', 'B')); await store.writeCard(card('g3', 'C'));
store.relateCards('g1', 'g2', { type: 'related', source: 'agent', by: 'claude:dev', rationale: 'both cover MQTT' });   // an agent proposal
store.relateCards('g1', 'g3', { type: 'related', source: 'human' });                       // human-made (not a proposal)

// a book proposal: an agent-added holding (a to-buy suggestion) with a rationale
await store.putFeed({ id: 'books', name: 'Books', adapter: 'feed', url: 'x' });
await store.upsertItems([{ id: 'book:1', feed_id: 'books', type: 'book', title: 'ESPHome in Depth', url: 'x', published_at: 1, tags: ['to-buy'], added_by: 'claude:dev', added_rationale: 'the canonical ESPHome reference, not owned' }]);

const tools = buildWeirTools({ store });

// ── store.pendingProposals: only agent-authored, unratified — feeds, relations, books ──
let p = store.pendingProposals();
assert.equal(p.feeds.length, 1, 'only the agent feed pends'); assert.equal(p.feeds[0].id, 'agent-feed');
assert.equal(p.feeds[0].rationale, 'fills the ESP32 gap', 'feed proposal carries its rationale');
assert.equal(p.relations.length, 1, 'only the agent edge pends'); assert.equal(p.relations[0].to, 'g2');
assert.equal(p.relations[0].rationale, 'both cover MQTT', 'relation proposal carries its rationale');
assert.equal(p.books.length, 1, 'the agent book pends'); assert.equal(p.books[0].id, 'book:1');

// ── unified queue (no app → catalog empty; feed+relation+book proposals), tagged ──
let q = await tools.reviewQueue({});
assert.deepEqual({ c: q.counts.catalog, f: q.counts.feed, r: q.counts.relation, b: q.counts.book, t: q.counts.total }, { c: 0, f: 1, r: 1, b: 1, t: 3 }, 'counts by kind');
assert.ok(q.items.find((i) => i.kind === 'feed' && i.ratifyWith === 'weir_ratify' && i.rationale === 'fills the ESP32 gap'), 'feed item: ratifyWith + rationale');
assert.ok(q.items.find((i) => i.kind === 'relation' && i.by === 'claude:dev'), 'relation item carries the agent identity');
assert.ok(q.items.find((i) => i.kind === 'book' && i.id === 'book:1' && i.rationale && (i.tags || []).includes('to-buy')), 'book item: rationale + to-buy tag');
assert.equal((await tools.reviewQueue({ kind: 'book' })).items.every((i) => i.kind === 'book'), true, 'kind filter narrows to book');

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

// ── ratify a book → stamped, stays, leaves the queue ──
r = await tools.ratify({ kind: 'book', bookId: 'book:1', action: 'ratify' });
assert.ok(r.ratified_at, 'book stamped ratified_at');
assert.ok(store.getItem('book:1') && !store.getItem('book:1').archived, 'ratified book kept, not archived');
assert.equal(store.pendingProposals().books.length, 0, 'ratified book left the queue');

// ── dismiss a book → archived (non-destructive), leaves the queue ──
await store.upsertItems([{ id: 'book:2', feed_id: 'books', type: 'book', title: 'Maybe Not', url: 'x', published_at: 2, tags: ['to-buy'], added_by: 'claude:dev' }]);
r = await tools.ratify({ kind: 'book', bookId: 'book:2', action: 'dismiss' });
assert.ok(r.archived, 'dismissed book archived'); assert.ok(store.getItem('book:2').archived, 'still exists (never-delete), just archived');
assert.equal(store.pendingProposals().books.length, 0, 'dismissed book left the queue');

// ── validation ──
await assert.rejects(tools.ratify({ kind: 'feed', feedId: 'nope' }), /no feed/, 'unknown feed rejected');
await assert.rejects(tools.ratify({ kind: 'book', bookId: 'nope' }), /no book/, 'unknown book rejected');
await assert.rejects(tools.ratify({ kind: 'bogus' }), /kind must be/, 'bad kind rejected');
await assert.rejects(tools.ratify({ kind: 'relation', from: 'g1' }), /from.*and.*to/, 'relation needs from + to');

console.log('review queue (unified ratify) smoke ok');
