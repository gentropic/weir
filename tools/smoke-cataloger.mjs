// Glass Stage-1 cataloger + LLM client tests (mock fetch, NO network).
// Run: node tools/smoke-cataloger.mjs
import assert from 'node:assert';
import { chat, fetchUsageGauge, inputMultiplier, listModels } from '../src/js/llm.js';
import { catalogPrompt, parseCatalog, catalogStoreItem, stripToText } from '../src/js/cataloger.js';
import { buildCard } from '../src/js/glass.js';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';

// A mock LLM endpoint: returns the cataloger JSON as the message content.
const CARD_JSON = JSON.stringify({
  domain: ['geostatistics', 'mining'], entity: ['kriging', 'itabirite'], process: ['estimation'],
  method: ['ordinary-kriging'], scale: ['deposit'], spatial: ['Quadrilátero Ferrífero'],
  description: 'Compares OK and SK estimators for iron grade.',
});
const llmFetch = async () => ({
  ok: true,
  async json() { return { model: 'kimi-k2.6', choices: [{ message: { content: '```json\n' + CARD_JSON + '\n```' } }], usage: { prompt_tokens: 1200, completion_tokens: 80, total_tokens: 1280 } }; },
  async text() { return ''; },
});

// ── chat(): OpenAI shape → content + usage ──
const r = await chat({ provider: 'nanogpt', model: 'kimi-k2.6', key: 'x', messages: [{ role: 'user', content: 'hi' }], json: true, fetch: llmFetch });
assert.match(r.content, /geostatistics/, 'content returned');
assert.equal(r.usage.prompt_tokens, 1200, 'usage captured');
assert.equal(r.model, 'kimi-k2.6');

// ── inputMultiplier: nano-gpt 2x models ──
assert.equal(inputMultiplier('nanogpt', 'glm-5.1'), 2, 'GLM 5.1 ×2');
assert.equal(inputMultiplier('nanogpt', 'deepseek-v4-pro'), 2);
assert.equal(inputMultiplier('nanogpt', 'kimi-k2.6'), 1, 'normal model ×1');
assert.equal(inputMultiplier('groq', 'glm-5.1'), 1, 'multiplier only for nanogpt');

// ── fetchUsageGauge: defensive parse (docs disagree) ──
const gWeekly = await fetchUsageGauge('nanogpt', 'k', { fetch: async () => ({ ok: true, async json() { return { usage: { weeklyInputTokens: { used: 15000, remaining: 59985000, percentUsed: 0.025, resetAt: 1 } } }; } }) });
assert.equal(gWeekly.kind, 'weeklyInputTokens'); assert.equal(gWeekly.used, 15000);
const gDaily = await fetchUsageGauge('nanogpt', 'k', { fetch: async () => ({ ok: true, async json() { return { daily: { used: 5, remaining: 1995 } }; } }) });
assert.equal(gDaily.kind, 'daily', 'falls back to daily shape');
assert.equal(await fetchUsageGauge('groq', 'k', { fetch: async () => ({}) }), null, 'no gauge for providers without usagePath');

// ── listModels: parse /models shapes, derive URL, error on HTTP fail ──
const mkModels = (body) => async () => ({ ok: true, async json() { return body; }, async text() { return ''; } });
assert.deepEqual(await listModels({ provider: 'lemonade', fetch: mkModels({ data: [{ id: 'qwen3-it-4b-FLM' }, { id: 'llama3.1-8b-FLM' }] }) }), ['qwen3-it-4b-FLM', 'llama3.1-8b-FLM'], 'OpenAI data[].id');
assert.deepEqual(await listModels({ provider: 'ollama', fetch: mkModels({ models: [{ name: 'qwen2.5:7b' }] }) }), ['qwen2.5:7b'], 'ollama models[].name');
let listedUrl = '';
await listModels({ provider: 'lemonade', fetch: async (u) => { listedUrl = u; return mkModels({ data: [] })(); } });
assert.equal(listedUrl, 'http://localhost:13305/api/v1/models', 'derives /models from chat path');
await assert.rejects(listModels({ provider: 'groq', key: 'k', fetch: async () => ({ ok: false, status: 401 }) }), /models 401/, 'throws on HTTP error');

// ── parseCatalog: merge, keep Stage-0 entity, tolerate fences ──
const stage0 = buildCard({ id: 'i', feed_id: 'f', type: 'paper', title: 'T', tags: ['kriging'] }, { name: 'F', adapter: 'feed' }, { glass_id: 'glass-20260404-001', cataloged: '2026-04-04' });
const { card: merged, ok } = parseCatalog('here you go:\n' + CARD_JSON, stage0);
assert.equal(ok, true);
assert.deepEqual(merged.facets.domain, ['geostatistics', 'mining'], 'language facet filled');
assert.ok(merged.facets.entity.includes('kriging') && merged.facets.entity.includes('itabirite'), 'entity = stage0 tags + LLM');
assert.deepEqual(merged.facets.form, ['paper'], 'Stage-0 form preserved');
assert.match(merged.dublin_core.description, /OK and SK/);
assert.deepEqual(parseCatalog('not json at all', stage0).card.facets.domain, [], 'bad JSON → unchanged + ok:false');
assert.equal(parseCatalog('nope', stage0).ok, false);

assert.equal(stripToText('<p>Hello <b>world</b></p>'), 'Hello world', 'strip html');

// ── catalogStoreItem: end-to-end over a store (mock LLM) ──
const store = new Store(await VFS.create()); await store._hydrate();
await store.putFeed({ id: 'f', name: 'arXiv', adapter: 'feed', url: 'http://a/f' });
await store.upsertItems([{ id: 'p1', feed_id: 'f', type: 'paper', title: 'OK vs SK', tags: ['kriging'], content: '<p>full text here</p>' }]);
const res = await catalogStoreItem(store, 'p1', { provider: 'nanogpt', model: 'kimi-k2.6', key: 'x', fetch: llmFetch });
assert.ok(res.glass_id, 'cataloged → glass_id');
assert.equal(store.getItem('p1').glass_id, res.glass_id, 'item stamped');
const card = await store.getCard(res.glass_id);
assert.deepEqual(card.facets.domain, ['geostatistics', 'mining'], 'enriched card persisted');
assert.ok(card.facets.entity.includes('itabirite'), 'LLM entity added');
assert.equal(card.glass.cataloger, 'nanogpt:kimi-k2.6');
assert.equal(card.glass.needs_review, false, 'good parse → no review');

// usage ledger
const u = await store.getUsage();
assert.equal(u.providers.nanogpt.input_tokens, 1200, 'input tokens recorded');
assert.equal(u.providers.nanogpt.billed_input, 1200, 'billed input (kimi ×1)');
await store.recordUsage('nanogpt', 'glm-5.1', { prompt_tokens: 1000 });
assert.equal((await store.getUsage()).providers.nanogpt.billed_input, 1200 + 2000, 'glm-5.1 billed ×2');

// ── regression: two un-cataloged items get DISTINCT cards (no seq-001 collision) ──
// buildCard used to fabricate glass-…-001 for every item, so a second catalog
// overwrote the first's card and cross-contaminated facets. Each must self-file.
await store.upsertItems([{ id: 'p2', feed_id: 'f', type: 'paper', title: 'Variograms', tags: ['variogram'], content: '<p>full text</p>' }]);
const res2 = await catalogStoreItem(store, 'p2', { provider: 'nanogpt', model: 'kimi-k2.6', key: 'x', fetch: llmFetch });
assert.notEqual(res2.glass_id, res.glass_id, 'second item gets its OWN glass_id (no collision)');
assert.equal(store.getItem('p2').glass_id, res2.glass_id, 'p2 stamped with its own id');
assert.equal((await store.getCard(res2.glass_id)).glass.document_ref, 'p2', 'card2 → p2');
assert.equal((await store.getCard(res.glass_id)).glass.document_ref, 'p1', 'p1 card intact after p2 cataloged');

// ── clearCatalog: wipes cards + un-stamps items (corruption cleanup) ──
const before = await store.catalogCount(); assert.ok(before >= 2, 'cards exist before clear');
const cl = await store.clearCatalog();
assert.equal(cl.cleared, before, 'all cards deleted');
assert.equal(await store.catalogCount(), 0, 'catalog empty');
assert.equal(store.getItem('p1').glass_id, undefined, 'p1 un-stamped');
assert.equal(store.getItem('p2').glass_id, undefined, 'p2 un-stamped');

console.log('cataloger smoke ok:', JSON.stringify({ glass_id: res.glass_id, second: res2.glass_id, domain: card.facets.domain.length }));
