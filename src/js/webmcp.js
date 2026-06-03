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

  // Shared query builder — maps the tool args (q/feed/category/type/view/unread/
  // saved) to store.query opts. Reused by queryItems + tagItems so a bulk tag
  // scopes exactly like a list.
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

  // Add/remove tags on an item. Tags applied here are stamped source:'llm' (so the
  // UI can show who tagged what); the user's own tags are source:'human'. Searchable
  // + queryable immediately; feed the glass `entity` facet on the next catalog.
  async function tagItem(input = {}) {
    const it = input.id != null && store.getItem(String(input.id));
    if (!it) throw new Error(`No item with id "${input.id}".`);
    const add = [].concat(input.add || []).filter(Boolean);
    const remove = [].concat(input.remove || []).filter(Boolean);
    if (!add.length && !remove.length) throw new Error('Provide tags to add and/or remove.');
    for (const t of add) store.addTag(it.id, t, 'llm');
    for (const t of remove) store.removeTag(it.id, t);
    await store.flush();
    return projItem(store, store.getItem(it.id), true);
  }

  // Bring every archived item back to active (+ clear expiry so retention can't
  // re-shelve them). One-shot "I keep everything" restore. Reversible; no deletes.
  async function unarchiveAll() {
    const n = store.unarchiveAll();
    await store.flush();
    if (app && app.renderAll) app.renderAll();
    return { unarchived: n };
  }

  // Bulk-tag every item matching a query (the "tag all these search results" verb).
  // Same scope args as weir_queryItems (q/feed/category/type/view/unread/saved).
  // Tags are stamped source:'llm'. Returns how many items were matched/changed.
  async function tagItems(input = {}) {
    const add = [].concat(input.add || []).filter(Boolean);
    const remove = [].concat(input.remove || []).filter(Boolean);
    if (!add.length && !remove.length) throw new Error('Provide tags to add and/or remove.');
    const ids = store.query(buildQuery(input)).map((r) => r.id);
    if (!ids.length) return { matched: 0, changed: 0, add, remove };
    const changed = add.length ? store.addTagBulk(ids, add, 'llm') : 0;
    for (const id of ids) for (const t of remove) store.removeTag(id, t);
    await store.flush();
    if (app && app.renderStream) app.renderStream();
    return { matched: ids.length, changed, add, remove };
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

  return { queryItems, getItem, listFacets, listSources, resolveLinks, resolverLog, reEnrich, setState, tagItem, tagItems, unarchiveAll, catalogItem, catalogControl, reviewQueue, reviewItem, listProviderModels, setCatalog, stacksList, stacksRead, stacksWrite, stacksMove, stacksTag };
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
    name: 'weir_tagItem', fn: 'tagItem',
    description: "Add and/or remove tags on an item. Tags you apply here are stamped source:'llm' (the UI distinguishes them from the user's 'human' tags). Tags are immediately searchable + queryable (weir_queryItems can filter by them later) and feed the glass `entity` facet on the next catalog. Returns the updated item with its tag list.",
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'Item id (from weir_queryItems)' },
        add: { type: 'array', items: { type: 'string' }, description: 'Tags to add' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tags to remove' },
      }, required: ['id'],
    },
    annotations: { title: 'Tag an item' },
  },
  {
    name: 'weir_tagItems', fn: 'tagItems',
    description: "Bulk-tag every item matching a query — the \"tag all these search results\" verb. Scope with the SAME args as weir_queryItems (q, feed, category, type, view, unread, saved); add/remove are tag-name arrays. Tags are stamped source:'llm'. Returns { matched, changed }. Use weir_queryItems first to see how many you'll hit.",
    inputSchema: {
      type: 'object', properties: {
        q: { type: 'string', description: 'Substring over title/excerpt/text' },
        feed: { type: 'string', description: 'A source by id or display name' },
        category: { type: 'string', description: 'A folder name ("" = ungrouped)' },
        type: { type: 'string', description: 'Item type (article|video|paper|…)' },
        view: { type: 'string', enum: ['inbox', 'saved', 'archived'], description: 'Scope to a view' },
        unread: { type: 'boolean', description: 'Only unread' },
        saved: { type: 'boolean', description: 'Only saved' },
        add: { type: 'array', items: { type: 'string' }, description: 'Tags to add to every match' },
        remove: { type: 'array', items: { type: 'string' }, description: 'Tags to remove from every match' },
      },
    },
    annotations: { title: 'Bulk-tag a query' },
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
