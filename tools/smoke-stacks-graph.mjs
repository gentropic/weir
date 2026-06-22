// Stacks as first-class corpus (SPEC-stacks-first-class): notes join the knowledge
// graph (relate auto-cards uncataloged notes; [[name]] wiki-links resolve as a soft
// layer), bare-path writes report their destination, and weir_stacksEdit does
// partial edits. Run: node tools/smoke-stacks-graph.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { StacksStore } from '../src/js/stacks.js';
import { buildWeirTools } from '../src/js/webmcp.js';

const store = new Store(await VFS.create()); await store._hydrate();
const stacks = new StacksStore(store); await stacks.ensure();
const app = { stacks, renderStacks() {}, renderStream() {}, stackFilter: false };
const t = buildWeirTools({ store, app });

// ── Part B: bare path → inbox, but REPORTED (no silent default) ──
const bare = await t.stacksWrite({ name: 'stray-thought.md', markdown: '# Stray\n\njust a thought' });
assert.ok(bare.routedToInbox === true, 'bare write reports routedToInbox');
assert.equal(bare.folder, 'inbox', 'and names the destination folder');
assert.match(bare.note || '', /inbox/, 'note explains the inbox default');
const placed = await t.stacksWrite({ path: 'gcu/notes/idea.md', markdown: '# Idea' });
assert.ok(!placed.routedToInbox, 'an explicit path is not flagged as inbox-routed');
assert.equal(placed.folder, 'gcu/notes', 'explicit folder reported');

// ── Part A: notes in the graph — relate by PATH auto-cards uncataloged notes ──
const a = await t.stacksWrite({ path: 'gcu/auditable.md', markdown: '# Auditable\n\nthe works surface' });
const b = await t.stacksWrite({ path: 'gcu/hopper.md', markdown: '# Hopper\n\nthe totality boundary' });
assert.ok(!store.getItem(a.id).glass_id, 'note A starts uncataloged (no card)');

// relatedTo on an uncataloged note: no edges yet, but a helpful note (does NOT throw)
const pre = await t.relatedTo({ id: 'gcu/auditable.md' });
assert.deepEqual(pre.outgoing, [], 'uncataloged note has no ratified edges');
assert.match(pre.note || '', /not in the catalog graph/, 'explains it has no card yet');

// relate the two notes BY PATH — both get Stage-0 stub cards on the fly
const made = await t.relate({ from: 'gcu/auditable.md', to: 'gcu/hopper.md', type: 'extends', rationale: 'A builds on B' });
assert.equal(made.related, true); assert.equal(made.type, 'extends');
const aCard = store.getItem(a.id).glass_id, bCard = store.getItem(b.id).glass_id;
assert.ok(aCard && bCard, 'both notes were auto-carded (Stage-0 stub) so they could relate');
assert.equal(store.cards.get(aCard).glass.via, 'relate', 'the stub is marked via:relate for audit');

// the edge + backlink are now navigable from either end, by path
const fwd = await t.relatedTo({ id: 'gcu/auditable.md' });
assert.equal(fwd.outgoing[0].id, b.id, 'A → B edge present, resolved to the item id');
assert.equal(fwd.outgoing[0].type, 'extends');
const back = await t.relatedTo({ id: 'gcu/hopper.md' });
assert.equal(back.backlinks[0].id, a.id, 'B is back-linked from A');

// ensureCard is idempotent + a later full catalog would reuse this glass_id (edge-safe)
const again = await store.ensureCard(a.id);
assert.equal(again, aCard, 'ensureCard is idempotent (same glass_id)');

// ── Part A: [[name]] wiki-links resolve as a soft layer (no ratification) ──
// link by TITLE and by UID; both should resolve to the target item
const linker = await t.stacksWrite({ path: 'gcu/map.md', markdown: `# Map\n\nsee [[Auditable]] and [[${b.uid}]]` });
const wl = await t.relatedTo({ id: 'gcu/map.md' });
assert.ok(wl.wikilinks, 'wikilinks layer surfaced');
assert.ok(wl.wikilinks.links.some((l) => l.ref === 'Auditable' && l.id === a.id), '[[Title]] resolves to the item (ci)');
assert.ok(wl.wikilinks.links.some((l) => l.id === b.id), '[[uid]] resolves to the item');
// inbound: the target sees the linker as a wiki-backlink
const aw = await t.relatedTo({ id: 'gcu/auditable.md' });
assert.ok(aw.wikilinks && aw.wikilinks.backlinks.some((x) => x.id === linker.id), 'target shows the [[name]] backlink');
// an unresolved [[ref]] stays a dangling marker, not an error
const dangle = await t.stacksWrite({ path: 'gcu/dangle.md', markdown: 'see [[nonexistent-note]]' });
const dw = await t.relatedTo({ id: 'gcu/dangle.md' });
assert.ok(dw.wikilinks.links.some((l) => l.ref === 'nonexistent-note' && !l.id), 'dangling [[ref]] kept as a marker');

// ── Part C: weir_stacksEdit — partial edit / append, explicit errors ──
await t.stacksWrite({ path: 'gcu/edit-me.md', markdown: '# Edit me\n\nThe quick brown fox.\nA second line.' });
const ed = await t.stacksEdit({ path: 'gcu/edit-me.md', find: 'quick brown fox', replace: 'slow green turtle' });
assert.match(ed.markdown, /slow green turtle/, 'find/replace applied');
assert.ok(!ed.markdown.includes('quick brown fox'), 'old text gone');
const ap = await t.stacksEdit({ path: 'gcu/edit-me.md', append: 'A trailing block.' });
assert.match(ap.markdown, /A trailing block\.\s*$/, 'append added a trailing block');
assert.match(ap.markdown, /slow green turtle/, 'append preserved prior edit');
// replaceAll vs not-unique
await t.stacksWrite({ path: 'gcu/dupe.md', markdown: 'foo and foo again' });
await assert.rejects(t.stacksEdit({ path: 'gcu/dupe.md', find: 'foo', replace: 'bar' }), /not unique/, 'non-unique find errors');
const all = await t.stacksEdit({ path: 'gcu/dupe.md', find: 'foo', replace: 'bar', replaceAll: true });
assert.equal((all.markdown.match(/bar/g) || []).length, 2, 'replaceAll replaced every occurrence');
// not-found + identity preserved
await assert.rejects(t.stacksEdit({ path: 'gcu/edit-me.md', find: 'absent text', replace: 'x' }), /not found/, 'missing find errors');
const before = store.getItem((await t.stacksRead({ path: 'gcu/edit-me.md' })).id);
assert.ok(before, 'note still present after edits (uid preserved)');
await assert.rejects(t.stacksEdit({ path: 'nope.md', find: 'x', replace: 'y' }), /No stacks entry/, 'unknown path errors');

console.log('stacks-graph smoke ok:', JSON.stringify({ cards: store.cards.size, entries: stacks.entries().length }));
