// The glass cataloger — a bounded LLM *service* (not an agent): one document in,
// one enriched catalog card out (GLASS.md §6). It fills the LANGUAGE facets the
// Stage-0 deterministic card can't (domain/entity/process/method/scale/spatial)
// + a real abstract, and leaves form/provenance/temporal (which weir knows) alone.
// Pure logic + an injected `chat`; orchestration over a store at the bottom.

import { chat } from './llm.js';
import { buildCard } from './glass.js';

export function stripToText(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').replace(/\s+/g, ' ').trim();
}

const LANGUAGE_FACETS = ['domain', 'entity', 'process', 'method', 'scale', 'spatial'];

export function catalogPrompt(item, card, body) {
  const system = 'You are a library cataloger using faceted classification, over a general feed of articles and videos. Read the document and return ONLY a JSON object with these keys — each an array of short, lowercase, GENERAL terms — plus a one-sentence "description":\n'
    + '- domain: the field(s) / subject area(s) it belongs to (e.g. gaming, technology, politics, cooking, science, finance)\n'
    + '- entity: the specific subjects, works, products, or concepts it is ABOUT (e.g. a game, a gadget, a person in the news, a topic). NEVER the author, channel, uploader, or show/series title — those are not entities.\n'
    + '- process: what is being done (e.g. review, analysis, tutorial, interview, announcement, commentary)\n'
    + '- method: notable techniques/approaches, only if salient — else []\n'
    + '- scale: scope, ONLY if clearly applicable — one of personal|local|national|global — else []\n'
    + '- spatial: real-world place names if any, else []\n'
    + '- description: one precise sentence summarizing it.\n'
    + 'Use [] for any facet not clearly supported by the text — never force a value (most items have no meaningful scale or spatial). Prefer concise, reusable canonical terms over near-synonyms (use "streaming", not also "live-stream"). Prefer reusing these already-known entity terms when they fit: ' + JSON.stringify(card.facets.entity || []) + '.';
  const user = `Title: ${item.title || '(untitled)'}\nKind: ${item.type}\nSource: ${card.dublin_core.source || ''}\n\n${String(body || '').slice(0, 6000)}`;
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

// Merge an LLM JSON response into the Stage-0 card. Robust to code fences / prose
// around the JSON. Returns { card, ok }.
export function parseCatalog(content, card) {
  const m = String(content).match(/\{[\s\S]*\}/);
  let obj; try { obj = JSON.parse(m ? m[0] : content); } catch { return { card, ok: false }; }
  const arr = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).toLowerCase().trim()).filter(Boolean))] : []);
  const facets = { ...card.facets };
  for (const f of ['domain', 'process', 'method', 'scale', 'spatial']) facets[f] = arr(obj[f]);
  facets.entity = [...new Set([...(card.facets.entity || []), ...arr(obj.entity)])];   // add to, never lose Stage-0 tags
  const dublin_core = { ...card.dublin_core };
  if (obj.description && String(obj.description).trim()) dublin_core.description = String(obj.description).trim();
  return { card: { ...card, dublin_core, facets, glass: { ...card.glass } }, ok: true };
}

// One cataloging call. Returns { card (enriched), usage, model, provider, ok }.
export async function catalogItem(opts = {}) {
  const { item, card, body } = opts;
  const messages = catalogPrompt(item, card, body);
  const { content, usage, model, provider } = await chat({
    provider: opts.provider, model: opts.model, key: opts.key, baseUrl: opts.baseUrl, fetch: opts.fetch,
    messages, temperature: opts.temperature ?? 0, json: true, maxTokens: opts.maxTokens || 400,
  });
  const { card: enriched, ok } = parseCatalog(content, card);
  enriched.glass = { ...enriched.glass, cataloger: `${provider}:${model}`, confidence: ok ? 0.7 : 0.2, needs_review: !ok };
  return { card: enriched, usage, model, provider, ok };
}

// Orchestrate over a store: read item + body + (Stage-0) card → catalog → persist
// the enriched card + record usage. `opts` carries provider/model/key/baseUrl/fetch.
export async function catalogStoreItem(store, id, opts = {}) {
  const item = store.getItem(id);
  if (!item) throw new Error(`no such item: ${id}`);
  const feed = store.getFeed(item.feed_id);
  let body = item.excerpt || '';
  if (item.has_content) { try { const html = await store.getContent(id); if (html) body = stripToText(html).slice(0, opts.maxBodyChars || 6000); } catch { /* excerpt only */ } }
  const base = (item.glass_id && await store.getCard(item.glass_id)) || buildCard(item, feed);
  const { card: enriched, usage, model, provider, ok } = await catalogItem({ ...opts, item, card: base, body });
  const glass_id = await store.writeCard(enriched);
  await store.recordUsage(provider, model, usage);
  return { glass_id, usage, ok, card: enriched };
}
