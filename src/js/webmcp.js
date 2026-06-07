// webmcp.js — weir's WebMCP adapter. Registers weir's domain tools on the
// shim-polyfilled navigator.modelContext (vendor/webmcp-shim.js) and manages the
// localhost bridge connection (@gcu/webmcp, repo gentropic/webmcp).
//
// v0.1 is READ-ONLY — queryItems / getItem / listFacets. Mutations (mark read,
// trigger a catalog) come later, behind confirmation. Tool implementations live
// in buildWeirTools() (pure over a store, so testable without a browser); the
// registration + bridge connection live in initWebmcp() (browser-only).
//
// Transport: on a public origin (gentropic.org/weir, the PWA) ws://localhost is
// gated by Chromium's Local/Private Network Access, so we inject gcuFetch — the
// shim then routes its HTTP long-poll transport through the @gcu/bridge extension,
// exactly like weir's LLM client reaches Lemonade. (See gentropic/webmcp SPEC §4.1.)

import { stripToText } from './cataloger.js';
import { facetsOf, FACETS } from './glass.js';
import { listModels } from './llm.js';
import { getKey } from './llmkeys.js';

const LS_KEY = 'weir-webmcp';      // localStorage "port:token" (socket transport) — origin-scoped (no cross-origin read)
// fs-transport machine token. NOTE: this is a CLUSTER-shared secret (the same token
// authorizes every machine syncing the folder), and localStorage CAN ride a browser
// profile backup/sync — so its blast radius is wider than LS_KEY's loopback gate.
// Mitigations are scope-the-cluster-tightly + the bridge's --allow capability gate
// (webmcp TRANSPORTS §4.1). The folder handle itself persists via fsmount key 'webmcp-fs'.
const LS_FS = 'weir-webmcp-fs';

// Compact projection for tool output — never dump whole records at the model.
function projItem(store, it, full) {
  const feed = store.getFeed(it.feed_id);
  const o = {
    id: it.id, type: it.type, title: it.title || '(untitled)', url: it.url || undefined,
    feed: (feed && feed.name) || it.feed_id,
    author: it.author || undefined,
    published: it.published_at ? new Date(it.published_at).toISOString() : undefined,
    read: !!it.read, saved: !!it.saved,
    tags: (it.tags && it.tags.length) ? it.tags : undefined,
  };
  if (full) {
    o.archived = !!it.archived; o.route = it.route || undefined; o.glass_id = it.glass_id || undefined;
    o.excerpt = it.excerpt || undefined;
  } else if (it.excerpt) {
    o.excerpt = it.excerpt.length > 280 ? it.excerpt.slice(0, 280) + '…' : it.excerpt;
  }
  return o;
}

// Opaque keyset cursor over (published_at, id) — stable while weir keeps polling
// (new items sort above the cursor and aren't re-served), unlike a numeric offset.
function encCursor(pa, id) {
  const json = JSON.stringify({ pa: pa || 0, id });
  try { return btoa(unescape(encodeURIComponent(json))); } catch { return btoa(json); }
}
function decCursor(s) {
  try { const o = JSON.parse(decodeURIComponent(escape(atob(String(s))))); if (o && typeof o.id === 'string') return { pa: o.pa || 0, id: o.id }; } catch { /* bad cursor */ }
  return null;
}

// Tool implementations over a store. `cardFacets` (optional) returns the app's
// live item→facets cache (enriched, when catalog cards are loaded); `ensureCards`
// (optional) warms it. Without them, facets fall back to deterministic Stage-0.
export function buildWeirTools({ store, cardFacets, ensureCards, app } = {}) {
  const facetsFor = (it) => {
    const live = cardFacets && cardFacets();
    return (live && live.get(it.id)) || facetsOf(it, store.getFeed(it.feed_id));
  };

  // Resolve a `feed` arg (a feed id OR a display name, case-insensitive) to a
  // feed_id, so the model can say feed:"Saved Links" without knowing the id.
  function resolveFeedId(feed) {
    if (!feed) return undefined;
    const s = String(feed);
    if (store.getFeed(s)) return s;
    const lc = s.toLowerCase();
    const hit = store.listFeeds().find((f) => (f.name || '').toLowerCase() === lc);
    return hit ? hit.id : s;   // fall back to the raw value (yields an empty set if unknown)
  }

  // Shared query builder — maps the tool args (q/feed/category/type/view/unread/
  // saved) to store.query opts. Reused by queryItems + the bulk path of `tag` so a
  // bulk tag scopes exactly like a list.
  function buildQuery(input = {}) {
    const opts = {};
    if (input.q) opts.text = String(input.q);
    if (input.type) opts.type = String(input.type);
    if (input.view) opts.view = String(input.view);
    if (input.feed) opts.feed_id = resolveFeedId(input.feed);
    if (input.category !== undefined) opts.category = String(input.category);   // '' = ungrouped
    if (input.unread === true) opts.read = false;
    if (input.saved !== undefined) opts.saved = !!input.saved;
    return opts;
  }

  async function queryItems(input = {}) {
    const { cursor } = input;
    const limit = Math.min(Math.max(1, Number(input.limit) || 30), 100);
    const opts = buildQuery(input);   // no limit → full matching set; paged here with a keyset cursor
    // Stable total order: newest first, id as tie-breaker (so the cursor is exact
    // even when timestamps collide). Re-sort explicitly — don't rely on Map order.
    const pa = (r) => r.published_at || 0;
    const cmp = (a, b) => (pa(b) - pa(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const rows = store.query(opts).sort(cmp);
    let start = 0;
    if (cursor) {
      const c = decCursor(cursor);
      if (c) { const i = rows.findIndex((r) => cmp({ published_at: c.pa, id: c.id }, r) < 0); start = i < 0 ? rows.length : i; }
    }
    const page = rows.slice(start, start + limit);
    const hasMore = start + page.length < rows.length;
    const out = { count: page.length, total: rows.length, hasMore, items: page.map((r) => projItem(store, r, false)) };
    if (hasMore && page.length) { const last = page[page.length - 1]; out.nextCursor = encCursor(pa(last), last.id); }
    return out;
  }

  // Resolve a [[ref]] (a stacks uid, a glass-id, or a full item id) to an item.
  function resolveRef(ref) {
    const r = String(ref || '').trim(); if (!r) return null;
    const direct = store.getItem(r); if (direct) return direct;
    for (const it of store.items.values()) if (it.uid === r || it.glass_id === r) return it;
    return null;
  }
  // Items whose body links to `item` (via its uid/glass_id/id) — the backlink set.
  function backlinksOf(item) {
    const refs = new Set([item.uid, item.glass_id, item.id].filter(Boolean));
    const out = [];
    for (const other of store.items.values()) {
      if (other.id === item.id || !other.links || !other.links.length) continue;
      if (other.links.some((l) => refs.has(String(l).trim()))) out.push({ id: other.id, title: other.title || other.path || other.id });
    }
    return out;
  }

  async function getItem(input = {}) {
    const id = input && input.id;
    const it = id != null && store.getItem(String(id));
    if (!it) throw new Error(`No item with id "${id}". Use weir_queryItems to find ids.`);
    const o = projItem(store, it, true);
    if (it.glass_id) {
      try {
        const c = await store.getCard(it.glass_id);
        if (c) { o.facets = c.facets; if (c.dublin_core && c.dublin_core.description) o.description = c.dublin_core.description; }
      } catch { /* card unreadable */ }
    }
    if (input.content && it.has_content) {
      try { const html = await store.getContent(it.id); if (html) o.content_text = stripToText(html).slice(0, 8000); } catch { /* content unreadable */ }
    }
    // Knowledge graph: what this item links to ([[ref]] → resolved target) + what links
    // to it. Both capped so a hub item can't blow the result budget.
    if (Array.isArray(it.links) && it.links.length) {
      o.links = it.links.slice(0, 50).map((ref) => { const t = resolveRef(ref); return t ? { ref, id: t.id, title: t.title || t.id } : { ref, unresolved: true }; });
      if (it.links.length > 50) o.linksOmitted = it.links.length - 50;
    }
    const back = backlinksOf(it);
    if (back.length) { o.backlinks = back.slice(0, 50); if (back.length > 50) o.backlinksOmitted = back.length - 50; }
    return o;
  }

  async function listFacets(input = {}) {
    if (ensureCards) { try { await ensureCards(); } catch { /* fall back to Stage-0 */ } }
    const only = input.facet ? String(input.facet) : null;     // drill into one facet
    const per = Math.min(Math.max(1, Number(input.limit) || 25), 200);   // top-N terms per facet
    const minCount = Math.max(1, Number(input.minCount) || 1);
    const idx = {};
    for (const it of store.items.values()) {
      if (it.archived) continue;
      const f = facetsFor(it);
      for (const facet of FACETS) {
        if (only && facet !== only) continue;
        const vals = f[facet]; if (!vals || !vals.length) continue;
        const m = idx[facet] || (idx[facet] = new Map());
        for (const term of vals) m.set(term, (m.get(term) || 0) + 1);
      }
    }
    // Bounded output: top `per` terms per facet by count, with total/omitted —
    // the entity facet alone can be thousands of terms on a real corpus.
    const out = {};
    for (const facet of FACETS) {
      const m = idx[facet]; if (!m) continue;
      const all = [...m].map(([term, count]) => ({ term, count })).filter((t) => t.count >= minCount).sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
      if (!all.length) continue;
      const top = all.slice(0, per);
      out[facet] = { total: all.length, terms: top };
      if (all.length > top.length) out[facet].omitted = all.length - top.length;
    }
    return out;
  }

  // ── mutations (the user opted into wide access for their own local data) ──

  // Set item flags — on ONE item (`id`) or every item matching a query (the bulk
  // path, same `scope via params` pattern as `tag`). All reversible — weir's
  // "archived" archives, never deletes; unarchiveAll reverses an over-eager sweep.
  async function setState(input = {}) {
    const patch = {};
    if (input.read !== undefined) patch.read = !!input.read;
    if (input.saved !== undefined) patch.saved = !!input.saved;
    if (input.archived !== undefined) patch.archived = !!input.archived;
    if (!Object.keys(patch).length) throw new Error('Provide at least one of: read, saved, archived.');
    if (input.id != null) {
      const it = store.getItem(String(input.id));
      if (!it) throw new Error(`No item with id "${input.id}".`);
      store.setState(it.id, patch);
      if (app && app.renderStream) app.renderStream();
      return projItem(store, store.getItem(it.id), true);
    }
    // bulk over a query — require a scoping filter so a whole-corpus mutation is never
    // accidental. `saved` here is the ACTION, not a scope, so drop it from the query.
    const scope = buildQuery(input); delete scope.saved;
    if (!Object.keys(scope).length) throw new Error('Provide `id`, or query filters (q/feed/category/type/view/unread) to scope a bulk change.');
    const ids = store.query(scope).map((r) => r.id);
    for (const id of ids) store.setState(id, patch);
    await store.flush();
    if (app && app.renderAll) app.renderAll();
    return { matched: ids.length, patch };
  }

  // One tagging verb, two scopes (the "scope via params, not a second tool" pattern):
  // pass `id` to tag ONE item, or query filters to bulk-tag every match. Tags are
  // stamped source:'llm' (UI shows them apart from 'human' tags); searchable +
  // queryable immediately; feed the glass `entity` facet on the next catalog.
  async function tag(input = {}) {
    const add = [].concat(input.add || []).filter(Boolean);
    const remove = [].concat(input.remove || []).filter(Boolean);
    if (!add.length && !remove.length) throw new Error('Provide tags to add and/or remove.');
    if (input.id != null) {   // single item
      const it = store.getItem(String(input.id));
      if (!it) throw new Error(`No item with id "${input.id}".`);
      for (const t of add) store.addTag(it.id, t, 'llm');
      for (const t of remove) store.removeTag(it.id, t);
      await store.flush();
      if (app && app.renderStream) app.renderStream();
      return projItem(store, store.getItem(it.id), true);
    }
    // bulk over a query (same scope args as queryItems)
    const ids = store.query(buildQuery(input)).map((r) => r.id);
    if (!ids.length) return { matched: 0, changed: 0, add, remove };
    const changed = add.length ? store.addTagBulk(ids, add, 'llm') : 0;
    for (const id of ids) for (const t of remove) store.removeTag(id, t);
    await store.flush();
    if (app && app.renderStream) app.renderStream();
    return { matched: ids.length, changed, add, remove };
  }

  // Bring every archived item back to active (+ clear expiry so retention can't
  // re-shelve them). One-shot "I keep everything" restore. Reversible; no deletes.
  async function unarchiveAll() {
    const n = store.unarchiveAll();
    await store.flush();
    if (app && app.renderAll) app.renderAll();
    return { unarchived: n };
  }

  // Catalog one item with the configured LLM now → returns its enriched facets.
  async function catalogItem(input = {}) {
    if (!app || !app.catalogItem) throw new Error('cataloging is only available in the running app');
    const it = input.id != null && store.getItem(String(input.id));
    if (!it) throw new Error(`No item with id "${input.id}".`);
    const r = await app.catalogItem(it.id);
    if (!r) throw new Error('catalog failed — is the cataloger configured and Lemonade/the bridge reachable?');
    const fresh = store.getItem(it.id);
    let facets = r.card && r.card.facets, description;
    if (fresh.glass_id) { try { const c = await store.getCard(fresh.glass_id); if (c) { facets = c.facets; description = c.dublin_core && c.dublin_core.description; } } catch { /* card unreadable */ } }
    return { glass_id: fresh.glass_id, ok: r.ok !== false, facets, description };
  }

  // Start / stop / inspect the background catalog batch.
  async function catalogControl(input = {}) {
    if (!app) throw new Error('cataloging is only available in the running app');
    const action = (input.action || 'status');
    if (action === 'start') {
      // Optional scope narrows the run to one feed / folder / type; absent → whole corpus.
      const scope = {};
      if (input.feed) scope.feed_id = resolveFeedId(input.feed);
      if (input.category !== undefined) scope.category = String(input.category);
      if (input.type) scope.type = String(input.type);
      const scoped = scope.feed_id || scope.category !== undefined || scope.type;
      if (input.recatalog && scoped && app.recatalogScope) return app.recatalogScope(scope);   // discard the scope's cards first, then re-catalog
      return scoped && app.catalogScope ? app.catalogScope(scope) : app.catalogAll();
    }
    if (action === 'stop') return { stopped: app.stopCatalog() };
    if (action === 'clear') {
      // Discard all cards + un-file every item (items/content/reading state kept),
      // so a fresh pass starts clean. No confirm dialog (that's the UI's job) —
      // gated only by the caller asking. Stops any running batch first.
      if (app.stopCatalog) app.stopCatalog();
      const r = await store.clearCatalog();
      app._cardFacets = new Map();
      if (app.catalog && app.renderAll) app.renderAll();
      if (app.renderCatUsage) app.renderCatUsage();
      return { cleared: r.cleared };
    }
    if (action === 'status') {
      const st = app.catalogStatus ? app.catalogStatus() : { running: false };
      return { ...st, cataloged: await store.catalogCount(), total: store.items.size };
    }
    throw new Error('action must be one of: start | stop | clear | status');
  }

  // List cataloger cards flagged low-confidence (needs_review) for human confirm.
  async function reviewQueue(input = {}) {
    if (!app) throw new Error('review is only available in the running app');
    if (ensureCards) { try { await ensureCards(); } catch { /* fall through */ } }
    const limit = Math.min(Math.max(1, Number(input.limit) || 30), 100);
    const cr = app._cardReview || new Map();
    const items = []; let total = 0;
    for (const [id, r] of cr) {
      if (!r || !r.needs_review) continue;
      total++;
      if (items.length >= limit) continue;
      const it = store.getItem(id); if (!it) continue;
      const o = projItem(store, it, false);
      o.confidence = r.confidence;
      const f = app._cardFacets && app._cardFacets.get(id); if (f) o.facets = f;
      items.push(o);
    }
    return { total, count: items.length, items };
  }

  // Confirm a card (clear needs_review) and optionally correct its facets.
  async function reviewItem(input = {}) {
    if (!app) throw new Error('review is only available in the running app');
    const it = input.id != null && store.getItem(String(input.id));
    if (!it) throw new Error(`No item with id "${input.id}".`);
    if (!it.glass_id) throw new Error(`Item "${input.id}" isn't cataloged yet.`);
    const card = await store.markCardReviewed(it.glass_id, { facets: input.facets });
    if (app._cardReview && app._cardReview.get(it.id)) app._cardReview.get(it.id).needs_review = false;
    if (input.facets && app._cardFacets) app._cardFacets.set(it.id, card.facets);
    if (app.renderReviewStatus) app.renderReviewStatus();
    return { glass_id: it.glass_id, reviewed: true, facets: card.facets };
  }

  // Thesaurus normalization: rewrite a facet term across the WHOLE catalog —
  // `from` → `to` within one facet (de-duped). The vocabulary-level edit that
  // makes facet-browsing coherent (merge `usa`→`united states`, `ai`→`artificial
  // intelligence`; an empty/omitted `to` DROPS the term — collapse a junk
  // singleton). Accepts one {facet, from, to} or a {merges:[…]} batch applied in
  // one atomic flush. Use weir_listFacets to spot variants first. Returns each
  // merge's card-change count.
  async function mergeFacetTerm(input = {}) {
    const list = Array.isArray(input.merges) ? input.merges
      : (input.facet != null && input.from != null) ? [{ facet: input.facet, from: input.from, to: input.to }]
        : null;
    if (!list || !list.length) throw new Error('pass {facet, from, to} (to omitted/empty = drop the term) or {merges:[…]}');
    const results = [];
    let cardsChanged = 0;
    for (const m of list) {
      if (m == null || m.facet == null || m.from == null) throw new Error('each merge needs a facet and a from-term');
      const cards = store.mergeFacetTerm(String(m.facet), String(m.from), m.to == null ? '' : String(m.to));
      results.push({ facet: String(m.facet), from: String(m.from), to: m.to == null ? '' : String(m.to), cards });
      cardsChanged += cards;
    }
    await store.flush();   // cards and/or the vocabulary (recorded altLabels) may have changed
    if (app && app.renderAll) app.renderAll();
    return { merges: results, cardsChanged };
  }

  // Inspect the controlled vocabulary / thesaurus (SKOS, GLASS §7): a per-facet
  // concept-count overview (no args), one facet's concepts (`facet`), one term's
  // concept (`facet`+`term` → prefLabel + altLabels/UF + broader/narrower/related),
  // or SKOS JSON-LD (`export:true`). The vocabulary is GROWN by curation —
  // weir_mergeFacetTerm records synonyms (altLabel), weir_relateTerm declares BT/NT/RT.
  async function vocab(input = {}) {
    const facet = input.facet != null ? String(input.facet) : null;
    if (input.export) return store.vocabExportSkos(facet || undefined);
    if (facet && input.term != null) {
      return { facet, term: String(input.term).toLowerCase().trim(), concept: store.getConcept(facet, String(input.term)) };
    }
    if (facet) {
      const v = store.getVocab(facet); const terms = Object.keys(v);
      return { facet, concepts: terms.length, terms: terms.slice(0, 200).map((t) => ({ term: t, ...v[t] })), omitted: Math.max(0, terms.length - 200) };
    }
    return { facets: Object.fromEntries(Object.keys(store.vocab).map((f) => [f, Object.keys(store.vocab[f]).length])) };
  }

  // Declare typed thesaurus relations (SKOS, GLASS §7) on a term: broader (BT),
  // narrower (NT), related (RT), or alt (a synonym that redirects to this term).
  // Inverses are maintained automatically (set broader → the target gains narrower).
  // Each value is a string or list. The ratified way to grow hierarchy — a
  // similarity signal may *propose*, but a relation exists only once declared here.
  async function relateTerm(input = {}) {
    if (input.facet == null || input.term == null) throw new Error('pass facet, term, and at least one of broader/narrower/related/alt');
    // Coerce: a relation value may arrive as a list, a single term, or — depending on
    // the MCP transport — a JSON-stringified array. Normalize all three to an array.
    const coerce = (x) => {
      if (Array.isArray(x)) return x;
      if (typeof x === 'string') { const t = x.trim(); if (t[0] === '[') { try { const p = JSON.parse(t); if (Array.isArray(p)) return p; } catch { /* not JSON */ } } return [x]; }
      return x == null ? [] : [x];
    };
    let touched = 0;
    for (const rel of ['broader', 'narrower', 'related', 'alt']) {
      if (input[rel] == null) continue;
      store.setVocabRelation(String(input.facet), String(input.term), rel, coerce(input[rel])); touched++;
    }
    if (!touched) throw new Error('pass at least one of broader / narrower / related / alt');
    await store.flush();
    return { facet: String(input.facet), term: String(input.term).toLowerCase().trim(), concept: store.getConcept(String(input.facet), String(input.term)) };
  }

  // ── the knowledge graph: typed `related` edges between items (GLASS §10) ──
  // Resolve an item id OR glass_id to a card's glass_id (errors if uncataloged);
  // map a glass_id back to its item id for projection.
  function toGlassId(idOrGlass) {
    const s = String(idOrGlass || '');
    if (s && store.cards.get(s)) return s;            // already a glass_id
    const it = store.getItem(s);
    if (it && it.glass_id) return it.glass_id;
    throw new Error(`"${idOrGlass}" has no catalog card yet — catalog it first (or pass a glass_id).`);
  }
  const itemRefOf = (gid) => { const c = store.cards.get(gid); return (c && c.glass && c.glass.document_ref) || gid; };

  // Read the graph around an item: ratified edges (outgoing + backlinks) + on-demand
  // facet-overlap SUGGESTIONS to ratify (each with the shared terms = the "why").
  async function relatedTo(input = {}) {
    const gid = toGlassId(input.id);
    const r = store.relatedOf(gid);
    const proj = (e) => ({ id: itemRefOf(e.glass_id), title: e.title, type: e.type, source: e.source });
    const out = { id: String(input.id), outgoing: r.outgoing.map(proj), backlinks: r.backlinks.map(proj) };
    if (input.suggest !== false) {
      const limit = Math.min(Math.max(1, Number(input.limit) || 8), 25);
      out.suggested = store.proposeRelated(gid, { limit }).map((p) => ({ id: itemRefOf(p.glass_id), title: p.title, score: p.score, shared: p.shared }));
    }
    return out;
  }

  // Ratify (or remove) a typed edge between two items — the decides-vs-proposes gate
  // (GLASS §2.1): a suggestion is only an edge once declared here. type ∈ RELATION_TYPES.
  async function relate(input = {}) {
    const from = toGlassId(input.from), to = toGlassId(input.to);
    if (input.remove) {
      const removed = store.unrelateCards(from, to, input.type ? { type: String(input.type) } : {});
      await store.flush();
      return { removed, from: String(input.from), to: String(input.to) };
    }
    const edge = store.relateCards(from, to, { type: input.type || 'related', source: 'claude' });
    await store.flush();
    return { related: true, from: String(input.from), to: String(input.to), type: edge.type };
  }

  // Inspect (and optionally rebuild) FRBR work-grouping (GLASS §4.1): items that are
  // the same Work across manifestations (wire-syndication, re-uploads). `regroup:true`
  // runs the deterministic pass (canonical-URL + SimHash near-dup — NOT an LLM call)
  // then reports; default reports the current grouping. Returns { stats, works } —
  // the biggest multi-source clusters with member titles+feeds, to eyeball precision
  // before any inbox-collapsing UI rides on it. Grouping is a reversible overlay;
  // nothing is deleted.
  async function works(input = {}) {
    let stats = null;
    if (input.regroup) stats = await store.regroupWorks(input.maxHamming != null ? { maxHamming: Number(input.maxHamming) } : {});
    const list = store.listWorks(Math.min(Number(input.limit) || 20, 100));
    if (input.regroup && app && app.renderAll) app.renderAll();
    return { ...(stats ? { stats } : {}), count: list.length, works: list };
  }

  // List the catalog provider's available models (so Claude can pick one). Named
  // distinctly from the imported llm `listModels` — a local `listModels` would
  // shadow it (and the build strips import aliases, so it can't be aliased).
  async function listProviderModels(input = {}) {
    if (!app) throw new Error('listModels is only available in the running app');
    const provider = input.provider || store.getSettings().catalog_provider || 'ollama';
    const models = await listModels({ provider, key: await getKey(provider), baseUrl: store.getSettings().catalog_base_url, fetch: app.poller && app.poller.fetch });
    return { provider, count: models.length, models };
  }

  // Set cataloger config: provider / model / baseUrl / paceMs / maxBodyChars.
  // Deliberately NOT the API key — that stays the user's UI paste into the OPFS
  // vault. Takes effect on the NEXT cataloged item (a running batch picks it up).
  async function setCatalog(input = {}) {
    const patch = {};
    if (input.provider != null) patch.catalog_provider = String(input.provider);
    if (input.model != null) patch.catalog_model = String(input.model);
    if (input.baseUrl != null) patch.catalog_base_url = String(input.baseUrl);
    if (input.paceMs != null) patch.catalog_pace_ms = Math.max(0, Number(input.paceMs) || 0);
    if (input.maxBodyChars != null) patch.catalog_max_body_chars = Math.max(500, Math.min(Number(input.maxBodyChars) || 6000, 20000));
    if (input.mailto != null) patch.catalog_mailto = String(input.mailto).trim();
    if (!Object.keys(patch).length) throw new Error('nothing to set — pass provider/model/baseUrl/paceMs/maxBodyChars/mailto');
    await store.setSettings(patch);
    const s = store.getSettings();
    return { provider: s.catalog_provider, model: s.catalog_model, baseUrl: s.catalog_base_url || undefined, paceMs: s.catalog_pace_ms, maxBodyChars: s.catalog_max_body_chars, mailto: s.catalog_mailto || undefined, note: 'key unchanged (set it in the UI)' };
  }

  // The source tree — feeds grouped by folder, with inbox counts — so the model
  // can see what sources exist before drilling in with queryItems({ feed }).
  // Optional `category` scopes to one folder ('' = ungrouped).
  // Health per feed: prefer the app's computed status (hijack/drift/stale/failing),
  // else the stored feed.state. Only non-healthy state is surfaced.
  function feedHealth(f) {
    const h = app && app._health && app._health.get(f.id);   // only non-ok feeds are cached
    const o = {};
    const state = h ? h.status : (f.state || 'healthy');
    if (state && state !== 'healthy') o.state = state;
    if (h && h.reasons && h.reasons.length) o.reasons = h.reasons;
    if (f.last_polled_at) o.lastPolled = new Date(f.last_polled_at).toISOString();
    const fh = f.feed_health || {};
    if (fh.consecutive_failures) o.fails = fh.consecutive_failures;
    if (fh.last_error) o.lastError = fh.last_error;
    if (fh.avg_items_per_week != null) o.perWeek = fh.avg_items_per_week;
    return o;
  }
  // Default → a COMPACT overview (folder summaries + health tally + just the troubled
  // feeds), so a 400+ feed corpus doesn't blow the result budget. Pass a `category` to
  // get the full per-feed list for one folder (bounded by folder size).
  const projFeed = (f, stats) => ({ id: f.id, name: f.name, url: f.url || undefined, adapter: f.adapter, category: f.category || '(ungrouped)', inbox: stats.byFeed[f.id] || 0, ...feedHealth(f) });
  async function listSources(input = {}) {
    const stats = store.counts();
    const feeds = store.listFeeds();
    if (input.q != null && String(input.q).trim()) {   // FIND a feed by name / url / id, across all folders
      const q = String(input.q).trim().toLowerCase();
      const rows = feeds.filter((f) => (f.name || '').toLowerCase().includes(q) || (f.url || '').toLowerCase().includes(q) || (f.site_url || '').toLowerCase().includes(q) || f.id.toLowerCase().includes(q))
        .slice(0, 50).map((f) => projFeed(f, stats));
      return { query: String(input.q), count: rows.length, feeds: rows };
    }
    if (input.category !== undefined) {   // detail mode: one folder
      const cat = String(input.category);
      const rows = feeds.filter((f) => (f.category || '') === cat)
        .map((f) => projFeed(f, stats))
        .sort((a, b) => b.inbox - a.inbox || a.name.localeCompare(b.name));
      return { category: cat || '(ungrouped)', count: rows.length, feeds: rows };
    }
    const folders = new Map(); const tally = { failing: 0, stale: 0, suspect: 0, slow: 0 }; const troubled = [];
    for (const f of feeds) {
      const cat = f.category || '';
      const g = folders.get(cat) || folders.set(cat, { category: cat || '(ungrouped)', feeds: 0, inbox: 0 }).get(cat);
      g.feeds++; g.inbox += stats.byFeed[f.id] || 0;
      const h = feedHealth(f);
      if (h.state) { if (tally[h.state] !== undefined) tally[h.state]++; troubled.push({ id: f.id, name: f.name, category: cat || '(ungrouped)', ...h }); }
    }
    const health = {}; for (const k in tally) if (tally[k]) health[k] = tally[k];
    troubled.sort((a, b) => (b.fails || 0) - (a.fails || 0) || a.name.localeCompare(b.name));
    const out = { feedCount: feeds.length, folders: [...folders.values()].sort((a, b) => a.category.localeCompare(b.category)) };
    if (Object.keys(health).length) out.health = health;
    if (troubled.length) { out.troubled = troubled.slice(0, 100); if (troubled.length > 100) out.troubledOmitted = troubled.length - 100; }
    return out;
  }

  // Ranked full-text search via the librarian index when ready (vs queryItems's
  // substring `q`) — better "most relevant about X" on a big corpus. Optional scope
  // filters (feed/type/category/view) narrow it; falls back to substring if no index.
  async function search(input = {}) {
    const q = String(input.q || input.text || '').trim();
    if (!q) throw new Error('provide `q` (the search query)');
    const limit = Math.min(Math.max(1, Number(input.limit) || 20), 100);
    const idx = app && app.searchIndex;
    const scoped = input.feed || input.type || input.view || input.category !== undefined || input.unread !== undefined || input.saved !== undefined;
    if (idx && idx.ready) {
      let filter;
      if (scoped) { const allowed = new Set(store.query(buildQuery(input)).map((r) => r.id)); filter = (id) => allowed.has(id); }
      const hits = idx.search(q, { limit, filter }) || [];
      return { ranked: true, count: hits.length, items: hits.map((h) => { const it = store.getItem(h.id); return it ? { ...projItem(store, it, false), score: h.score } : null; }).filter(Boolean) };
    }
    const rows = store.query({ ...buildQuery(input), text: q }).slice(0, limit);
    return { ranked: false, count: rows.length, items: rows.map((r) => projItem(store, r, false)) };
  }

  // Subscribe to a feed (adapter auto-detected; an initial poll fires in the app).
  async function addFeed(input = {}) {
    if (!app) throw new Error('adding feeds is only available in the running app');
    const url = String(input.url || '').trim();
    if (!url) throw new Error('provide `url`');
    const matched = (app.adapters || []).find((a) => { try { return a.match(url); } catch { return false; } });
    const adapter = (matched && matched.name) || 'feed';
    const resolved = (matched && matched.resolveUrl && matched.resolveUrl(url)) || url;
    let host = url; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
    const name = input.name || (matched && matched.titleFor && matched.titleFor(url)) || host;
    const feed = await store.putFeed({ url: resolved, name, adapter, category: input.category || undefined });
    if (app.poller) app.poller.pollFeed(feed).then(() => app.renderAll && app.renderAll()).catch(() => {});
    if (app.renderRail) app.renderRail();
    return { id: feed.id, name: feed.name, adapter: feed.adapter, url: feed.url, category: feed.category || undefined };
  }

  // Update a feed's curation fields (rename, recategorize, retention, poll interval,
  // image/full-text policy). Not destructive — no unsubscribe here (that lives in the UI).
  async function updateFeed(input = {}) {
    const f = input.id != null && store.getFeed(String(input.id));
    if (!f) throw new Error(`No feed "${input.id}". Use weir_listSources for ids.`);
    const patch = {};
    if (input.name != null) patch.name = String(input.name);
    if (input.category !== undefined) patch.category = String(input.category) || undefined;
    if (input.poll_interval_minutes != null) patch.poll_interval_minutes = Math.max(5, Number(input.poll_interval_minutes) || 180);
    if (input.images_allowed !== undefined) patch.images_allowed = !!input.images_allowed;
    if (input.fetch_full_content !== undefined) patch.fetch_full_content = !!input.fetch_full_content;
    if (input.retention !== undefined) patch.retention = (input.retention === 'forever' || input.retention == null) ? { unread_days: 'forever', read_days: 'forever' } : { unread_days: Math.max(1, Number(input.retention) || 0) };
    if (input.url != null) {
      // Point the feed at a new URL (e.g. fixing a moved/404 feed). Items stay under the
      // same feed id; drop the stale validators + re-poll now so it gets a clean fetch.
      patch.url = String(input.url).trim();
      patch.etag = undefined; patch.last_modified = undefined;
      patch.next_poll_at = Date.now();
      patch.state = 'healthy'; patch.feed_health = { ...(f.feed_health || {}), consecutive_failures: 0, last_error: undefined };
    }
    if (!Object.keys(patch).length) throw new Error('nothing to update — pass url/name/category/retention/poll_interval_minutes/images_allowed/fetch_full_content');
    await store.updateFeed(f.id, patch);
    let repoll;
    if (patch.url && app && app.poller) { try { repoll = await app.poller.pollFeed(store.getFeed(f.id)); } catch (e) { repoll = { error: String(e && e.message || e) }; } }
    if (app && app.renderAll) app.renderAll();
    return { id: f.id, ...patch, ...(repoll ? { repoll } : {}) };
  }

  // Unsubscribe + delete a feed (and its items) — for pruning dead/moved sources during
  // a curation sweep. DESTRUCTIVE + not reversible (no trash, unlike the stacks). Gated
  // behind the `mcp_allow_feed_removal` setting so the user can switch this capability
  // off entirely. Returns { removed, items } (item count erased).
  async function removeFeed(input = {}) {
    if (!store.getSettings().mcp_allow_feed_removal) throw new Error('feed removal over MCP is disabled (Settings → “let Claude prune feeds”). Remove it in the UI instead (right-click → Remove feed).');
    const f = input.id != null && store.getFeed(String(input.id));
    if (!f) throw new Error(`No feed "${input.id}". Use weir_listSources for ids.`);
    const items = (store.byFeed.get(f.id) || new Set()).size;
    await store.removeFeed(f.id);
    if (app && app.renderAll) app.renderAll();
    return { removed: f.id, name: f.name, items };
  }

  // Re-key a feed's id (NOT its display name — use updateFeed for that). A feed's
  // id is load-bearing: the adapter mints item ids as `<feed.id>:<guid>` each poll,
  // and content/shard files + tombstones + catalog cards are addressed by it. This
  // moves ALL of that in lockstep (and relocates content; nothing is data-deleted),
  // preserving read/saved/tags. For cleaning up an id that was auto-derived from a
  // bad name (e.g. a feed that landed on the generic host slug `bsky-app`). The new
  // id is slugified; collisions are rejected. Returns { renamed, from, items }.
  async function renameFeed(input = {}) {
    const f = input.id != null && store.getFeed(String(input.id));
    if (!f) throw new Error(`No feed "${input.id}". Use weir_listSources for ids.`);
    if (input.newId == null || !String(input.newId).trim()) throw new Error('pass newId (the desired feed id; it will be slugified)');
    const r = await store.renameFeed(f.id, input.newId);   // throws if the target id is taken
    if (app && app.renderAll) app.renderAll();
    return r;
  }

  // Force a fresh poll of one feed NOW, bypassing conditional-GET so the full body
  // re-parses even when nothing changed — re-deriving titles, picking up edits.
  // The clean replacement for "change the URL to itself" as a refresh trick: it
  // does NOT reset the feed's validators or schedule. For nudging a specific feed
  // during a curation sweep (e.g. healing a microblog feed's titles). Returns the
  // poll result { inserted, updated, skipped } (or { error } on a fetch failure).
  async function repoll(input = {}) {
    if (!app || !app.poller) throw new Error('repoll is only available in the running app');
    const f = input.id != null && store.getFeed(String(input.id));
    if (!f) throw new Error(`No feed "${input.id}". Use weir_listSources for ids.`);
    const result = await app.poller.pollFeed(f, { force: true });
    if (app.renderAll) app.renderAll();
    return { id: f.id, ...(result || { skipped: 'already polling' }) };
  }

  // Recover a dead/truncated feed's lost history from the Internet Archive
  // (Wayback): find old snapshots of the feed URL, re-parse their items, store
  // them (archived history preserved — nothing is deleted). Default QUEUES feed(s)
  // into the gentle background drip (one IA request every few minutes, resumes
  // across restarts) — the right tool for a batch; a foreground burst over many
  // feeds would hammer archive.org. `now:true` recovers a single `id` immediately
  // (throttled burst) and returns counts — good for proving one feed before
  // committing a batch. Scope by id / ids[] / category.
  async function recover(input = {}) {
    if (!app || !app.recovery) throw new Error('recovery is only available in the running app');
    if (input.now) {
      const f = input.id != null && store.getFeed(String(input.id));
      if (!f) throw new Error(`No feed "${input.id}". Pass an id (from weir_listSources) with now:true.`);
      const r = await app.recoverHistory(f.id);   // foreground burst → counts
      return { mode: 'now', id: f.id, ...(r || {}) };
    }
    let ids = [];
    if (input.id != null) ids = [String(input.id)];
    else if (Array.isArray(input.ids)) ids = input.ids.map(String);
    else if (input.category != null) ids = store.listFeeds().filter((f) => (f.category || '') === String(input.category)).map((f) => f.id);
    else throw new Error('pass id, ids[], or category to queue for recovery (or { now:true, id } for an immediate single recover)');
    ids = ids.filter((id) => store.getFeed(id));
    if (!ids.length) throw new Error('no matching feeds to recover');
    await app.recovery.enqueue(ids);
    return { mode: 'drip', queued: ids.length, status: app.recovery.status() };
  }

  // Kick the background link resolver — resolve wrapped saved links (share.google
  // etc.) to their real url + fetch thumbnail/title metadata, gently over time.
  async function resolveLinks() {
    if (!app || !app.linkResolver) throw new Error('resolveLinks is only available in the running app');
    app.linkResolver.kick();
    const st = app.linkResolver.status();
    return { kicked: true, pending: st.pending, running: st.running, log: st.log };
  }

  // Read the resolver run log: how many resolved / parked, failure reasons
  // (http-429 = throttled, no-redirect, network…), and recent parked links.
  async function resolverLog() {
    if (!app || !app.linkResolver) throw new Error('resolverLog is only available in the running app');
    const st = app.linkResolver.status();
    return { pending: st.pending, running: st.running, ...st.log };
  }

  // Rework: re-enrich already-processed saved links (clears `enriched` → the drip
  // re-fetches + re-applies metadata). { weakTitles:true } targets links whose
  // title is weak (so a better og:title is applied); { all:true } re-does all.
  async function reEnrich(input = {}) {
    if (!app || !app.linkResolver) throw new Error('reEnrich is only available in the running app');
    const r = app.linkResolver;
    let queued;
    if (input.weakTitles) queued = await r.reEnrichWeakTitles();
    else if (input.all) queued = await r.reEnrich(() => true);
    else throw new Error('pass { weakTitles: true } or { all: true }');
    return { queued, pending: r.status().pending };
  }

  // ── stacks (STACKS.md §6): co-curate the notes/files vault ──
  // Path-addressed (human-friendly); each result also carries the item `id`
  // (stacks:<uid>) so the item-level tools (getItem/catalogItem/setState) compose.
  const stkFolderOf = (p) => { const i = String(p || '').lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); };
  function requireStacks() { if (!app || !app.stacks) throw new Error('the stacks are only available in the running app'); return app.stacks; }
  function findStackByPath(path) {
    if (path == null) return null;
    const want = String(path).replace(/^\/+/, '');
    for (const id of store._feedSet('stacks')) { const r = store.getItem(id); if (r && r.path === want) return r; }
    return null;
  }
  const projStack = (e) => ({ id: e.id, path: e.path, uid: e.uid, type: e.type, title: e.title || e.path, tags: (e.tags && e.tags.length) ? e.tags : undefined, missing: e.missing || undefined, glass_id: e.glass_id || undefined });

  async function stacksList(input = {}) {
    const stacks = requireStacks();
    const prefix = input.path != null ? String(input.path).replace(/^\/+|\/+$/g, '') : null;
    let entries = stacks.entries();
    if (prefix) entries = entries.filter((e) => { const f = stkFolderOf(e.path); return f === prefix || f.startsWith(prefix + '/'); });
    const folders = new Set();
    for (const e of entries) { const f = stkFolderOf(e.path); if (f) folders.add(f); }
    const limit = Math.min(Math.max(1, Number(input.limit) || 200), 500);
    return { count: entries.length, folders: [...folders].sort(), entries: entries.slice(0, limit).map(projStack) };
  }

  async function stacksRead(input = {}) {
    requireStacks();
    const item = findStackByPath(input.path);
    if (!item) throw new Error(`No stacks entry at "${input.path}". Use weir_stacksList to see paths.`);
    const o = projStack(item);
    if (item.type === 'note') { const body = await app.stacks.readNote(item); o.markdown = body.length > 16000 ? body.slice(0, 16000) + '…' : body; }
    else o.mime = item.mime || undefined;
    return o;
  }

  async function stacksWrite(input = {}) {
    const stacks = requireStacks();
    if (input.markdown == null) throw new Error('provide `markdown` (the note body).');
    const tags = [].concat(input.tags || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    const path = input.path ? String(input.path).replace(/^\/+/, '') : null;
    const existing = path ? findStackByPath(path) : null;
    let rec;
    if (existing && existing.type === 'note') {
      rec = await stacks.saveNote(existing, String(input.markdown), { title: input.title, tags: tags.length ? tags : undefined });
    } else {
      let folder = input.folder, name = input.name;
      if (path) { const i = path.lastIndexOf('/'); if (folder == null) folder = i >= 0 ? path.slice(0, i) : 'inbox'; if (name == null) name = i >= 0 ? path.slice(i + 1) : path; }
      rec = await stacks.writeNote({ folder: folder || 'inbox', name, title: input.title, markdown: String(input.markdown), tags, source: 'claude' });
    }
    await store.flush();
    if (app.renderStacks) app.renderStacks();
    if (app.stackFilter && app.renderStream) app.renderStream();
    return { ok: true, ...projStack(rec) };
  }

  async function stacksMove(input = {}) {
    const stacks = requireStacks();
    const item = findStackByPath(input.path);
    if (!item) throw new Error(`No stacks entry at "${input.path}".`);
    if (input.toFolder == null) throw new Error('provide `toFolder`.');
    const from = item.path;
    const rec = await stacks.move(item, String(input.toFolder).replace(/^\/+|\/+$/g, ''));
    await store.flush();
    if (app.renderStacks) app.renderStacks();
    if (app.stackFilter && app.renderStream) app.renderStream();
    return { ok: true, movedFrom: from, ...projStack(rec) };
  }

  async function stacksTag(input = {}) {
    const stacks = requireStacks();
    const item = findStackByPath(input.path);
    if (!item) throw new Error(`No stacks entry at "${input.path}".`);
    const add = [].concat(input.add || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    const remove = [].concat(input.remove || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    if (!add.length && !remove.length) throw new Error('provide tags to add and/or remove.');
    for (const t of add) store.addTag(item.id, t, 'llm');
    for (const t of remove) store.removeTag(item.id, t);
    await stacks.syncTagsToFile(item);   // mirror to the note frontmatter / file sidecar
    await store.flush();
    if (app.renderStacks) app.renderStacks();
    return { ok: true, ...projStack(store.getItem(item.id)) };
  }

  async function stacksTrash(input = {}) {
    const stacks = requireStacks();
    const item = findStackByPath(input.path);
    if (!item) throw new Error(`No stacks entry at "${input.path}".`);
    const r = await stacks.trash(item);   // → /stacks/.trash (never-delete; recoverable)
    await store.flush();
    if (app.renderStacks) app.renderStacks();
    if (app.stackFilter && app.renderStream) app.renderStream();
    return { ok: true, ...r };
  }

  return { queryItems, getItem, search, listFacets, listSources, addFeed, updateFeed, resolveLinks, resolverLog, reEnrich, setState, tag, unarchiveAll, catalogItem, catalogControl, reviewQueue, reviewItem, mergeFacetTerm, vocab, relateTerm, relatedTo, relate, works, listProviderModels, setCatalog, removeFeed, renameFeed, repoll, recover, stacksList, stacksRead, stacksWrite, stacksMove, stacksTag, stacksTrash };
}

// Tool schemas. Names are `weir_*` (MCP tool names are [A-Za-z0-9_-]; no dots) —
// the prefix namespaces weir's tools if its bridge is ever co-registered with
// another surface's in one Claude session.
const TOOLS = [
  {
    name: 'weir_queryItems', fn: 'queryItems',
    description: 'Search/list weir feed items, newest first. Filters: q (substring over title/excerpt/text), feed (a source by id OR name, e.g. "Saved Links"), category (folder name; "" = ungrouped), type (article|video|release|paper|status|track|podcast|commit|issue|note), view (inbox|saved|archived), unread (bool), saved (bool), limit (default 30, max 100). Filters combine. Use feed/category to LIST a whole source (more reliable than q, which is substring-only). Paginated: returns { count, total, hasMore, items, nextCursor }; page by passing nextCursor back with the SAME filters. Items are compact (id, title, url, feed, published, tags, excerpt). Use weir_listSources first to see feed/folder names.',
    inputSchema: {
      type: 'object', properties: {
        q: { type: 'string', description: 'Substring search over title/excerpt/text' },
        feed: { type: 'string', description: 'Scope to one source — its feed id or display name (e.g. "Saved Links")' },
        category: { type: 'string', description: 'Scope to one folder by name ("" = ungrouped)' },
        type: { type: 'string', description: 'Item type filter' },
        view: { type: 'string', enum: ['inbox', 'saved', 'archived'], description: 'Which view to scope to' },
        unread: { type: 'boolean', description: 'Only unread items' },
        saved: { type: 'boolean', description: 'Only saved (true) / only unsaved (false)' },
        limit: { type: 'integer', description: 'Max items per page (default 30, cap 100)' },
        cursor: { type: 'string', description: 'Opaque pagination cursor from a previous call’s nextCursor — reuse the same filters' },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, title: 'Query weir items' },
  },
  {
    name: 'weir_listSources', fn: 'listSources',
    description: 'Source overview (compact — safe on a 400+ feed corpus). DEFAULT returns { feedCount, folders:[{category,feeds,inbox}], health:{failing,stale,…}, troubled:[…] } — folder summaries + a health tally + ONLY the non-healthy feeds (state/lastPolled/fails/lastError), so you can spot prune candidates without dumping everything. Pass `q` to FIND a feed by name/URL/id across ALL folders (the way to locate a specific feed) → { query, count, feeds:[…incl url] }. Pass `category` for the FULL per-feed list of one folder. Pair with weir_updateFeed / weir_removeFeed to curate, weir_queryItems({feed}) to drill in.',
    inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Find feeds whose name/URL/id contains this (across all folders)' }, category: { type: 'string', description: 'Full per-feed detail for one folder ("" = ungrouped)' } } },
    annotations: { readOnlyHint: true, idempotentHint: true, title: 'List weir sources' },
  },
  {
    name: 'weir_addFeed', fn: 'addFeed',
    description: 'Subscribe to a feed by URL — adapter auto-detected (RSS/Atom/JSON Feed, YouTube channel, GitHub repo); an initial poll fires in the app. Optional `name` + `category` (folder). Returns the created feed { id, name, adapter, url, category }.',
    inputSchema: {
      type: 'object', properties: {
        url: { type: 'string', description: 'Feed or page URL to subscribe to' },
        name: { type: 'string', description: 'Display name (default: derived from the URL/adapter)' },
        category: { type: 'string', description: 'Folder to file it under' },
      }, required: ['url'],
    },
    annotations: { title: 'Add a feed' },
  },
  {
    name: 'weir_updateFeed', fn: 'updateFeed',
    description: 'Curate a feed: change its URL (e.g. fix a moved/404 feed — items stay, validators reset, it re-polls now), rename, recategorize (folder), set retention ("forever" or a day count), poll interval (minutes), image policy, or full-text auto-fetch. Identify it by `id` (from weir_listSources). Not destructive — no unsubscribe here (that lives in the UI). Returns the applied patch (+ `repoll` result when the URL changed).',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'Feed id (from weir_listSources)' },
        url: { type: 'string', description: 'New feed URL (fixes a moved/dead feed; re-polls immediately)' },
        name: { type: 'string', description: 'Rename the feed' },
        category: { type: 'string', description: 'Move to a folder ("" = ungrouped)' },
        retention: { description: '"forever", or a number of days to keep before archiving' },
        poll_interval_minutes: { type: 'integer', description: 'How often to poll (min 5)' },
        images_allowed: { type: 'boolean', description: 'Always load images for this feed' },
        fetch_full_content: { type: 'boolean', description: 'Auto-fetch full article text' },
      }, required: ['id'],
    },
    annotations: { title: 'Update a feed' },
  },
  {
    name: 'weir_removeFeed', fn: 'removeFeed',
    description: 'Unsubscribe and DELETE a feed and its items — for pruning dead/moved sources (DNS-gone, TLS-dead, 404) during a curation sweep. Destructive + NOT reversible (no trash, unlike the stacks). Gated behind a user setting; if disabled, errors and points to the UI. Confirm with the user before calling. Returns { removed, name, items }.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Feed id (from weir_listSources)' } }, required: ['id'] },
    annotations: { title: 'Remove a feed', destructiveHint: true },
  },
  {
    name: 'weir_renameFeed', fn: 'renameFeed',
    description: 'Re-key a feed\'s ID (not its display name — use weir_updateFeed for the name). A feed id is load-bearing: the adapter mints item ids as `<feedid>:<guid>` every poll, and content files, tombstones, and catalog cards are addressed by it. This migrates ALL of that in lockstep (relocating content; nothing is data-deleted) and preserves read/saved/tags. Use it to clean up an id that was auto-derived from a bad name — e.g. a feed that landed on the generic host slug `bsky-app`. The newId is slugified; a collision with an existing id is rejected. Returns { renamed, from, items, tombstones }.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'Current feed id (from weir_listSources)' },
        newId: { type: 'string', description: 'Desired feed id (will be slugified, e.g. "arne-androidarts")' },
      }, required: ['id', 'newId'],
    },
    annotations: { title: 'Rename a feed id' },
  },
  {
    name: 'weir_repoll', fn: 'repoll',
    description: 'Force a fresh poll of one feed right now, bypassing conditional-GET so the full body re-parses even if nothing changed — re-derives titles, picks up edits. The clean way to refresh a feed (does NOT reset validators or schedule, unlike changing the URL). Use it to heal a microblog feed reading as "(untitled)", or to pull a feed immediately. Returns { id, inserted, updated, skipped } or { error }.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Feed id (from weir_listSources)' } }, required: ['id'] },
    annotations: { title: 'Force-refresh a feed' },
  },
  {
    name: 'weir_recover', fn: 'recover',
    description: 'Recover a dead/truncated feed\'s lost history from the Internet Archive (Wayback Machine): finds old snapshots of the feed URL, re-parses their items, and stores them — archived history preserved, nothing deleted. Default QUEUES feed(s) into a gentle background drip (one IA request every few minutes, resumes across restarts) — the right tool for a batch of dead feeds; `now:true` recovers a single feed immediately as a throttled burst and returns counts (good for proving one feed before queuing many). Scope by id, ids[], or category. Returns recovery counts (now) or drip status (queued). Pairs with never-delete: recover the data, keep the feed, don\'t prune.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'A single feed id (from weir_listSources)' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Multiple feed ids to queue into the drip' },
        category: { type: 'string', description: 'Queue every feed in this folder' },
        now: { type: 'boolean', description: 'Recover the single `id` immediately (foreground burst) instead of queuing the background drip' },
      },
    },
    annotations: { title: 'Recover feed history (Wayback)' },
  },
  {
    name: 'weir_resolveLinks', fn: 'resolveLinks',
    description: 'Kick the background resolver to process pending saved links now — resolve share.google/shortener URLs to their real destination and fetch thumbnail/title/excerpt metadata, gently over time (a couple every ~15s, so it never burst-hits the shortener). Returns { kicked, pending, running }. Imported links resolve on their own; use this to nudge it.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Resolve saved links' },
  },
  {
    name: 'weir_resolverLog', fn: 'resolverLog',
    description: 'Read the background link-resolver run log — { pending, running, resolved, parked, reasons, recent, startedAt, updatedAt }. `resolved` = links fully resolved+enriched; `parked` = gave up after retries; `reasons` tallies every failed try (http-429 = share.google throttling, no-redirect, network); `recent` = the last few parked links (host + reason). Use it to review an overnight run.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true, title: 'Resolver run log' },
  },
  {
    name: 'weir_reEnrich', fn: 'reEnrich',
    description: 'Rework saved links: clear their enriched flag so the background resolver re-fetches + re-applies metadata (title/thumbnail/excerpt). `weakTitles:true` re-does only links with a weak title (e.g. "Source: Hackaday" → real og:title); `all:true` re-does every saved link. Already-resolved urls are re-fetched directly (fast, no share.google throttle). Returns { queued, pending }.',
    inputSchema: { type: 'object', properties: { weakTitles: { type: 'boolean', description: 'Only links whose title is weak' }, all: { type: 'boolean', description: 'Every saved link' } } },
    annotations: { title: 'Re-enrich saved links' },
  },
  {
    name: 'weir_getItem', fn: 'getItem',
    description: "Get one weir item by id: glass facets + description (if cataloged), plus its knowledge-graph edges — `links` (what its body links to via [[ref]], resolved to {ref,id,title}) and `backlinks` (items whose body links to it). Pass content:true to include the extracted article/note text (capped 8k).",
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'Item id (from weir_queryItems)' },
        content: { type: 'boolean', description: 'Include the extracted body text' },
      }, required: ['id'],
    },
    annotations: { readOnlyHint: true, title: 'Get a weir item' },
  },
  {
    name: 'weir_search', fn: 'search',
    description: 'RANKED full-text search (the librarian BM25 index) — relevance-ordered, better than weir_queryItems\'s substring `q` for "most relevant about X" on a large corpus. Optional scope filters (feed/type/category/view/unread/saved) narrow it like queryItems. Returns { ranked, count, items:[…,score] } (ranked:false = index not ready, fell back to substring). Use queryItems to LIST a whole feed/folder; use search to FIND by relevance.',
    inputSchema: {
      type: 'object', properties: {
        q: { type: 'string', description: 'The search query' },
        feed: { type: 'string', description: 'Scope to a source (id or display name)' },
        category: { type: 'string', description: 'Scope to a folder ("" = ungrouped)' },
        type: { type: 'string', description: 'Scope to an item type' },
        view: { type: 'string', enum: ['inbox', 'saved', 'archived'], description: 'Scope to a view' },
        unread: { type: 'boolean', description: 'Only unread' },
        saved: { type: 'boolean', description: 'Only saved' },
        limit: { type: 'integer', description: 'Max hits (default 20, cap 100)' },
      }, required: ['q'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, title: 'Ranked search' },
  },
  {
    name: 'weir_setState', fn: 'setState',
    description: "Set read / saved / archived (each a boolean; pass only the ones to change) — on ONE item (`id`) or every item matching a query (pass q/feed/category/type/view/unread/saved — e.g. archive a dead feed, mark a folder read). A bulk call REQUIRES a scoping filter (no accidental whole-corpus change). All reversible — archive never deletes (weir_unarchiveAll reverses a sweep). Returns the item (id mode) or { matched, patch } (query mode).",
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'A single item id; omit to bulk over a query' },
        read: { type: 'boolean', description: 'Mark read/unread' },
        saved: { type: 'boolean', description: 'Save/unsave (star)' },
        archived: { type: 'boolean', description: 'Archive/unarchive (non-destructive)' },
        q: { type: 'string', description: 'Bulk scope: substring over title/excerpt/text' },
        feed: { type: 'string', description: 'Bulk scope: a source by id or name' },
        category: { type: 'string', description: 'Bulk scope: a folder ("" = ungrouped)' },
        type: { type: 'string', description: 'Bulk scope: item type' },
        view: { type: 'string', enum: ['inbox', 'saved', 'archived'], description: 'Bulk scope: a view (use view:"saved" to scope to saved items)' },
        unread: { type: 'boolean', description: 'Bulk scope: only unread' },
      },
    },
    annotations: { title: 'Set item state' },
  },
  {
    name: 'weir_tag', fn: 'tag',
    description: "Add and/or remove tags — on ONE item (pass `id`) or on EVERY item matching a query (pass any of q/feed/category/type/view/unread/saved — the \"tag all these results\" verb). Tags are stamped source:'llm' (the UI shows them apart from your 'human' tags), are immediately searchable/queryable, and feed the glass `entity` facet on the next catalog. Returns the updated item (id mode) or { matched, changed } (query mode). Use weir_queryItems first to preview a bulk scope.",
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'Tag a single item by id (from weir_queryItems); omit to bulk-tag a query' },
        q: { type: 'string', description: 'Bulk scope: substring over title/excerpt/text' },
        feed: { type: 'string', description: 'Bulk scope: a source by id or display name' },
        category: { type: 'string', description: 'Bulk scope: a folder name ("" = ungrouped)' },
        type: { type: 'string', description: 'Bulk scope: item type (article|video|paper|note|…)' },
        view: { type: 'string', enum: ['inbox', 'saved', 'archived'], description: 'Bulk scope: a view' },
        unread: { type: 'boolean', description: 'Bulk scope: only unread' },
        saved: { type: 'boolean', description: 'Bulk scope: only saved' },
        add: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
      },
    },
    annotations: { title: 'Tag item(s)' },
  },
  {
    name: 'weir_unarchiveAll', fn: 'unarchiveAll',
    description: 'Bring EVERY archived item back to active and clear its expiry (so retention won\'t re-shelve it) — the one-shot "I keep everything" restore that reverses an over-eager auto-archive sweep. Reversible; nothing is deleted. Returns { unarchived }.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Unarchive everything' },
  },
  {
    name: 'weir_catalogItem', fn: 'catalogItem',
    description: 'Catalog one item with the configured LLM right now (fills its glass facets + description). Returns glass_id, facets, description. Needs the cataloger configured and reachable (Lemonade via the bridge).',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'Item id (from weir_queryItems)' } }, required: ['id'] },
    annotations: { title: 'Catalog an item' },
  },
  {
    name: 'weir_listModels', fn: 'listProviderModels',
    description: 'List the catalog provider\'s available models (so you can pick one). Optional `provider` overrides the configured one (lemonade|ollama|nanogpt|groq|custom). Returns { provider, count, models }.',
    inputSchema: { type: 'object', properties: { provider: { type: 'string', description: 'Override the configured provider' } } },
    annotations: { readOnlyHint: true, title: 'List provider models' },
  },
  {
    name: 'weir_setCatalog', fn: 'setCatalog',
    description: 'Set cataloger config — provider, model, baseUrl, paceMs (delay between calls; 0 = fastest, good for cloud), maxBodyChars (doc text sent; cost/context). NOT the API key (set that in the UI). Takes effect on the next cataloged item; a running batch picks it up. Returns the new config.',
    inputSchema: {
      type: 'object', properties: {
        provider: { type: 'string', description: 'lemonade | ollama | nanogpt | groq | custom' },
        model: { type: 'string', description: 'Model id (see weir_listModels)' },
        baseUrl: { type: 'string', description: 'Override base URL (local/custom providers)' },
        paceMs: { type: 'integer', description: 'Delay between catalog calls in ms (0 = no pause)' },
        maxBodyChars: { type: 'integer', description: 'Max doc chars sent to the LLM (500–20000)' },
        mailto: { type: 'string', description: "Contact email for the Crossref/OpenAlex polite pool (biblio enrich); sent only to those scholarly APIs" },
      },
    },
    annotations: { title: 'Set cataloger config' },
  },
  {
    name: 'weir_catalogControl', fn: 'catalogControl',
    description: 'Start / stop / clear / inspect the catalog batch. action:"start" catalogs un-cataloged non-archived items (paced, runs in the page) — optionally SCOPED to one feed/folder/type via feed|category|type (omit all → whole corpus); "stop" cancels; "clear" discards ALL cards + un-files every item (items/content/reading state untouched; reversible by re-cataloging) for a clean restart; "status" (default) reports running state, progress {total,done,failed}, and cataloged/total counts. start returns {running, todo, deferred}.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['start', 'stop', 'clear', 'status'], description: 'Default: status' },
      feed: { type: 'string', description: 'start scope: a source by id OR display name (e.g. "Saved Links")' },
      category: { type: 'string', description: 'start scope: a folder name ("" = ungrouped)' },
      type: { type: 'string', description: 'start scope: item type (article|video|paper|…)' },
      recatalog: { type: 'boolean', description: 'with action:start + a scope: DISCARD that scope\'s existing cards first, then re-catalog from scratch (re-do a batch cataloged under an old rule)' },
    } },
    annotations: { title: 'Control cataloging', destructiveHint: true },
  },
  {
    name: 'weir_reviewQueue', fn: 'reviewQueue',
    description: 'List cataloger cards flagged needs_review (the LLM returned low-confidence / unparseable output) for human confirm/correct. Returns { total, count, items } where each item carries its current facets + confidence. Pair with weir_reviewItem to approve or fix.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'Max items (default 30, cap 100)' } } },
    annotations: { readOnlyHint: true, title: 'Review queue' },
  },
  {
    name: 'weir_reviewItem', fn: 'reviewItem',
    description: 'Confirm a cataloger card (clears needs_review, stamps a human review) and OPTIONALLY correct its facets. Pass facets as an object of facet→string[] to overwrite those facets (e.g. {"scale":[],"domain":["gaming"]}); omit to just approve as-is.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'Item id (from weir_reviewQueue)' },
        facets: { type: 'object', description: 'Optional facet corrections, e.g. {"scale":[],"entity":["minecraft"]} — overwrites only the given facets' },
      }, required: ['id'],
    },
    annotations: { title: 'Confirm/correct a card' },
  },
  {
    name: 'weir_mergeFacetTerm', fn: 'mergeFacetTerm',
    description: 'Thesaurus normalization: rewrite a facet term across the WHOLE catalog (from → to within one facet, de-duped) so facet-browsing stops splitting one concept across spelling/synonym variants — e.g. spatial usa→united states, entity ai→artificial intelligence. Also RECORDS the merge in the controlled vocabulary: the from-term becomes a skos:altLabel (synonym) of the target, so the decision is remembered (inspect via weir_vocab), not just applied. An empty/omitted `to` DROPS the term (records nothing). Use weir_listFacets to spot variants first. Pass one {facet, from, to} or a {merges:[…]} batch (one atomic flush). Pure card edit — items/reading state untouched, reversible. Returns each merge\'s card-change count.',
    inputSchema: {
      type: 'object', properties: {
        facet: { type: 'string', description: 'Facet to edit (domain|entity|process|method|scale|spatial|stance|temporal|form|provenance)' },
        from: { type: 'string', description: 'Existing term to rewrite' },
        to: { type: 'string', description: 'Replacement term (empty/omitted = drop the from-term)' },
        merges: { type: 'array', items: { type: 'object', properties: { facet: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' } } }, description: 'Batch of {facet, from, to} merges applied atomically' },
      },
    },
    annotations: { title: 'Merge a facet term (thesaurus)' },
  },
  {
    name: 'weir_vocab', fn: 'vocab',
    description: 'Inspect the controlled vocabulary / thesaurus (SKOS-shaped, GLASS §7). No args → per-facet concept-count overview. `facet` → that facet\'s concepts. `facet`+`term` → one concept (prefLabel + altLabels/synonyms + broader/narrower/related). `export:true` → SKOS JSON-LD (optionally for one `facet`). The vocabulary GROWS from curation: weir_mergeFacetTerm records the merged term as a synonym (altLabel); weir_relateTerm declares BT/NT/RT.',
    inputSchema: {
      type: 'object', properties: {
        facet: { type: 'string', description: 'Limit to one facet' },
        term: { type: 'string', description: 'With facet: return just this term\'s concept' },
        export: { type: 'boolean', description: 'Return SKOS JSON-LD instead' },
      },
    },
    annotations: { title: 'Inspect the vocabulary (SKOS)' },
  },
  {
    name: 'weir_relateTerm', fn: 'relateTerm',
    description: 'Declare typed thesaurus relations (SKOS, GLASS §7) on a term: broader (BT), narrower (NT), related (RT), or alt (a synonym/altLabel that redirects to this term). Inverses are maintained automatically (declare broader → the target gains narrower). Each value is a string or list of terms. This is the ratified way to grow hierarchy — a similarity signal may propose, but a relation exists only once you declare it here (decides-vs-proposes). Use weir_vocab to inspect.',
    inputSchema: {
      type: 'object', properties: {
        facet: { type: 'string', description: 'Facet (e.g. spatial, domain, entity)' },
        term: { type: 'string', description: 'The preferred term to relate' },
        broader: { description: 'Broader term(s) — string or array (BT)' },
        narrower: { description: 'Narrower term(s) — string or array (NT)' },
        related: { description: 'Related term(s) — string or array (RT)' },
        alt: { description: 'Synonym(s) that redirect to this term — string or array (altLabel/UF)' },
      }, required: ['facet', 'term'],
    },
    annotations: { title: 'Declare a thesaurus relation' },
  },
  {
    name: 'weir_works', fn: 'works',
    description: 'Inspect (and optionally rebuild) FRBR work-grouping (GLASS §4.1): items that are the same Work across manifestations — wire-syndication, re-uploads, cross-posts. `regroup:true` runs the deterministic grouping pass (identical canonical URL + SimHash near-duplicate; NOT an LLM call) then reports; default reports current grouping. Returns { stats:{items,works,manifestations,biggest}, works:[{work_id,size,members:[{title,feed}]}] } biggest-first — to eyeball precision. De-dup as GROUPING not discarding: nothing is deleted, work_id is a reversible overlay.',
    inputSchema: {
      type: 'object', properties: {
        regroup: { type: 'boolean', description: 'Recompute the grouping before reporting (run this first — the corpus has no work_ids until you do)' },
        maxHamming: { type: 'integer', description: 'SimHash near-dup threshold in bits (default 3; higher = looser grouping)' },
        limit: { type: 'integer', description: 'Max example clusters to return (default 20, cap 100)' },
      },
    },
    annotations: { title: 'Work-grouping (FRBR)' },
  },
  {
    name: 'weir_relatedTo', fn: 'relatedTo',
    description: 'The knowledge graph around an item (GLASS §10): its ratified `related` edges — outgoing + backlinks — PLUS on-demand SUGGESTIONS (set suggest:false to skip) from facet co-occurrence, each carrying the shared facet terms (the "why") and a score. Pass an item id (from weir_queryItems) or a glass_id; the item must be cataloged. Suggestions are NOT edges until ratified via weir_relate.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'Item id or glass_id' },
        suggest: { type: 'boolean', description: 'Include facet-overlap suggestions (default true)' },
        limit: { type: 'integer', description: 'Max suggestions (default 8, cap 25)' },
      }, required: ['id'],
    },
    annotations: { readOnlyHint: true, title: 'Related items + suggestions' },
  },
  {
    name: 'weir_relate', fn: 'relate',
    description: 'Ratify (or remove) a typed `related` edge between two items — decides-vs-proposes (GLASS §2.1): a facet-overlap suggestion becomes a real edge ONLY when declared here. `from`/`to` are item ids (or glass_ids); both must be cataloged. `type` ∈ related | same-topic | extends | contradicts | responds-to | same-work (default "related"). Pass remove:true to delete the edge (optionally just one type). Stored on the from-item, source "claude"; reversible (weir never deletes the items).',
    inputSchema: {
      type: 'object', properties: {
        from: { type: 'string', description: 'Source item id / glass_id' },
        to: { type: 'string', description: 'Target item id / glass_id' },
        type: { type: 'string', description: 'related | same-topic | extends | contradicts | responds-to | same-work' },
        remove: { type: 'boolean', description: 'Remove the edge instead of creating it' },
      }, required: ['from', 'to'],
    },
    annotations: { title: 'Relate two items' },
  },
  {
    name: 'weir_listFacets', fn: 'listFacets',
    description: 'Glass catalog facets across the non-archived corpus: each facet → { total, terms:[{term,count}], omitted }, top terms by count (entity alone can be thousands). Facets: domain, entity, process, method, scale, spatial, temporal, form, provenance. Cataloged items contribute LLM facets; the rest contribute deterministic Stage-0 facets. Use facet+limit to drill into one.',
    inputSchema: {
      type: 'object', properties: {
        facet: { type: 'string', description: 'Limit to one facet (domain|entity|process|method|scale|spatial|temporal|form|provenance)' },
        limit: { type: 'integer', description: 'Top terms per facet by count (default 25, max 200)' },
        minCount: { type: 'integer', description: 'Only terms appearing at least this many times' },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, title: 'List weir facets' },
  },
  {
    name: 'weir_stacksList', fn: 'stacksList',
    description: 'List the STACKS — weir’s notes/files vault (authored markdown notes + dropped files, living as real files under /stacks/). Optional `path` scopes to a folder (recursively). Returns { count, folders:[…], entries:[{ id, path, uid, type:note|file, title, tags, missing, glass_id }] }. The `id` is a normal item id (stacks:<uid>) — pass it to weir_getItem/weir_catalogItem/weir_setState. Stacks entries are also queryable via weir_queryItems({ feed: "Stacks" }).',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Scope to a folder (recursive), e.g. "specs/weir"' }, limit: { type: 'integer', description: 'Max entries (default 200, cap 500)' } } },
    annotations: { readOnlyHint: true, idempotentHint: true, title: 'List the stacks' },
  },
  {
    name: 'weir_stacksRead', fn: 'stacksRead',
    description: 'Read one stacks entry by `path` (from weir_stacksList). For a note: returns its markdown body (capped 16k) + tags + metadata. For a file: metadata only (mime, no bytes). Returns { id, path, uid, type, title, tags, glass_id, markdown? , mime? }.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Entry path, e.g. "inbox/huffman.md"' } }, required: ['path'] },
    annotations: { readOnlyHint: true, title: 'Read a stacks entry' },
  },
  {
    name: 'weir_stacksWrite', fn: 'stacksWrite',
    description: 'Create OR update a stacks NOTE — "draft a note straight into the stacks". If `path` names an existing note, its body is updated (uid/created preserved); otherwise a new note is created. Address it with `path` (e.g. "specs/weir/idea.md") OR `folder`+`name`; bare folder defaults to inbox. `markdown` is the body (required); `title` and `tags` optional (tags stamped as yours-via-Claude). Link other holdings with [[uid]]. Returns { ok, id, path, uid, title, tags }. Files are dropped via Telegram or the app, not here.',
    inputSchema: {
      type: 'object', properties: {
        path: { type: 'string', description: 'Target path, e.g. "specs/weir/idea.md" (folder + filename)' },
        folder: { type: 'string', description: 'Folder (alternative to a full path); defaults to "inbox"' },
        name: { type: 'string', description: 'Filename (alternative to a full path)' },
        title: { type: 'string', description: 'Note title (defaults to the first heading / filename)' },
        markdown: { type: 'string', description: 'The note body (markdown)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to set' },
      }, required: ['markdown'],
    },
    annotations: { title: 'Write a stacks note' },
  },
  {
    name: 'weir_stacksMove', fn: 'stacksMove',
    description: 'Move/refile a stacks entry to another folder. Identity (uid) is preserved, so its tags, read-state, catalog card and inbound [[uid]] links ride along. Returns { ok, movedFrom, id, path, uid, title }.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Current entry path' }, toFolder: { type: 'string', description: 'Destination folder, e.g. "papers/kriging"' } }, required: ['path', 'toFolder'] },
    annotations: { title: 'Move a stacks entry' },
  },
  {
    name: 'weir_stacksTag', fn: 'stacksTag',
    description: "Add/remove tags on a stacks entry by `path`. Tags are stamped source:'llm' and mirrored into the note’s frontmatter / the file’s .meta.json sidecar (portable, Obsidian-readable). Returns the updated entry.",
    inputSchema: {
      type: 'object', properties: {
        path: { type: 'string', description: 'Entry path' },
        add: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
      }, required: ['path'],
    },
    annotations: { title: 'Tag a stacks entry' },
  },
  {
    name: 'weir_stacksTrash', fn: 'stacksTrash',
    description: 'Delete a stacks entry by `path` — but weir never really deletes: the file (+ sidecar) is moved into /stacks/.trash/ (a hidden folder the scanner ignores), so it disappears from weir while the bytes survive on disk, recoverable. Drops the index entry. Returns { ok, trashed, dest }.',
    inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'Entry path to delete' } }, required: ['path'] },
    annotations: { title: 'Delete a stacks entry', destructiveHint: true },
  },
];

// Register the tools on navigator.modelContext (polyfilled by the shim) and wire
// the bridge connection. Returns a small control api for the settings UI, or null
// if the shim isn't present. `fetch` should be gcuFetch (the bridge-brokered one).
export function initWebmcp({ store, app, fetch }) {
  if (typeof navigator === 'undefined' || !navigator.modelContext) return null;   // shim absent
  const mc = navigator.modelContext;
  const wm = (typeof window !== 'undefined') ? (window.gcuMCP || window.gcuWebMCP) : null;

  const tools = buildWeirTools({
    store,
    app,
    cardFacets: () => (app ? app._cardFacets : null),
    ensureCards: async () => { if (app && app.loadCardFacets && (!app._cardFacets || app._cardFacets.size === 0)) await app.loadCardFacets(); },
  });
  for (const t of TOOLS) {
    mc.registerTool({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations, execute: (input) => tools[t.fn](input || {}) });
  }

  if (wm) {
    wm.name = 'weir';
    wm.fetch = fetch;                       // route the HTTP transport through gcuFetch (public-origin/PNA)
    if (app && app.renderWebmcpStatus) wm.onStateChange = (s) => app.renderWebmcpStatus(s);
  }

  const read = () => { try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; } };
  const readFs = () => { try { return localStorage.getItem(LS_FS) || ''; } catch { return ''; } };
  const api = {
    available: !!wm,
    state: () => (wm ? wm.state : 'unavailable'),
    mode: () => (readFs() ? 'fs' : (read() ? 'socket' : 'none')),
    stored: read,
    storedFs: readFs,
    // localhost transport — a port:token string (ws/http via the bridge extension).
    connect(connStr) {
      const v = String(connStr || '').trim();
      if (!/^\d+:[0-9a-f]{8,}/i.test(v)) throw new Error('expected port:token (e.g. 7801:…)');
      try { localStorage.setItem(LS_KEY, v); localStorage.removeItem(LS_FS); } catch { /* private mode */ }
      if (wm) { wm.folder = null; wm.connect(v); }
    },
    // fs transport — a folder handle + a bare machine token (no port, no extension).
    // The CALLER persists the handle (saveHandle('webmcp-fs')); this stores the token
    // and drives the shim's fs path. See TRANSPORTS.md §6.1.
    connectFolder(handle, token) {
      const t = String(token || '').trim();
      if (!handle) throw new Error('pick a folder first');
      if (!t) throw new Error('a machine token is required (the bridge prints it: --transport fs --info)');
      if (!wm) throw new Error('the webmcp shim is not loaded');
      try { localStorage.setItem(LS_FS, t); localStorage.removeItem(LS_KEY); } catch { /* private mode */ }
      wm.folder = handle; wm.connect(t);
    },
    disconnect() { try { localStorage.removeItem(LS_KEY); localStorage.removeItem(LS_FS); } catch { /* ignore */ } if (wm) { wm.folder = null; wm.disconnect(); } },
  };

  // Auto-reconnect a SOCKET connection on load. The fs path reconnects from boot.js
  // instead — it needs the persisted folder handle + a permission re-grant gesture.
  const stored = read();
  if (wm && stored && !readFs()) { try { wm.connect(stored); } catch { /* bad stored string */ } }
  return api;
}
