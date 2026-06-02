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

const LS_KEY = 'weir-webmcp';   // localStorage "port:token" — origin-scoped, never in backups/FSA folder

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

  async function queryItems(input = {}) {
    const { q, type, view, unread, saved, cursor, category } = input;
    const limit = Math.min(Math.max(1, Number(input.limit) || 30), 100);
    const opts = {};   // no limit → full matching set; we page it here with a keyset cursor
    if (q) opts.text = String(q);
    if (type) opts.type = String(type);
    if (view) opts.view = String(view);
    if (input.feed) opts.feed_id = resolveFeedId(input.feed);
    if (category !== undefined) opts.category = String(category);   // '' = ungrouped
    if (unread === true) opts.read = false;
    if (saved !== undefined) opts.saved = !!saved;
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

  // Set item flags. All reversible — weir's "archived" archives, never deletes.
  async function setState(input = {}) {
    const it = input.id != null && store.getItem(String(input.id));
    if (!it) throw new Error(`No item with id "${input.id}".`);
    const patch = {};
    if (input.read !== undefined) patch.read = !!input.read;
    if (input.saved !== undefined) patch.saved = !!input.saved;
    if (input.archived !== undefined) patch.archived = !!input.archived;
    if (!Object.keys(patch).length) throw new Error('Provide at least one of: read, saved, archived.');
    store.setState(it.id, patch);
    return projItem(store, store.getItem(it.id), true);
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
    if (action === 'start') return app.catalogAll();
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
    if (!Object.keys(patch).length) throw new Error('nothing to set — pass provider/model/baseUrl/paceMs/maxBodyChars');
    await store.setSettings(patch);
    const s = store.getSettings();
    return { provider: s.catalog_provider, model: s.catalog_model, baseUrl: s.catalog_base_url || undefined, paceMs: s.catalog_pace_ms, maxBodyChars: s.catalog_max_body_chars, note: 'key unchanged (set it in the UI)' };
  }

  // The source tree — feeds grouped by folder, with inbox counts — so the model
  // can see what sources exist before drilling in with queryItems({ feed }).
  // Optional `category` scopes to one folder ('' = ungrouped).
  async function listSources(input = {}) {
    const stats = store.counts();   // { byFeed: { feed_id: inboxCount }, … }
    const onlyCat = input.category !== undefined ? String(input.category) : null;
    const folders = new Map();
    for (const f of store.listFeeds()) {
      const cat = f.category || '';
      if (onlyCat != null && cat !== onlyCat) continue;
      if (!folders.has(cat)) folders.set(cat, []);
      folders.get(cat).push({ id: f.id, name: f.name, adapter: f.adapter, inbox: stats.byFeed[f.id] || 0 });
    }
    const sources = [...folders.entries()]
      .map(([category, feeds]) => ({ category: category || '(ungrouped)', feeds: feeds.sort((a, b) => b.inbox - a.inbox || a.name.localeCompare(b.name)) }))
      .sort((a, b) => a.category.localeCompare(b.category));
    return { folders: sources.length, feedCount: store.listFeeds().length, sources };
  }

  // Kick the background link resolver — resolve wrapped saved links (share.google
  // etc.) to their real url + fetch thumbnail/title metadata, gently over time.
  async function resolveLinks() {
    if (!app || !app.linkResolver) throw new Error('resolveLinks is only available in the running app');
    app.linkResolver.kick();
    const st = app.linkResolver.status();
    return { kicked: true, pending: st.pending, running: st.running };
  }

  return { queryItems, getItem, listFacets, listSources, resolveLinks, setState, catalogItem, catalogControl, reviewQueue, reviewItem, listProviderModels, setCatalog };
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
    description: 'List weir’s sources (feeds) grouped by folder, each with its inbox item count — the source tree, so you can see what exists and then drill in with weir_queryItems({ feed }). Optional `category` scopes to one folder. Returns { folders, feedCount, sources: [{ category, feeds: [{ id, name, adapter, inbox }] }] }.',
    inputSchema: { type: 'object', properties: { category: { type: 'string', description: 'Only this folder ("" = ungrouped)' } } },
    annotations: { readOnlyHint: true, idempotentHint: true, title: 'List weir sources' },
  },
  {
    name: 'weir_resolveLinks', fn: 'resolveLinks',
    description: 'Kick the background resolver to process pending saved links now — resolve share.google/shortener URLs to their real destination and fetch thumbnail/title/excerpt metadata, gently over time (a couple every ~15s, so it never burst-hits the shortener). Returns { kicked, pending, running }. Imported links resolve on their own; use this to nudge it.',
    inputSchema: { type: 'object', properties: {} },
    annotations: { title: 'Resolve saved links' },
  },
  {
    name: 'weir_getItem', fn: 'getItem',
    description: "Get one weir item by id, including its glass catalog facets + description if cataloged. Pass content:true to include the extracted article text (capped at 8k chars).",
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'Item id (from weir_queryItems)' },
        content: { type: 'boolean', description: 'Include the extracted body text' },
      }, required: ['id'],
    },
    annotations: { readOnlyHint: true, title: 'Get a weir item' },
  },
  {
    name: 'weir_setState', fn: 'setState',
    description: "Mutate an item: set read / saved / archived (each a boolean; pass only the ones to change). All reversible — weir's archive never deletes. Returns the updated item.",
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'Item id (from weir_queryItems)' },
        read: { type: 'boolean', description: 'Mark read/unread' },
        saved: { type: 'boolean', description: 'Save/unsave (star)' },
        archived: { type: 'boolean', description: 'Archive/unarchive (non-destructive)' },
      }, required: ['id'],
    },
    annotations: { title: 'Set item state' },
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
      },
    },
    annotations: { title: 'Set cataloger config' },
  },
  {
    name: 'weir_catalogControl', fn: 'catalogControl',
    description: 'Start / stop / clear / inspect the catalog batch. action:"start" catalogs all un-cataloged non-archived items (paced, runs in the page); "stop" cancels; "clear" discards ALL cards + un-files every item (items/content/reading state untouched; reversible by re-cataloging) for a clean restart; "status" (default) reports running state, progress {total,done,failed}, and cataloged/total counts.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'stop', 'clear', 'status'], description: 'Default: status' } } },
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
];

// Register the tools on navigator.modelContext (polyfilled by the shim) and wire
// the bridge connection. Returns a small control api for the settings UI, or null
// if the shim isn't present. `fetch` should be gcuFetch (the bridge-brokered one).
export function initWebmcp({ store, app, fetch }) {
  if (typeof navigator === 'undefined' || !navigator.modelContext) return null;   // shim absent
  const mc = navigator.modelContext;
  const wm = (typeof window !== 'undefined') ? window.gcuWebMCP : null;

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
  const api = {
    available: !!wm,
    state: () => (wm ? wm.state : 'unavailable'),
    stored: read,
    connect(connStr) {
      const v = String(connStr || '').trim();
      if (!/^\d+:[0-9a-f]{8,}/i.test(v)) throw new Error('expected port:token (e.g. 7801:…)');
      try { localStorage.setItem(LS_KEY, v); } catch { /* private mode */ }
      if (wm) wm.connect(v);
    },
    disconnect() { try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ } if (wm) wm.disconnect(); },
  };

  const stored = read();
  if (wm && stored) { try { wm.connect(stored); } catch { /* bad stored string */ } }
  return api;
}
