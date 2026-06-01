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

  async function queryItems(input = {}) {
    const { q, type, view, unread, saved, cursor } = input;
    const limit = Math.min(Math.max(1, Number(input.limit) || 30), 100);
    const opts = {};   // no limit → full matching set; we page it here with a keyset cursor
    if (q) opts.text = String(q);
    if (type) opts.type = String(type);
    if (view) opts.view = String(view);
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
    if (action === 'status') {
      const st = app.catalogStatus ? app.catalogStatus() : { running: false };
      return { ...st, cataloged: await store.catalogCount(), total: store.items.size };
    }
    throw new Error('action must be one of: start | stop | status');
  }

  return { queryItems, getItem, listFacets, setState, catalogItem, catalogControl };
}

// Tool schemas. Names are `weir_*` (MCP tool names are [A-Za-z0-9_-]; no dots) —
// the prefix namespaces weir's tools if its bridge is ever co-registered with
// another surface's in one Claude session.
const TOOLS = [
  {
    name: 'weir_queryItems', fn: 'queryItems',
    description: 'Search/list weir feed items, newest first. Filters: q (substring over title/excerpt/text), type (article|video|release|paper|status|track|podcast|commit|issue|note), view (inbox|saved|archived), unread (bool), saved (bool), limit (default 30, max 100). Paginated: returns { count, total, hasMore, items, nextCursor }. To page, pass nextCursor back with the SAME filters. Items are compact (id, title, url, feed, published, tags, excerpt).',
    inputSchema: {
      type: 'object', properties: {
        q: { type: 'string', description: 'Substring search over title/excerpt/text' },
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
    name: 'weir_catalogControl', fn: 'catalogControl',
    description: 'Start / stop / inspect the background catalog batch. action:"start" catalogs all un-cataloged non-archived items (paced, runs in the page); "stop" cancels; "status" (default) reports running state, progress {total,done,failed}, and cataloged/total counts.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'stop', 'status'], description: 'Default: status' } } },
    annotations: { title: 'Control cataloging' },
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
