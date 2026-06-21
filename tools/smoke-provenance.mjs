// Provenance taxonomy tests (SPEC-librarian §2): the unified `source:'agent'` tier +
// the per-connection identity (`by`) on tags / edges / feeds / book holdings, and the
// one-shot migration of the agent's historically-split stamps ('llm' tags, 'claude'
// edges) → 'agent'. Run: node tools/smoke-provenance.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';

const store = new Store(await VFS.create()); await store._hydrate();

// ── tag provenance: the agent tier + identity (by); human stays unmarked ──
await store.putFeed({ id: 'f', url: 'https://example.com/f', name: 'F', adapter: 'feed' });   // upsertItems skips items with no feed
await store.upsertItems([
  { id: 'f:1', feed_id: 'f', type: 'article', title: 'Kriging primer', url: 'x', published_at: 1 },
  { id: 'f:2', feed_id: 'f', type: 'article', title: 'Itabirite notes', url: 'y', published_at: 2 },
]);
store.addTag('f:1', 'geostatistics', 'agent', 'claude:opus-4.8');
assert.equal(store.getItem('f:1').tag_src.geostatistics, 'agent', 'tag stamped with the agent tier');
assert.equal(store.getItem('f:1').tag_by.geostatistics, 'claude:opus-4.8', 'tag carries the agent identity (by)');
store.addTag('f:1', 'mine', 'human');
assert.equal(store.getItem('f:1').tag_src.mine, 'human', 'a human tag stays human');
assert.ok(!(store.getItem('f:1').tag_by || {}).mine, 'a human tag carries no identity');
store.removeTag('f:1', 'geostatistics');
assert.ok(!store.getItem('f:1').tags.includes('geostatistics'), 'tag removed');
assert.ok(!(store.getItem('f:1').tag_by || {}).geostatistics, 'tag_by cleared on remove');

// bulk path carries identity too
store.addTagBulk(['f:1', 'f:2'], ['agentbulk'], 'agent', 'claude:dev');
assert.equal(store.getItem('f:2').tag_by.agentbulk, 'claude:dev', 'bulk-tag carries identity');

// ── edge provenance: source + by, surfaced by relatedOf (outgoing + backlinks) ──
const card = (gid, title) => ({ dublin_core: { title }, glass: { glass_id: gid, document_ref: 'item-' + gid, related: [] }, facets: {} });
await store.writeCard(card('g1', 'A')); await store.writeCard(card('g2', 'B'));
const edge = store.relateCards('g1', 'g2', { type: 'related', source: 'agent', by: 'claude:opus-4.8' });
assert.equal(edge.source, 'agent'); assert.equal(edge.by, 'claude:opus-4.8', 'edge carries identity');
assert.equal(store.relatedOf('g1').outgoing[0].by, 'claude:opus-4.8', 'relatedOf surfaces the edge identity (outgoing)');
assert.equal(store.relatedOf('g2').backlinks[0].source, 'agent', 'relatedOf surfaces the agent tier (backlink)');

// ── feed provenance: source + added_by (the gap — feeds carried no marker) ──
const feed = await store.putFeed({ url: 'https://example.com/feed', name: 'Example', adapter: 'feed', source: 'agent', added_by: 'claude:opus-4.8' });
assert.equal(feed.source, 'agent', 'agent feed-add stamped with the agent tier');
assert.equal(feed.added_by, 'claude:opus-4.8', 'feed carries the agent identity');
const human = await store.putFeed({ url: 'https://example.com/2', name: 'Human feed', adapter: 'feed' });
assert.ok(!human.source && !human.added_by, 'a plain (human/UI) feed-add carries no agent marker');

// ── migration: legacy 'llm' tags + 'claude' edges → unified 'agent' ──
store.addTag('f:2', 'legacy', 'llm');                                  // an old agent tag
store.relateCards('g2', 'g1', { type: 'related', source: 'claude' });  // an old agent edge
const counts = store.migrateProvenance();
assert.equal(store.getItem('f:2').tag_src.legacy, 'agent', "migrated 'llm' tag → 'agent'");
assert.equal(store.relatedOf('g2').outgoing.find((e) => e.glass_id === 'g1').source, 'agent', "migrated 'claude' edge → 'agent'");
assert.ok(counts.tags >= 1 && counts.edges >= 1, 'migration reports counts');
const again = store.migrateProvenance();
assert.equal(again.tags, 0); assert.equal(again.edges, 0, 're-running migration is a no-op (idempotent)');

// ── backfill: a book whose added_by was stripped (pre-fix bug), found by web-proposed tag ──
await store.putFeed({ id: 'books', name: 'Books', adapter: 'feed', url: 'b' });
await store.upsertItems([{ id: 'book:9', feed_id: 'books', type: 'book', title: 'ESPHome in Practice', url: 'b', published_at: 9, tags: ['to-buy', 'web-proposed'] }]);   // no added_by (the bug)
assert.ok(!store.getItem('book:9').added_by, 'precondition: book missing added_by');
assert.equal(store.pendingProposals().books.length, 0, 'a book without added_by is NOT in the queue');
const bf = store.migrateProvenance({ backfillBooks: 'claude:librarian' });
assert.equal(bf.books, 1, 'backfill stamped 1 book');
assert.equal(store.getItem('book:9').added_by, 'claude:librarian', 'added_by backfilled from the web-proposed tag');
assert.equal(store.pendingProposals().books.length, 1, 'backfilled book now appears in the queue');
assert.equal(store.migrateProvenance({ backfillBooks: 'claude:librarian' }).books, 0, 'backfill is idempotent');
// a human to-buy book (no web-proposed tag) is left alone
await store.upsertItems([{ id: 'book:10', feed_id: 'books', type: 'book', title: 'My wishlist book', url: 'b', published_at: 10, tags: ['to-buy'] }]);
store.migrateProvenance({ backfillBooks: 'claude:librarian' });
assert.ok(!store.getItem('book:10').added_by, 'a human to-buy book (no web-proposed tag) is not touched');

console.log('provenance (SPEC-librarian §2) smoke ok');
