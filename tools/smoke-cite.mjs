// Citation export (SPEC-citation-export): weir_cite renders stable, resolvable
// references; verify-in (id+quote → cited or refuse); batch → a bibliography with
// stable cite-keys; missing-field honesty; the [[handle]] wikilink resolves as a live
// backlink via wikiLinksOf. Run: node tools/smoke-cite.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { buildWeirTools } from '../src/js/webmcp.js';
import { citeKey, formatItem } from '../src/js/cite.js';

const store = new Store(await VFS.create()); await store._hydrate();
await store.putFeed({ id: 'eg', name: 'Economic Geology', adapter: 'feed', url: 'http://eg/f' });
await store.upsertItems([
  { id: 'a1', feed_id: 'eg', type: 'paper', title: 'Principles of geostatistics', author: 'G. Matheron', url: 'https://doi.org/10.x', published_at: Date.parse('1963-01-01'), content: '<p>kriging is the best linear unbiased estimator (BLUE).</p>' },
  { id: 'a2', feed_id: 'eg', type: 'article', title: 'Itabirite notes', published_at: Date.parse('2026-05-02'), content: '<p>iron formation</p>' },   // no author
]);
// give a1 a glass card so the handle is a glass_id + wikilink resolution by glass_id works
await store.writeCard({ dublin_core: { title: 'Principles of geostatistics' }, facets: {}, glass: { glass_id: 'glass-19630101-001', document_ref: 'a1', related: [] } });

const t = buildWeirTools({ store });

// ── pure module: deterministic key + render ──
const f1 = formatItem(store.getItem('a1'), { feed: store.getFeed('eg'), card: store.cards.get('glass-19630101-001') });
assert.equal(citeKey(store.getItem('a1'), { feed: store.getFeed('eg') }), 'matheron1963', 'BibTeX-style key from lastname+year');
assert.match(f1.inline, /\(Matheron 1963\)/, 'inline (Author year)');
assert.match(f1.reference, /G\. Matheron\./, 'reference carries the author');
assert.match(f1.reference, /weir glass-19630101-001/, 'reference carries the durable weir handle');
assert.equal(f1.wikilink, '[[glass-19630101-001]]', 'wikilink uses the glass handle');
assert.equal(f1.csl.type, 'article-journal', 'CSL type mapped from item type');
assert.equal(f1.csl.author[0].literal, 'G. Matheron', 'CSL author');
assert.deepEqual(f1.missing, [], 'all essentials present → nothing missing');

// ── gap honesty: an item with no author reports it, never fabricates ──
const f2 = formatItem(store.getItem('a2'), { feed: store.getFeed('eg') });
assert.ok(f2.missing.includes('author'), 'missing author reported');
assert.match(f2.reference, /Itabirite notes/, 'still cites what is known (title)');
assert.ok(!/undefined|null/.test(f2.reference), 'no fabricated/garbage fields in the reference');

// ── tool single mode: verify-in (the quote IS in the source → cited + locator) ──
const ok = await t.cite({ id: 'a1', quote: 'kriging is the best linear unbiased estimator' });
assert.equal(ok.cited, true, 'a real quote verifies → cited:true');
assert.ok(ok.locator && ok.locator.startsWith('glass-19630101-001#'), 'locator embedded');
assert.match(ok.reference, /#\d+-\d+/, 'the reference splices in the verified locator');
assert.ok(ok.quote.toLowerCase().includes('kriging'), 'returns the verbatim cited span');

// ── verify-in REFUSES a quote that is not in the source (no citation for a fabrication) ──
const no = await t.cite({ id: 'a1', quote: 'kriging cures the common cold' });
assert.equal(no.cited, false, 'a quote not in the source → cited:false');
assert.ok(!no.reference, 'and no reference is rendered for it');

// ── batch mode: entries + stable cite-keys + an assembled bibliography ──
const batch = await t.cite({ ids: ['a1', 'a2', 'ghost'] });
assert.equal(batch.count, 2, 'two real items cited'); assert.deepEqual(batch.missing, ['ghost'], 'unknown id reported');
assert.equal(batch.keys.a1, 'matheron1963', 'keys map carries the cite-key');
assert.ok(batch.bibliography.includes('[^matheron1963]:'), 'footnote bibliography by default');
const numbered = await t.cite({ ids: ['a1', 'a2'], style: 'numbered' });
assert.match(numbered.bibliography, /^1\. /, 'numbered style');

// ── cite-key disambiguation within a batch (two same-anchor items → a/b) ──
await store.upsertItems([{ id: 'a3', feed_id: 'eg', type: 'paper', title: 'More geostatistics', author: 'G. Matheron', published_at: Date.parse('1963-06-01') }]);
const dup = await t.cite({ ids: ['a1', 'a3'] });
const keys = Object.values(dup.keys);
assert.equal(new Set(keys).size, 2, 'two Matheron-1963 items get distinct keys');
assert.ok(keys.includes('matheron1963') && keys.some((k) => /^matheron1963[a-z]$/.test(k)), 'collision disambiguated with a suffix');

// ── the [[handle]] wikilink resolves as a LIVE backlink once cited into a stacks note ──
await store.putFeed({ id: 'stacks', name: 'Stacks', adapter: 'stacks', url: '', next_poll_at: 8.64e15 });
await store.upsertItems([{ id: 'stacks:n1', feed_id: 'stacks', type: 'note', title: 'kriging brief', content: 'as shown ' + f1.wikilink }]);
store.getItem('stacks:n1').links = ['glass-19630101-001'];   // (writeNote extracts this; set directly here)
const wl = store.wikiLinksOf('a1');
assert.ok(wl.backlinks.some((b) => b.id === 'stacks:n1'), 'the cited item is back-linked from the note that cites its [[handle]]');

console.log('cite smoke ok:', JSON.stringify({ key: f1.key, batch: batch.count }));
