// The agent's footprint — weir_listMine (SPEC-librarian-provenance-view): a current-state
// provenance lens across kinds (tag/note/edge/feed/book/catalog), by identity, with status.
// Plus the prerequisite: agent-authored notes carry their identity (added_by + frontmatter,
// surviving a rescan). Run: node tools/smoke-listmine.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { StacksStore } from '../src/js/stacks.js';
import { buildWeirTools } from '../src/js/webmcp.js';

const store = new Store(await VFS.create()); await store._hydrate();
const stacks = new StacksStore(store); await stacks.ensure();
const app = { stacks, renderStacks() {}, renderStream() {}, renderRail() {}, renderAll() {}, stackFilter: false };
const t = buildWeirTools({ store, app });
const LIB = { identity: 'claude:librarian' };
const DEV = { identity: 'claude:dev' };

// ── prerequisite: an agent note carries its identity (not just source:'agent') ──
const note = await t.stacksWrite({ path: 'gcu/map.md', markdown: '# Map' }, LIB);
assert.equal(store.getItem(note.id).added_by, 'claude:librarian', 'note stamped with the agent identity');
const raw = await store.getContent(note.id);
assert.match(raw, /by:\s*['"]?claude:librarian/, 'identity emitted to frontmatter (portable)');
// survives a rescan (rebuilt from the file)
await store.flush();
{ const re = new Store(store.vfs); await re._hydrate(); const rs = new StacksStore(re); await rs.ensure(); await rs.scan();
  assert.equal(re.getItem(note.id).added_by, 'claude:librarian', 'identity survives a rescan via frontmatter'); }
// a human (no client) note stays unattributed
const hnote = await stacks.writeNote({ path: 'gcu/human.md', markdown: '# by hand' });
assert.ok(!store.getItem(hnote.id).added_by, 'human-authored note has no agent identity');

// ── seed a footprint across kinds, two identities ──
await store.putFeed({ id: 'f', name: 'Feed', adapter: 'feed', url: 'http://f' });
await store.upsertItems([{ id: 'a1', feed_id: 'f', type: 'article', title: 'Item one' }]);
await t.tag({ id: 'a1', add: ['kriging'] }, LIB);                          // tag by librarian
await store.putFeed({ id: 'books', name: 'Books', adapter: 'books', url: '', next_poll_at: 8.64e15 });
await store.upsertItems([{ id: 'book:1', feed_id: 'books', type: 'book', title: 'To Buy', added_by: 'claude:librarian', added_rationale: 'wishlist', tags: ['to-buy'] }]);   // book proposal (pending)
await store.putFeed({ id: 'agentfeed', name: 'Agent Feed', adapter: 'feed', url: 'http://af', source: 'agent', added_by: 'claude:librarian' });   // feed proposal (pending)
// two cards + an agent-proposed edge between them (pending)
const blank = { domain: [], entity: [], process: [], method: [], scale: [], spatial: [], stance: [], form: [], provenance: [], temporal: [] };
await store.writeCard({ dublin_core: { title: 'Card A' }, facets: { ...blank }, glass: { glass_id: 'glass-1', document_ref: 'a1', related: [] } });
await store.writeCard({ dublin_core: { title: 'Card B' }, facets: { ...blank }, glass: { glass_id: 'glass-2', document_ref: 'note:x', related: [] } });
await t.relate({ from: 'glass-1', to: 'glass-2', type: 'related' }, LIB);  // edge by librarian (pending)
// an agent-AUTHORED catalog card (reviewer:agent)
await store.markCardReviewed('glass-1', { reviewer: 'agent', by: 'claude:librarian' });
// a contribution by the OTHER channel
await t.tag({ id: 'a1', add: ['devtag'] }, DEV);

// ── listMine defaults to the calling channel ──
const mine = await t.listMine({}, LIB);
const kinds = new Set(mine.contributions.map((c) => c.kind));
for (const k of ['tag', 'note', 'edge', 'feed', 'book', 'catalog']) assert.ok(kinds.has(k), `librarian footprint includes a ${k}`);
assert.ok(mine.contributions.every((c) => c.identity === 'claude:librarian'), 'default scopes to the calling channel');
assert.ok(!mine.contributions.some((c) => c.label === 'devtag'), "the other channel's tag is excluded");
assert.equal(mine.counts.total, mine.contributions.length, 'counts.total matches');

// ── per-kind status is correct ──
const byKind = (k) => mine.contributions.filter((c) => c.kind === k);
assert.equal(byKind('feed')[0].status, 'pending', 'an un-ratified feed is pending');
assert.equal(byKind('book')[0].status, 'pending', 'an un-ratified book is pending');
assert.equal(byKind('edge')[0].status, 'pending', 'an un-ratified edge is pending');
assert.equal(byKind('catalog')[0].status, 'authored', 'an agent-authored card is authored');
assert.equal(byKind('tag')[0].status, 'applied', 'a tag is applied (no gate)');
assert.equal(byKind('note')[0].status, 'applied', 'a note is applied');

// ── ratify flips status (pending → ratified) ──
await t.ratify({ kind: 'feed', feedId: 'agentfeed', action: 'ratify' }, LIB);
const after = await t.listMine({ kinds: ['feed'] }, LIB);
assert.equal(after.contributions[0].status, 'ratified', 'ratified feed now shows ratified');
assert.equal((await t.listMine({ kinds: ['feed'], status: 'pending' }, LIB)).count, 0, 'status filter: no pending feeds left');

// ── identity:'*' = the cross-channel view (sees both agents) ──
const all = await t.listMine({ identity: '*' }, LIB);
assert.ok(all.contributions.some((c) => c.identity === 'claude:dev'), "identity:'*' includes the dev channel");
assert.ok(all.contributions.some((c) => c.identity === 'claude:librarian'), "and the librarian channel");
// explicit identity scopes to just that one
assert.ok((await t.listMine({ identity: 'claude:dev' }, LIB)).contributions.every((c) => c.identity === 'claude:dev'), 'explicit identity scopes precisely');

// ── kinds filter ──
const justTags = await t.listMine({ kinds: ['tag'] }, LIB);
assert.ok(justTags.contributions.every((c) => c.kind === 'tag'), 'kinds filter narrows to tags');

console.log('listMine smoke ok:', JSON.stringify(mine.counts));
