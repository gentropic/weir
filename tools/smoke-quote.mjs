// weir_quote tests (SPEC-reference-desk §3.2b): citation verification — confirm a
// candidate quote is in a source, return a stable locator + context, or report
// no-match (so an agent can refuse to assert ungrounded text). Run:
//   node tools/smoke-quote.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { buildWeirTools } from '../src/js/webmcp.js';

const store = new Store(await VFS.create()); await store._hydrate();
await store.putFeed({ id: 'f', name: 'Geo', adapter: 'feed', url: 'http://x/f' });
await store.upsertItems([
  {
    id: 'p1', feed_id: 'f', type: 'paper', title: 'Kriging variance', url: 'x1', published_at: 1,
    // HTML with wrapping/whitespace noise — quote matching must see through it
    content: '<h1>Kriging variance</h1>\n<p>Ordinary kriging   minimizes\nthe estimation variance under\nan unbiasedness constraint.</p>',
  },
  { id: 'p2', feed_id: 'f', type: 'note', title: 'Excerpt only', url: 'x2', published_at: 2, excerpt: 'A short itabirite note.' },
]);
store.items.get('p1').glass_id = 'g-p1';   // a cataloged item → locator uses the glass_id

const tools = buildWeirTools({ store });

// ── exact match (across HTML/whitespace noise), stable locator + context ──
let r = await tools.quote({ id: 'p1', quote: 'minimizes the estimation variance' });
assert.equal(r.found, true, 'quote found despite the source\'s wrapping/double-spaces');
assert.equal(r.match, 'exact', 'matched after whitespace normalization');
assert.ok(/^g-p1#\d+-\d+$/.test(r.locator), 'locator is "<glass_id>#start-end"');
assert.equal(r.quote, 'minimizes the estimation variance', 'returns the source\'s verbatim span');
assert.ok(r.before.endsWith('kriging '), 'before-context precedes the span');
assert.ok(r.after.startsWith(' under'), 'after-context follows the span');

// ── locator offsets are consistent (re-running gives the same span) ──
const r2 = await tools.quote({ id: 'p1', quote: 'minimizes the estimation variance' });
assert.equal(r2.locator, r.locator, 'locator is stable across calls');

// ── case-insensitive fallback ──
r = await tools.quote({ id: 'p1', quote: 'ORDINARY KRIGING' });
assert.equal(r.found, true); assert.equal(r.match, 'case-insensitive', 'falls back to case-insensitive');
assert.equal(r.quote, 'Ordinary kriging', 'returns the source casing, not the query casing');

// ── no match → found:false with a refuse-to-assert note (NOT a throw) ──
r = await tools.quote({ id: 'p1', quote: 'kriging is a neural network' });
assert.equal(r.found, false, 'a fabricated quote is not found');
assert.ok(/not in the source|do not assert/i.test(r.note), 'no-match note tells the agent to refuse');

// ── falls back to title+excerpt when there is no full body ──
r = await tools.quote({ id: 'p2', quote: 'itabirite note' });
assert.equal(r.found, true, 'matches against the excerpt when no body');
assert.equal(r.locator.split('#')[0], 'p2', 'uncataloged item locator falls back to the item id');

// ── validation ──
await assert.rejects(tools.quote({ quote: 'x' }), /No item/, 'missing/unknown id throws');
await assert.rejects(tools.quote({ id: 'p1' }), /quote/, 'missing quote throws');

console.log('quote (citation verify) smoke ok');
