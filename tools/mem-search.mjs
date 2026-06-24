// Memory diagnostic (NOT a smoke — run by hand with --expose-gc):
//   node --expose-gc tools/mem-search.mjs [itemCount]
//
// Drives weir's store + search index + catalog churn headless and watches heapUsed
// AFTER a forced GC each cycle — to tell a real LEAK (monotonic after-GC growth) from a
// transient SPIKE (flat after GC, high peak during build). Localizes the OOM the librarian
// flagged (weir-OOM-flag) without a browser snapshot. Caveat: node heap ≠ browser heap, but
// leaks + relative peaks transfer; only a renderer/DOM-side leak would slip past.
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { SearchIndex } from '../src/js/search.js';
import { buildWeirTools } from '../src/js/webmcp.js';

const N = Number(process.argv[2]) || 12000;
const hasGc = typeof global.gc === 'function';
if (!hasGc) console.warn('⚠ run with `node --expose-gc` for after-GC numbers (else heap is noisy)\n');
const MB = (b) => (b / 1048576).toFixed(1);
const gc = () => { if (hasGc) { global.gc(); global.gc(); } };
const heapGc = () => { gc(); return process.memoryUsage().heapUsed; };
const trend = (arr) => arr[arr.length - 1] - arr[0];
const verdict = (label, series, leakMB = 5) => {
  const d = trend(series) / 1048576;
  console.log(`  trend over ${series.length} cycles: ${d >= 0 ? '+' : ''}${d.toFixed(1)} MB  → ${d > leakMB ? '⚠ LEAK-LIKE (after-GC growth)' : 'flat (no leak)'}`);
};

// ── synth a corpus near the real shape ──
const WORDS = 'kriging geostatistics variogram itabirite iron ore grade tonnage block model estimation drillhole declustering simulation copper gold mineral resource streaming worker protocol welford tdigest browser offline single file owned rented zero dependency catalog facet vocabulary'.split(' ');
const pick = (n, seed) => Array.from({ length: n }, (_, i) => WORDS[(seed * 7 + i * 13) % WORDS.length]).join(' ');
const store = new Store(await VFS.create()); await store._hydrate();
await store.putFeed({ id: 'f', name: 'Feed', adapter: 'feed', url: 'http://f' });
await store.putFeed({ id: 'repo:bma', name: 'bma (repo)', adapter: 'repo', url: '', next_poll_at: 8.64e15, config: { kind: 'repo' } });
console.log(`synthesizing ${N} items…`);
const batch = [];
for (let i = 0; i < N; i++) batch.push({ id: 'f:' + i, feed_id: 'f', type: 'article', title: pick(6, i), excerpt: pick(40, i + 1) });
await store.upsertItems(batch);

const si = new SearchIndex(store).build();
const QUERIES = ['kriging geostatistics', 'block model estimation', 'browser offline owned', 'itabirite grade tonnage', 'worker protocol streaming'];
console.log(`baseline (corpus + index, after GC): ${MB(heapGc())} MB\n`);

// ── Hypothesis #1: do doc BODIES bloat the index? (note claimed yes) ──
const REPO_DOCS = Math.min(80, N);
const body = pick(1, 0).repeat(1) + ' ' + Array.from({ length: 1200 }, (_, i) => WORDS[i % WORDS.length]).join(' ');   // ~8 KB body
const beforeBodies = heapGc();
const docs = [];
for (let i = 0; i < REPO_DOCS; i++) docs.push({ id: 'repo:bma:' + i, feed_id: 'repo:bma', type: 'doc', title: 'doc ' + i, excerpt: pick(40, i), content: body });
await store.upsertItems(docs);
si.build();
const afterBodies = heapGc();
console.log(`#1 bodies-in-index: added ${REPO_DOCS} docs with ~8 KB bodies + rebuilt → index heap Δ ${MB(afterBodies - beforeBodies)} MB`);
console.log(`   (index uses it.excerpt, folded/positions-off — so bodies should NOT bloat it; large Δ here would refute that)\n`);

// ── Rebuild-churn LEAK test (the heavy-session pattern: repeated full rebuilds) ──
console.log('rebuild churn (full index rebuild ×12):');
const rb = [];
for (let c = 0; c < 12; c++) { si.build(); rb.push(heapGc()); if (c % 3 === 0) console.log(`  cycle ${c}: ${MB(rb[c])} MB`); }
verdict('rebuild', rb);

// ── Rebuild PEAK + the mitigation A/B (free old index before building) ──
gc(); const base = process.memoryUsage().heapUsed;
si.build(); const peakNaive = process.memoryUsage().heapUsed;            // old index still referenced during build
si.index = null; gc(); si.build(); const peakFreed = process.memoryUsage().heapUsed;   // free-first mitigation
console.log(`\nrebuild peak (pre-GC, over baseline ${MB(base)}):`);
console.log(`  naive (old index live during build): +${MB(peakNaive - base)} MB`);
console.log(`  free-first (this.index=null first):  +${MB(peakFreed - base)} MB  ← mitigation effect\n`);

// ── Search-churn LEAK test (engine: fuzzy + folded scoring) ──
console.log('search churn (×500):');
const sr = [];
for (let c = 0; c < 10; c++) { for (let k = 0; k < 50; k++) si.search(QUERIES[k % QUERIES.length]); sr.push(heapGc()); }
verdict('search', sr);

// ── weir_search FULL path LEAK test (rerank + vocab expansion + facet-match) ──
// The librarian hammered this exact path; the engine test above is raw SearchIndex.search.
store.recordSynonym('entity', 'kriging', 'krigagem'); store.recordSynonym('entity', 'geostatistics', 'geoestatística');
const tools = buildWeirTools({ store, app: { searchIndex: si } });
console.log('\nweir_search full path (rerank+expand, ×500):');
const wr = [];
for (let c = 0; c < 10; c++) { for (let k = 0; k < 50; k++) await tools.search({ q: QUERIES[k % QUERIES.length], explain: true }); wr.push(heapGc()); }
verdict('weir_search', wr);

// ── Recatalog-churn LEAK test (Stage-0 buildCatalog + uncatalogScope, no LLM) ──
console.log('\nrecatalog churn (buildCatalog + uncatalogScope ×8):');
const rc = [];
for (let c = 0; c < 8; c++) { await store.buildCatalog({ overwrite: true, cataloged: '2026-06-2' + c }); await store.uncatalogScope({ feed_id: 'repo:bma' }); rc.push(heapGc()); }
verdict('recatalog', rc);

console.log(`\nfinal heap (after GC): ${MB(heapGc())} MB   ·   rss ${MB(process.memoryUsage().rss)} MB`);
console.log('done — monotonic after-GC growth in any phase = a real leak to bisect; flat = transient spike (mitigations + browser snapshot).');
