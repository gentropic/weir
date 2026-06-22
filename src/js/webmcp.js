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
import { facetsOf, FACETS, buildCard } from './glass.js';
import { listModels } from './llm.js';
import { getKey } from './llmkeys.js';
import { formatItem, citeKey, buildBibliography } from './cite.js';

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
    added_by: it.added_by || undefined,   // provenance: the agent identity that ADDED this item (e.g. a book holding)
  };
  if (full) {
    o.archived = !!it.archived; o.route = it.route || undefined; o.glass_id = it.glass_id || undefined;
    o.excerpt = it.excerpt || undefined;
    if (it.tag_src && Object.keys(it.tag_src).length) o.tag_src = it.tag_src;   // tag → who applied it (human|agent|cataloger)
    if (it.tag_by && Object.keys(it.tag_by).length) o.tag_by = it.tag_by;       // tag → the agent identity that applied it
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

  // ── retrieval tuning (SPEC-retrieval-tuning): rank the curated minority over the feed
  // firehose, no ML — a post-hoc rescore of the lexical top-k by source-class + facet-match.
  // The corpus is ~80% auto-ingested feed/video; for a reference query the curated layer
  // (books, notes, repo docs, saved links) is the signal, the firehose the noise.
  // Default ranking weights (a commit-reviewed constant — the persistent policy). A
  // weir_search call may pass `weights` to override these PER CALL (ephemeral
  // experimentation — the librarian sweeps live during its eval, reports the winning set,
  // which then gets baked here). `facet` is the per-matched-term bonus increment.
  const DEFAULT_WEIGHTS = { curated: 2.5, saved: 1.4, neutral: 1.0, firehose: 0.6, facet: 0.2 };
  function curationTier(it) {
    if (!it) return 'neutral';
    if (it.type === 'book' || it.type === 'note' || it.type === 'doc') return 'curated';   // authored / owned
    const fid = it.feed_id || '';
    if (fid === 'stacks' || fid === 'books' || fid.startsWith('repo:')) return 'curated';
    // Saved Links are deliberate captures — a curation signal, but a NOISIER one (commerce
    // bookmarks creep in), so a softer tier than authored content (SPEC-retrieval-tuning
    // EVAL3 #2: shopping bookmarks were riding the full ×2.5 and topping geology queries).
    if (fid === 'saved') return 'saved';
    const ad = (store.getFeed(fid) || {}).adapter;
    if (ad === 'feed' || ad === 'youtube') return 'firehose';   // web-feed / video-platform = the firehose
    return 'neutral';
  }
  // The curated SCOPE (for curated:true) is the whole non-firehose curation layer — authored
  // content AND saved captures — even though `saved` carries a lower ranking weight.
  const isCuratedScope = (it) => { const tr = curationTier(it); return tr === 'curated' || tr === 'saved'; };
  // Multiplier on a lexical score: curation tier × facet-match (query terms ∈ the item's
  // facet terms — pulls the "the term is in the facets, not the title" recall into ranking).
  // NB recency is deliberately omitted: a reference corpus wants the canonical old source
  // (a 1963 paper) to keep ranking, not be demoted for age.
  function rankFactor(it, qTerms, w) {
    const W = w || DEFAULT_WEIGHTS;
    let f = W[curationTier(it)] != null ? W[curationTier(it)] : 1;
    if (qTerms.length) {
      const terms = new Set();
      const fc = facetsFor(it) || {};
      for (const k of Object.keys(fc)) for (const v of (fc[k] || [])) terms.add(String(v).toLowerCase());
      let hits = 0; for (const t of qTerms) if (terms.has(t)) hits++;
      if (hits) f *= 1 + (W.facet != null ? W.facet : 0.2) * Math.min(hits, 5);
    }
    return f;
  }

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

  // The agent provenance stamp for a write tool: the unified 'agent' tier + the calling
  // channel's identity (folder = identity, carried by the shim as client.identity).
  // SPEC-librarian §2. A null client (ws/http, or a local invoke) → a bare 'agent'.
  function agentProv(client) { return { source: 'agent', by: (client && client.identity) || 'agent' }; }
  // A rationale is a short human-facing blurb for the review queue — cap agent-supplied
  // values at the MCP boundary so a malformed/oversized call (e.g. a 4 KB escaped-JSON
  // blob) can't wall the queue (SPEC-repos-as-source-fixes #2). Returns undefined for empty.
  function clampRationale(s) { if (s == null) return undefined; const t = String(s).trim(); if (!t) return undefined; return t.length > 500 ? t.slice(0, 499) + '…' : t; }

  async function queryItems(input = {}) {
    const { cursor } = input;
    const limit = Math.min(Math.max(1, Number(input.limit) || 30), 100);
    const opts = buildQuery(input);   // no limit → full matching set; paged here with a keyset cursor
    // Stable total order: newest first, id as tie-breaker (so the cursor is exact
    // even when timestamps collide). Re-sort explicitly — don't rely on Map order.
    const pa = (r) => r.published_at || 0;
    const cmp = (a, b) => (pa(b) - pa(a)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    let rows = store.query(opts);
    // Provenance filters (the agent footprint): items the agent ADDED (added_by) or
    // TAGGED (some tag's tag_by). Pass `true` for any-agent, or an identity string to
    // scope to one (e.g. "claude:librarian"). Post-filtered — store.query has no such index.
    if (input.addedBy != null) { const v = input.addedBy === true ? null : String(input.addedBy); rows = rows.filter((r) => r.added_by && (v == null || r.added_by === v)); }
    if (input.taggedBy != null) { const v = input.taggedBy === true ? null : String(input.taggedBy); rows = rows.filter((r) => r.tag_by && Object.values(r.tag_by).some((b) => v == null || b === v)); }
    rows = rows.sort(cmp);
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
        if (c) {
          o.facets = c.facets; if (c.dublin_core && c.dublin_core.description) o.description = c.dublin_core.description;
          // card authorship (three-tier provenance): who cataloged (cataloger=provider:model),
          // who reviewed/authored (reviewer human|agent + by), and whether it's flagged.
          const g = c.glass || {};
          o.card = { cataloger: g.cataloger, reviewer: g.reviewer || undefined, by: g.by || undefined, confidence: g.confidence, needs_review: !!g.needs_review };
        }
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

  // Batch getItem — reference work fans out (one search → pull many cards); this saves
  // a round-trip storm (SPEC-reference-desk §3.3). Pass `ids`; unknown ids come back in
  // `missing`. With `content:true` each body is capped at 8k, so cap the batch tighter.
  async function getItems(input = {}) {
    const ids = [].concat(input.ids || []).map((x) => String(x)).filter(Boolean);
    if (!ids.length) throw new Error('pass `ids`: an array of item ids (from weir_search / weir_queryItems / weir_queryCatalog).');
    const cap = Math.min(ids.length, input.content ? 25 : 60);
    const items = []; const missing = [];
    for (const id of ids.slice(0, cap)) {
      try { items.push(await getItem({ id, content: input.content })); } catch { missing.push(id); }
    }
    const out = { count: items.length, items };
    if (missing.length) out.missing = missing;
    if (ids.length > cap) out.omitted = ids.length - cap;
    return out;
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

  // Faceted INTERSECTION query (GLASS §2 / SPEC-reference-desk §2.2): the Ranganathan
  // move — interdisciplinary material is found by intersecting facets, not by one shelf
  // or keyword. `facets` is a map facet→term(s); within a facet the terms UNION, across
  // facets they INTERSECT. Terms resolve against the controlled vocabulary (a synonym →
  // its preferred term); unknown / zero-hit terms are reported in `vocabularyNotes`
  // rather than silently missed (fail loud, GLASS §1). Optional `q` ANDs a ranked
  // full-text constraint (composes with search, §2.1). Read-only.
  async function queryCatalog(input = {}) {
    if (ensureCards) { try { await ensureCards(); } catch { /* fall back to Stage-0 */ } }
    const reqFacets = input.facets;
    if (!reqFacets || typeof reqFacets !== 'object' || Array.isArray(reqFacets) || !Object.keys(reqFacets).length) {
      throw new Error('pass `facets`: a map of facet → term(s), e.g. { domain: ["geostatistics"], entity: ["kriging","itabirite"] }. See weir_listFacets for terms, weir_vocab to resolve one.');
    }
    const limit = Math.min(Math.max(1, Number(input.limit) || 20), 100);
    const vocabularyNotes = [];

    // Normalize + vocab-resolve the requested terms (synonym → preferred term).
    const want = {};   // facet → Set<term> (union within a facet)
    for (const [facet, raw] of Object.entries(reqFacets)) {
      if (!FACETS.includes(facet)) { vocabularyNotes.push({ facet, note: `unknown facet — one of: ${FACETS.join(', ')}` }); continue; }
      const terms = [].concat(raw).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
      if (!terms.length) continue;
      const set = want[facet] || (want[facet] = new Set());
      const vocab = store.getVocab(facet);
      for (const t of terms) {
        if (store.getConcept(facet, t)) { set.add(t); continue; }   // already a preferred term
        let pref = null;
        for (const [k, c] of Object.entries(vocab)) if ((c.alt || []).includes(t)) { pref = k; break; }   // a synonym?
        if (pref) { set.add(pref); vocabularyNotes.push({ facet, input: t, resolvedTo: pref, note: 'non-preferred term → preferred form' }); }
        else { set.add(t); vocabularyNotes.push({ facet, input: t, note: 'not in the controlled vocabulary — matched literally' }); }
      }
    }
    if (!Object.keys(want).length) return { count: 0, total: 0, items: [], vocabularyNotes };

    // Intersect across facets over the live facet source (cataloged → card facets, else
    // deterministic Stage-0). Track which requested terms actually land a hit.
    const matched = {};   // facet → Set<term> that hit ≥1 item
    const noArchive = input.includeArchived === false;   // reference-desk default: include the archive
    const hits = [];
    for (const it of store.items.values()) {
      if (noArchive && it.archived) continue;
      const f = facetsFor(it);
      const why = {}; let ok = true;
      for (const [facet, set] of Object.entries(want)) {
        const vals = (f[facet] || []).filter((v) => set.has(String(v).toLowerCase()));
        if (!vals.length) { ok = false; break; }
        why[facet] = vals;
      }
      if (!ok) continue;
      for (const [facet, vs] of Object.entries(why)) { const s = matched[facet] || (matched[facet] = new Set()); for (const v of vs) s.add(String(v).toLowerCase()); }
      hits.push({ it, why });
    }

    // Optional free-text AND (compose with the ranked index, §2.1).
    let rows = hits;
    if (input.q) {
      const r = await search({ q: String(input.q), limit: 100 });
      const ids = new Set((r.items || []).map((x) => x.id));
      rows = rows.filter((h) => ids.has(h.it.id));
    }

    // Fail loud: any requested term that matched nothing in the intersection.
    for (const [facet, set] of Object.entries(want)) for (const t of set) {
      if (!(matched[facet] && matched[facet].has(t))) vocabularyNotes.push({ facet, term: t, note: 'matched 0 items in this intersection' });
    }

    const total = rows.length;
    const items = rows.slice(0, limit).map(({ it, why }) => {
      const o = projItem(store, it, false);
      o.matchedTerms = why;
      if (it.glass_id) o.glass_id = it.glass_id;
      o.facets = facetsFor(it);
      return o;
    });
    return { count: items.length, total, items, vocabularyNotes: vocabularyNotes.length ? vocabularyNotes : undefined };
  }

  // Verify a citation against a source (SPEC-reference-desk §3.2b) — strict-grounding's
  // self-check. Given an item `id` + a candidate `quote`, confirm the text actually
  // appears in that source and return a stable locator + surrounding context, or report
  // no-match so the agent can refuse to assert it. Whitespace is normalized before
  // matching (HTML/wrap noise ignored); falls back to case-insensitive. Read-only.
  async function quote(input = {}) {
    const id = input && input.id != null ? String(input.id) : null;
    const it = id && store.getItem(id);
    if (!it) throw new Error(`No item with id "${id}". Use weir_search/weir_queryItems to find ids.`);
    const cand = String(input.quote || '').trim();
    if (!cand) throw new Error('provide `quote` — the candidate text to verify against the source.');
    const ctx = Math.min(Math.max(0, Number(input.context) || 240), 1000);

    // Fullest available source text: full body when present, else title + excerpt.
    let body = '';
    if (it.has_content) { try { const html = await store.getContent(id); if (html) body = stripToText(html); } catch { /* unreadable */ } }
    const text = [it.title || '', body || it.excerpt || ''].filter(Boolean).join('\n\n');
    const norm = (s) => s.replace(/\s+/g, ' ').trim();   // collapse whitespace for robust matching
    const hay = norm(text);
    const needle = norm(cand);
    const base = { id: it.id, glass_id: it.glass_id || undefined };
    if (!needle) throw new Error('the quote is empty after normalization');

    let at = hay.indexOf(needle); let match = 'exact';
    if (at < 0) { at = hay.toLowerCase().indexOf(needle.toLowerCase()); match = 'case-insensitive'; }
    if (at < 0) {
      return { ...base, found: false, sourceChars: hay.length, note: 'no match — this quote is NOT in the source; do not assert it as grounded. Try a shorter/exact span, or re-check the id (weir_getItem returns the body).' };
    }
    const end = at + needle.length;
    return {
      ...base, found: true, match,
      locator: `${it.glass_id || it.id}#${at}-${end}`,   // stable char span in the normalized source
      quote: hay.slice(at, end),                          // the source's verbatim text (canonical casing/spacing)
      before: hay.slice(Math.max(0, at - ctx), at),
      after: hay.slice(end, end + ctx),
      sourceChars: hay.length,
    };
  }

  // Render a canonical citation for an item, or a batch (SPEC-citation-export) — the
  // companion to weir_quote (quote VERIFIES a span; cite RENDERS the reference). Single
  // mode with a `quote` folds verification in: returns { cited:false } and NO reference
  // if the quote isn't in the source, so a fabricated claim can't get a citation. Batch
  // (`ids`) returns per-item entries + a deduped bibliography with stable cite-keys.
  // Pure render over metadata weir already holds — never fabricates (reports `missing`).
  async function cite(input = {}) {
    const ids = Array.isArray(input.ids) ? input.ids.map(String) : (input.id != null ? [String(input.id)] : []);
    if (!ids.length) throw new Error('pass `id` (one item) or `ids` (a batch) — ids from weir_search / weir_queryItems / weir_queryCatalog');
    const ctxOf = (it) => ({ feed: store.getFeed(it.feed_id), card: it.glass_id ? store.cards.get(it.glass_id) : null });

    // single mode: optional verify-in (id + quote → the cited span + locator, or refuse)
    if (input.id != null && !Array.isArray(input.ids)) {
      const it = store.getItem(ids[0]);
      if (!it) throw new Error(`No item with id "${ids[0]}". Use weir_search/weir_queryItems to find ids.`);
      let locator = input.locator ? String(input.locator) : undefined;
      let verified;
      if (input.quote != null && String(input.quote).trim()) {
        const v = await quote({ id: it.id, quote: input.quote });
        if (!v.found) return { id: it.id, cited: false, note: v.note || 'the quote is NOT in this source — do not cite it as grounded.' };
        locator = v.locator; verified = v.quote;
      }
      const out = formatItem(it, { ...ctxOf(it), locator });
      return { id: it.id, ...out, ...(verified ? { cited: true, quote: verified, locator } : {}) };
    }

    // batch mode: per-item entries + an assembled bibliography with unique cite-keys
    const seen = new Set();
    const entries = []; const missingIds = [];
    for (const id of ids) {
      const it = store.getItem(id);
      if (!it) { missingIds.push(id); continue; }
      const ctx = ctxOf(it);
      const key = citeKey(it, { ...ctx, seen });
      entries.push({ id: it.id, ...formatItem(it, { ...ctx, key }) });
    }
    const style = input.style ? String(input.style) : 'footnotes';
    return { count: entries.length, entries, keys: Object.fromEntries(entries.map((e) => [e.id, e.key])), bibliography: buildBibliography(entries, style), ...(missingIds.length ? { missing: missingIds } : {}) };
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
  async function tag(input = {}, client) {
    const add = [].concat(input.add || []).filter(Boolean);
    const remove = [].concat(input.remove || []).filter(Boolean);
    if (!add.length && !remove.length) throw new Error('Provide tags to add and/or remove.');
    const p = agentProv(client);   // source 'agent' + identity (was the mislabeled 'llm')
    if (input.id != null) {   // single item
      const it = store.getItem(String(input.id));
      if (!it) throw new Error(`No item with id "${input.id}".`);
      for (const t of add) store.addTag(it.id, t, p.source, p.by);
      for (const t of remove) store.removeTag(it.id, t);
      await store.flush();
      if (app && app.renderStream) app.renderStream();
      return projItem(store, store.getItem(it.id), true);
    }
    // bulk over a query (same scope args as queryItems)
    const ids = store.query(buildQuery(input)).map((r) => r.id);
    if (!ids.length) return { matched: 0, changed: 0, add, remove };
    const changed = add.length ? store.addTagBulk(ids, add, p.source, p.by) : 0;
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
    const out = { glass_id: fresh.glass_id, ok: r.ok !== false, facets, description };
    if (r.skipped) { out.skipped = r.skipped; out.note = 'Too little real text to catalog without fabricating — left flagged needs_review, not guessed. Author the card yourself: weir_reviewItem({ id, description, facets }).'; }
    return out;
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
  // The UNIFIED review queue (SPEC-librarian §3): everything awaiting human attention,
  // tagged by `kind`. `catalog` = cataloger low-confidence cards (app-only); `feed` /
  // `relation` = agent structural proposals the agent added (decides-vs-proposes §2.1).
  // Each carries `ratifyWith` (the tool to act on it). Optional `kind` filter + limit.
  async function reviewQueue(input = {}) {
    if (app && ensureCards) { try { await ensureCards(); } catch { /* fall through */ } }
    const limit = Math.min(Math.max(1, Number(input.limit) || 30), 100);
    const kind = input.kind ? String(input.kind) : null;
    const items = []; const counts = { catalog: 0, feed: 0, relation: 0, book: 0 };

    // catalog half — cards the cataloger flagged low-confidence (app's review cache)
    const cr = (app && app._cardReview) || new Map();
    for (const [id, r] of cr) {
      if (!r || !r.needs_review) continue;
      counts.catalog++;
      if ((kind && kind !== 'catalog') || items.length >= limit) continue;
      const it = store.getItem(id); if (!it) continue;
      const o = projItem(store, it, false); o.kind = 'catalog'; o.confidence = r.confidence; o.ratifyWith = 'weir_reviewItem';
      const f = app._cardFacets && app._cardFacets.get(id); if (f) o.facets = f;
      items.push(o);
    }
    // proposal half — agent-added feeds, relation edges, and book holdings, not yet
    // ratified (store-level). `rationale` (why the agent proposed it) rides along.
    const prop = store.pendingProposals();
    for (const f of prop.feeds) {
      counts.feed++;
      if ((kind && kind !== 'feed') || items.length >= limit) continue;
      items.push({ kind: 'feed', id: f.id, title: f.name, url: f.url, category: f.category, by: f.by, rationale: f.rationale, ratifyWith: 'weir_ratify', ...(f.kind === 'repo' ? { repo: true, docs: f.docs, anchor: f.anchor } : {}) });
    }
    for (const e of prop.relations) {
      counts.relation++;
      if ((kind && kind !== 'relation') || items.length >= limit) continue;
      items.push({ kind: 'relation', from: e.from, to: e.to, type: e.type, by: e.by, rationale: e.rationale, title: `${e.fromTitle} —${e.type}→ ${e.toTitle}`, ratifyWith: 'weir_ratify' });
    }
    for (const b of prop.books) {
      counts.book++;
      if ((kind && kind !== 'book') || items.length >= limit) continue;
      items.push({ kind: 'book', id: b.id, title: b.title, by: b.by, rationale: b.rationale, tags: b.tags, ratifyWith: 'weir_ratify' });
    }
    counts.total = counts.catalog + counts.feed + counts.relation + counts.book;
    return { counts, count: items.length, items };
  }

  // Ratify or dismiss an agent STRUCTURAL proposal (decides-vs-proposes §2.1): a feed
  // the agent added, or a relation edge it proposed. ratify = bless it (stays, marked
  // ratified → leaves the queue); dismiss = undo it (remove the feed / unrelate the
  // edge). Catalog cards are confirmed via weir_reviewItem instead. The human's gate.
  async function ratify(input = {}) {
    const kind = String(input.kind || '').trim();
    const action = String(input.action || 'ratify').trim();
    if (!['ratify', 'dismiss'].includes(action)) throw new Error('action must be "ratify" or "dismiss"');
    if (kind === 'feed') {
      const id = String(input.feedId || input.id || '').trim();
      if (!id || !store.getFeed(id)) throw new Error(`no feed "${id}" — see weir_reviewQueue({ kind: "feed" }) / weir_listSources`);
      if (action === 'ratify') { const f = await store.ratifyFeed(id); await store.flush(); return { kind, action, id, ratified_at: f && f.ratified_at }; }
      await store.removeFeed(id); await store.flush(); if (app && app.renderRail) app.renderRail();   // dismiss = undo the un-ratified add
      return { kind, action: 'dismiss', id, removed: true };
    }
    if (kind === 'relation') {
      if (input.from == null || input.to == null) throw new Error('a relation proposal needs `from` and `to` (item ids or glass_ids) — see weir_reviewQueue({ kind: "relation" })');
      const from = await toGlassId(input.from), to = await toGlassId(input.to);
      const type = input.type ? String(input.type) : undefined;
      if (action === 'ratify') { const ok = store.ratifyEdge(from, to, type); await store.flush(); return { kind, action, from: String(input.from), to: String(input.to), ratified: ok }; }
      const removed = store.unrelateCards(from, to, type ? { type } : {}); await store.flush();
      return { kind, action: 'dismiss', from: String(input.from), to: String(input.to), removed };
    }
    if (kind === 'book') {
      const id = String(input.bookId || input.id || '').trim();
      const it = id && store.getItem(id);
      if (!it || it.type !== 'book') throw new Error(`no book "${id}" — see weir_reviewQueue({ kind: "book" })`);
      const r = store.ratifyBook(id, { dismiss: action === 'dismiss' }); await store.flush();
      if (app && app.renderStream) app.renderStream();
      return { kind, action, id, ratified_at: r && r.ratified_at, archived: action === 'dismiss' };
    }
    throw new Error('kind must be "feed", "relation", or "book" (catalog cards: confirm via weir_reviewItem)');
  }

  // Confirm / correct / AUTHOR a catalog card. Facets-only on an existing card =
  // confirm. With a `description` (and/or on an un-cataloged item) = AUTHOR: write the
  // card by hand, creating one if none exists — the fix for metadata-only holdings the
  // cataloger can only hallucinate (SPEC-librarian-authored-cards §1). Stamped agent
  // (reviewer:'agent' + identity) when called over MCP, else human (the UI).
  async function reviewItem(input = {}, client) {
    const it = input.id != null && store.getItem(String(input.id));
    if (!it) throw new Error(`No item with id "${input.id}".`);
    const reviewer = client ? 'agent' : 'human';
    const by = client ? (client.identity || 'agent') : undefined;
    const setLive = (card) => {
      if (app && app._cardFacets) app._cardFacets.set(it.id, card.facets);
      if (app && app._cardReview && app._cardReview.get(it.id)) app._cardReview.get(it.id).needs_review = false;
      if (app && app.renderReviewStatus) app.renderReviewStatus();
    };
    // AUTHOR path: a description was supplied, or the item has no card yet → write a
    // card by hand (base = the existing card, else a fresh Stage-0 one), no LLM.
    if (input.description != null || !it.glass_id) {
      const base = (it.glass_id && await store.getCard(it.glass_id)) || buildCard(it, store.getFeed(it.feed_id));
      const dc = { ...base.dublin_core };
      if (input.description != null) dc.description = String(input.description).trim() || undefined;
      const facets = (input.facets && typeof input.facets === 'object') ? { ...base.facets, ...input.facets } : base.facets;
      const card = { ...base, dublin_core: dc, facets, glass: { ...base.glass, document_ref: it.id, needs_review: false, reviewer, by, reviewed_at: Date.now(), confidence: 0.9 } };
      const glass_id = await store.writeCard(card);
      await store.flush();
      setLive(card);
      return { glass_id, reviewed: true, authored: true, description: card.dublin_core.description, facets: card.facets };
    }
    // CONFIRM path: an existing card, facets-only.
    const card = await store.markCardReviewed(it.glass_id, { facets: input.facets, reviewer, by });
    setLive(card);
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
  // Resolve an item ref — a glass_id, an item id, OR a stacks path (e.g. "gcu/README.md")
  // — to { item, glassId }. Lets notes/items join the graph by path or id, not only
  // glass_id (SPEC-stacks-first-class Part A).
  function resolveItemRef(ref) {
    const s = String(ref == null ? '' : ref);
    const card = s && store.cards.get(s);
    if (card) { const itId = card.glass && card.glass.document_ref; return { item: itId ? store.getItem(itId) : null, glassId: s }; }
    let it = store.getItem(s);
    if (!it) it = findStackByPath(s);   // human-friendly stacks path
    return { item: it || null, glassId: (it && it.glass_id) || null };
  }
  // Resolve a ref to a card's glass_id. With { create }, mint a Stage-0 card for an
  // uncataloged item (store.ensureCard) so it can be an edge endpoint — that's how a
  // note relates without a manual catalog step. Errors if uncataloged and !create.
  async function toGlassId(ref, opts = {}) {
    const { item, glassId } = resolveItemRef(ref);
    if (glassId && store.cards.get(glassId)) return glassId;
    if (item) { if (opts.create) return await store.ensureCard(item.id); throw new Error(`"${ref}" has no catalog card yet — relate it (auto-cards it) or catalog it first.`); }
    throw new Error(`"${ref}" — no such item, glass_id, or stacks path.`);
  }
  const itemRefOf = (gid) => { const c = store.cards.get(gid); return (c && c.glass && c.glass.document_ref) || gid; };

  // Read the graph around an item (or note, or stacks path): ratified edges (outgoing +
  // backlinks) + on-demand facet-overlap SUGGESTIONS — PLUS the soft [[wiki]]/annotation
  // link layer (the librarian's prose cross-references, navigable without ratification).
  // An uncataloged note has no ratified edges yet but still shows its wikilinks.
  async function relatedTo(input = {}) {
    const { item, glassId } = resolveItemRef(input.id);
    const out = { id: String(input.id) };
    if (glassId && store.cards.get(glassId)) {
      const r = store.relatedOf(glassId);
      const proj = (e) => ({ id: itemRefOf(e.glass_id), title: e.title, type: e.type, source: e.source });
      out.outgoing = r.outgoing.map(proj);
      out.backlinks = r.backlinks.map(proj);
      if (input.suggest !== false) {
        const limit = Math.min(Math.max(1, Number(input.limit) || 8), 25);
        out.suggested = store.proposeRelated(glassId, { limit }).map((p) => ({ id: itemRefOf(p.glass_id), title: p.title, score: p.score, shared: p.shared }));
      }
    } else {
      out.outgoing = []; out.backlinks = [];
      out.note = item ? 'not in the catalog graph yet (no card) — weir_relate auto-cards it, or weir_catalogItem to enrich.' : `"${input.id}" — no such item/card/stacks path.`;
    }
    if (item) { const wl = store.wikiLinksOf(item.id); if (wl.links.length || wl.backlinks.length) out.wikilinks = wl; }
    return out;
  }

  // Ratify (or remove) a typed edge between two items/notes — the decides-vs-proposes
  // gate (GLASS §2.1): a suggestion is only an edge once declared here. type ∈
  // RELATION_TYPES. Endpoints may be item ids, glass_ids, or stacks paths; an
  // uncataloged endpoint is auto-carded (Stage-0) so notes can relate freely.
  async function relate(input = {}, client) {
    if (input.remove) {
      let from, to;   // resolve without creating — nothing to remove if uncataloged
      try { from = await toGlassId(input.from); to = await toGlassId(input.to); }
      catch { return { removed: 0, from: String(input.from), to: String(input.to) }; }
      const removed = store.unrelateCards(from, to, input.type ? { type: String(input.type) } : {});
      await store.flush();
      return { removed, from: String(input.from), to: String(input.to) };
    }
    const from = await toGlassId(input.from, { create: true });
    const to = await toGlassId(input.to, { create: true });
    const p = agentProv(client);
    const edge = store.relateCards(from, to, { type: input.type || 'related', source: p.source, by: p.by, rationale: clampRationale(input.rationale) });
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
  const projFeed = (f, stats) => ({ id: f.id, name: f.name, url: f.url || undefined, adapter: f.adapter, category: f.category || '(ungrouped)', inbox: stats.byFeed[f.id] || 0, ...(f.config && f.config.kind === 'repo' ? { kind: 'repo', anchor: f.config.anchor } : {}), ...feedHealth(f) });
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
    if (ensureCards) { try { await ensureCards(); } catch { /* fall back to Stage-0 facets */ } }   // warm facets for the reranker
    const limit = Math.min(Math.max(1, Number(input.limit) || 20), 100);
    const idx = app && app.searchIndex;
    const scoped = input.feed || input.type || input.view || input.category !== undefined || input.unread !== undefined || input.saved !== undefined;
    // Reference-desk default: SEE THE ARCHIVE (never-delete; SPEC §2.1). The index now
    // holds archived items too; exclude them only when includeArchived === false.
    const noArchive = input.includeArchived === false;
    const curatedOnly = input.curated === true;                 // hard-scope to the curated tier (#4)
    const rerank = input.rerank !== false;                      // curation-aware ranking on by default (the reference desk)
    const explain = input.explain === true;                     // surface the raw lexical score + weights, to tune
    let qTerms = q.toLowerCase().split(/[^a-z0-9]+/i).filter((w) => w.length > 1);
    // Vocab-synonym query expansion (SPEC-retrieval-tuning #3.5): bridge curated synonyms /
    // cross-lingual pairs (kriging↔krigagem) lexically before any dense lane. On by default.
    let qStr = q, expandedWith;
    if (input.expand !== false) {
      const e = store.expandTerms(qTerms);
      if (Object.keys(e.added).length) { qTerms = e.terms; qStr = e.terms.join(' '); expandedWith = e.added; }
    }
    // ephemeral per-call weight override (experimentation; clamped, default stays the constant)
    let weights;
    if (input.weights && typeof input.weights === 'object') {
      const clamp = (v, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(0, Math.min(n, 10)) : d; };
      weights = { curated: clamp(input.weights.curated, DEFAULT_WEIGHTS.curated), saved: clamp(input.weights.saved, DEFAULT_WEIGHTS.saved), neutral: clamp(input.weights.neutral, DEFAULT_WEIGHTS.neutral), firehose: clamp(input.weights.firehose, DEFAULT_WEIGHTS.firehose), facet: clamp(input.weights.facet, DEFAULT_WEIGHTS.facet) };
    }
    if (idx && idx.ready) {
      const preds = [];
      if (scoped) { const allowed = new Set(store.query(buildQuery(input)).map((r) => r.id)); preds.push((id) => allowed.has(id)); }
      if (noArchive) preds.push((id) => { const it = store.getItem(id); return it && !it.archived; });
      if (curatedOnly) preds.push((id) => isCuratedScope(store.getItem(id)));
      const filter = preds.length ? (id) => preds.every((p) => p(id)) : undefined;
      // A reranker can only reorder what it sees — pull a larger pool, rescore, then slice.
      const poolK = rerank ? Math.min(Math.max(limit * 5, 50), 200) : limit;
      let hits = idx.search(qStr, { limit: poolK, filter }) || [];
      if (rerank) hits = hits.map((h) => { const it = store.getItem(h.id); return { ...h, lex: h.score, score: h.score * (it ? rankFactor(it, qTerms, weights) : 1) }; }).sort((a, b) => b.score - a.score);
      hits = hits.slice(0, limit);
      return {
        ranked: true, reranked: rerank || undefined,
        ...(expandedWith ? { expanded: expandedWith } : {}),   // query bridged via vocab synonyms — surfaced for transparency
        ...(explain && rerank ? { weights: weights || DEFAULT_WEIGHTS } : {}),
        count: hits.length,
        items: hits.map((h) => { const it = store.getItem(h.id); if (!it) return null; return { ...projItem(store, it, false), score: +Number(h.score).toFixed(3), ...(rerank ? { tier: curationTier(it) } : {}), ...(explain && rerank && h.lex != null ? { lex: +Number(h.lex).toFixed(3) } : {}), archived: it.archived || undefined }; }).filter(Boolean),
      };
    }
    let rows = store.query({ ...buildQuery(input), text: q });
    if (!noArchive && !scoped) { const seen = new Set(rows.map((r) => r.id)); for (const it of store.items.values()) if (it.archived && !seen.has(it.id) && (it.search_text || '').includes(q.toLowerCase())) rows.push(it); }   // fallback: fold archived in
    if (curatedOnly) rows = rows.filter((r) => isCuratedScope(r));
    rows = rows.slice(0, limit);
    return { ranked: false, count: rows.length, items: rows.map((r) => projItem(store, r, false)) };
  }

  // Subscribe to a feed (adapter auto-detected; an initial poll fires in the app).
  async function addFeed(input = {}, client) {
    if (!app) throw new Error('adding feeds is only available in the running app');
    const url = String(input.url || '').trim();
    if (!url) throw new Error('provide `url`');
    const matched = (app.adapters || []).find((a) => { try { return a.match(url); } catch { return false; } });
    const adapter = (matched && matched.name) || 'feed';
    const resolved = (matched && matched.resolveUrl && matched.resolveUrl(url)) || url;
    let host = url; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
    const name = input.name || (matched && matched.titleFor && matched.titleFor(url)) || host;
    const p = agentProv(client);   // mark who added it (the gap: feeds carried no provenance)
    const feed = await store.putFeed({ url: resolved, name, adapter, category: input.category || undefined, source: p.source, added_by: p.by, rationale: clampRationale(input.rationale) });
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

  async function stacksWrite(input = {}, client) {
    const stacks = requireStacks();
    if (input.markdown == null) throw new Error('provide `markdown` (the note body).');
    const tags = [].concat(input.tags || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    const path = input.path ? String(input.path).replace(/^\/+/, '') : null;
    const existing = path ? findStackByPath(path) : null;
    // Did the caller name a destination? (explicit folder, or a path WITH a folder.)
    // If not, the note falls to inbox/ by default — which we report, so the bare-path
    // default is never silent (SPEC-stacks-first-class Part B).
    const explicitDest = input.folder != null || !!(path && path.includes('/'));
    let rec;
    if (existing && existing.type === 'note') {
      rec = await stacks.saveNote(existing, String(input.markdown), { title: input.title, tags: tags.length ? tags : undefined });
    } else {
      let folder = input.folder, name = input.name;
      if (path) { const i = path.lastIndexOf('/'); if (folder == null) folder = i >= 0 ? path.slice(0, i) : 'inbox'; if (name == null) name = i >= 0 ? path.slice(i + 1) : path; }
      const wp = agentProv(client);
      rec = await stacks.writeNote({ folder: folder || 'inbox', name, title: input.title, markdown: String(input.markdown), tags, source: wp.source, addedBy: wp.by });
    }
    await store.flush();
    if (app.renderStacks) app.renderStacks();
    if (app.stackFilter && app.renderStream) app.renderStream();
    const dest = stkFolderOf(rec.path);
    const o = { ok: true, ...projStack(rec), folder: dest || '(root)' };
    if (!existing && !explicitDest && dest === 'inbox') {
      o.routedToInbox = true;
      o.note = 'no folder given — filed to inbox/ (triage). Pass `folder` (or a path that includes a folder) to file it directly; weir_stacksMove relocates an existing note.';
    }
    return o;
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

  async function stacksTag(input = {}, client) {
    const stacks = requireStacks();
    const item = findStackByPath(input.path);
    if (!item) throw new Error(`No stacks entry at "${input.path}".`);
    const add = [].concat(input.add || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    const remove = [].concat(input.remove || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    if (!add.length && !remove.length) throw new Error('provide tags to add and/or remove.');
    const p = agentProv(client);
    for (const t of add) store.addTag(item.id, t, p.source, p.by);
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

  // Partial edit of a note (find/replace, or append) — so a one-line change doesn't
  // rewrite the whole note. Exact-string match, unique unless replaceAll; explicit
  // errors (not-found / not-unique). Returns the updated note + its (capped) body.
  async function stacksEdit(input = {}) {
    const stacks = requireStacks();
    const item = findStackByPath(input.path);
    if (!item) throw new Error(`No stacks entry at "${input.path}". Use weir_stacksList to see paths.`);
    if (item.type !== 'note') throw new Error('weir_stacksEdit edits notes only (this entry is a file).');
    const rec = await stacks.editNote(item, { find: input.find, replace: input.replace, replaceAll: input.replaceAll, append: input.append });
    await store.flush();
    if (app.renderStacks) app.renderStacks();
    if (app.stackFilter && app.renderStream) app.renderStream();
    const body = await stacks.readNote(rec);
    return { ok: true, ...projStack(rec), markdown: body.length > 16000 ? body.slice(0, 16000) + '…' : body };
  }

  // Add owned/physical books to the holdings (the "Books" library). title + author,
  // plus optional isbn (→ Open Library enrichment fills gaps), series + seq (the
  // volume; series+seq keep a set TOGETHER and in volume order via the call number —
  // see callnumber.js), publish date, your tags, and DDC/LCC display codes. Reuses
  // the LibraryThing import path, so it's idempotent: re-adding a book UPDATES it
  // (matched by isbn or title) and never resets read/saved/tags. Batch via `books`,
  // or pass one book's fields inline. Returns { inserted, updated, books }.
  async function addBooks(input = {}, client) {
    if (!app || !app.importBooks) throw new Error('addBooks is only available in the running app');
    const list = Array.isArray(input.books) ? input.books : ((input.title || input.id) ? [input] : null);
    if (!list || !list.length) throw new Error('pass books:[{ title, author?, isbn?, series?, seq?, date?, tags?, ddc?, lcc? }] (or a single book inline)');
    const norm = list.map((b) => ({
      // `id` (an existing holding, e.g. "book:269049145" from the shelf list) UPDATES
      // that item in place; the import keys on lt_id, so strip the "book:" prefix.
      lt_id: b.id ? String(b.id).replace(/^book:/, '') : (b.lt_id != null ? String(b.lt_id) : undefined),
      title: String(b.title || '').trim(),
      author: b.author ? String(b.author).trim() : undefined,
      isbn: b.isbn ? String(b.isbn).replace(/[^0-9xX]/gi, '') : undefined,
      series: b.series ? String(b.series).trim() : undefined,
      seq: (b.seq != null && b.seq !== '' && Number.isFinite(Number(b.seq))) ? Number(b.seq) : undefined,
      date: b.date || undefined,
      tags: Array.isArray(b.tags) ? [...new Set(b.tags.map((t) => String(t).trim()).filter(Boolean))] : undefined,
      ddc: b.ddc || undefined, lcc: b.lcc || undefined,
      shelved: (b.shelved != null) ? !!b.shelved : undefined,
      rationale: clampRationale(b.rationale),   // why proposed (shown in the review queue)
    })).filter((b) => b.title || b.lt_id);   // NEW books need a title; an UPDATE (by id) does not — so { id, shelved:true } works
    if (!norm.length) throw new Error('pass new books with a title, or { id, … } to update an existing holding');
    // The import keys by lt_id (when targeting an existing holding) else by isbn||title;
    // a collision inside one batch would silently drop a book, so reject it up front
    // (a NEW series volume needs a per-VOLUME title or isbn; an UPDATE needs its id).
    const seen = new Map();
    for (const b of norm) {
      const k = (b.lt_id ? 'id:' + b.lt_id : (b.isbn || b.title)).toLowerCase();
      if (seen.has(k)) throw new Error(`two books share the dedup key "${k}" — give each a distinct title (e.g. include the volume), an isbn, or a distinct id`);
      seen.set(k, true);
    }
    const res = await app.importBooks(norm, 'manual', agentProv(client));   // stamp who added the holding
    return { inserted: res.inserted, updated: res.updated, books: norm.length };
  }

  // Save a link into weir's "Saved Links" (the same source the Telegram bot feeds) — so
  // you can save a URL directly, not only via Telegram. The link resolver follows
  // wrapped/short URLs + fetches title/excerpt/thumbnail gently in the background; it
  // catalogs like any item. Stamped source:agent + identity on a NEW save. Idempotent
  // (keyed by URL hash) — re-saving updates in place, never resets read/saved/tags.
  async function addLink(input = {}, client) {
    if (!app || !app.importLinks) throw new Error('addLink is only available in the running app');
    const list = Array.isArray(input.links) ? input.links : (input.url ? [input] : null);
    if (!list || !list.length) throw new Error('pass `url` (one link) or links:[{ url, title?, tags?, date? }]');
    const norm = list.map((l) => {
      const url = String(l.url || '').trim();
      if (!url) throw new Error('each link needs a `url`');
      return { url, title: l.title ? String(l.title) : undefined, date: l.date || undefined, tags: Array.isArray(l.tags) ? l.tags : undefined };
    });
    const res = await app.importLinks(norm, 'mcp', agentProv(client));
    return { inserted: res.inserted, updated: res.updated, links: norm.length };
  }

  // Ingest a repo's docs as a first-class source (SPEC-repos-as-source). weir does NOT
  // read the repo or run git — YOU (the agent, with the files + git) hand the docs in and
  // supply the commit `anchor`. First call creates the source (an agent proposal →
  // weir_reviewQueue); later calls refresh it. Refresh recipe: read the stored anchor
  // (weir_listSources surfaces it on the repo source), run `git diff --name-only
  // <anchor> HEAD -- <doc globs>` locally, then call this with only the CHANGED docs +
  // the new HEAD as `anchor` (+ `removed` for deleted paths). Idempotent (stable ids,
  // never resets read/saved/tags). Docs become `doc` items, searchable + relatable +
  // citable like any item; relate your dive-map (a stacks note) to them with weir_relate.
  async function ingestRepo(input = {}, client) {
    if (!app) throw new Error('ingestRepo is only available in the running app');
    if (input.repo == null || String(input.repo).trim() === '') throw new Error('provide `repo` (the repo name or path, e.g. "auditable" or "../auditable")');
    const docs = Array.isArray(input.docs) ? input.docs.slice() : [];
    const paths = Array.isArray(input.paths) ? input.paths : [];
    const removed = Array.isArray(input.removed) ? input.removed : [];
    if (!docs.length && !paths.length && !removed.length && input.anchor == null) throw new Error('pass `docs` (doc bodies), `paths` (read from the mounted repos folder), `removed` (paths to archive), and/or `anchor`');
    for (const d of docs) if (!d || !d.path) throw new Error('each doc needs a `path` (its path within the repo)');
    // `paths` (no verbatim conduit): weir reads each NAMED file from the read-only repos
    // mount — never the full text through the call, never walking the tree (fixes #5).
    const skipped = [];
    if (paths.length) {
      if (!app.readRepoDoc) throw new Error('repos folder not mounted — mount your GitHub folder (read-only) in Settings, or pass docs:[{markdown}]');
      const repoDir = String(input.repo).replace(/[\\/]+$/, '').replace(/^.*[\\/]/, '');   // basename
      for (const p of paths) {
        const path = typeof p === 'string' ? p : (p && p.path);
        if (!path) { skipped.push({ path: String(p), error: 'no path' }); continue; }
        let content;
        try { content = await app.readRepoDoc(repoDir, path); }
        catch (e) { skipped.push({ path, error: e.message }); continue; }
        if (content == null) { skipped.push({ path, error: 'not found in the mounted repo' }); continue; }
        docs.push({ path, markdown: content, title: (p && p.title) || undefined, url: (p && p.url) || undefined });
      }
    }
    const p = agentProv(client);
    const r = await store.ingestRepo({
      repo: String(input.repo),
      name: input.name ? String(input.name) : undefined,
      anchor: input.anchor != null ? String(input.anchor) : undefined,
      docs, removed,
      category: input.category ? String(input.category) : undefined,
      source: p.source, added_by: p.by, rationale: clampRationale(input.rationale),
    });
    await store.flush();
    if (app.renderAll) app.renderAll();
    return { ok: true, ...r, ...(skipped.length ? { skipped } : {}) };
  }

  // One-shot provenance normalization (SPEC-librarian §2): rewrite the agent's
  // historically-split stamps — tags 'llm', edges 'claude' — to the unified 'agent'
  // tier across the whole corpus. Idempotent; returns counts. A capability, not a
  // hand-fix (CLAUDE.md). Run once after the taxonomy lands; safe to re-run.
  // The agent's footprint — a current-state provenance lens (SPEC-librarian-provenance-view).
  // Defaults to the CALLING channel's identity; pass identity:'*' for any agent (the
  // cross-channel view). Read-only. NOT an audit log — see store.listMine: undone/corrected
  // contributions aren't recoverable (the stamps are attribution; the agent's memory holds
  // history, and reconciles it against this lens).
  async function listMine(input = {}, client) {
    const raw = input.identity != null ? String(input.identity) : ((client && client.identity) || undefined);
    const identity = (raw === '*' || raw === 'any') ? undefined : raw;
    const kinds = Array.isArray(input.kinds) ? input.kinds.map(String) : (input.kinds ? [String(input.kinds)] : undefined);
    const status = input.status ? String(input.status) : undefined;
    const r = store.listMine({ identity, kinds, status });
    const limit = Math.min(Math.max(1, Number(input.limit) || 100), 500);
    return { identity: identity || '(any agent)', counts: r.counts, count: Math.min(r.contributions.length, limit), contributions: r.contributions.slice(0, limit), ...(r.contributions.length > limit ? { omitted: r.contributions.length - limit } : {}) };
  }

  async function provenanceMigrate(input = {}) {
    const counts = store.migrateProvenance({ backfillBooks: input.backfillBooks });
    await store.flush();
    return { migrated: counts };
  }

  return { queryItems, getItem, getItems, search, listFacets, queryCatalog, quote, cite, listSources, addFeed, updateFeed, resolveLinks, resolverLog, reEnrich, setState, tag, unarchiveAll, catalogItem, catalogControl, reviewQueue, reviewItem, ratify, mergeFacetTerm, vocab, relateTerm, relatedTo, relate, works, listProviderModels, setCatalog, removeFeed, renameFeed, repoll, recover, addBooks, addLink, ingestRepo, listMine, provenanceMigrate, stacksList, stacksRead, stacksWrite, stacksEdit, stacksMove, stacksTag, stacksTrash };
}

// Tool schemas. Names are `weir_*` (MCP tool names are [A-Za-z0-9_-]; no dots) —
// the prefix namespaces weir's tools if its bridge is ever co-registered with
// another surface's in one Claude session.
const TOOLS = [
  {
    name: 'weir_queryItems', fn: 'queryItems',
    description: 'Search/list weir feed items, newest first. Filters: q (substring over title/excerpt/text), feed (a source by id OR name, e.g. "Saved Links"), category (folder name; "" = ungrouped), type (article|video|release|paper|status|track|podcast|commit|issue|note|doc), view (inbox|saved|archived), unread (bool), saved (bool), limit (default 30, max 100). PROVENANCE filters (the agent footprint): addedBy = items the agent ADDED (true = any agent, or an identity string like "claude:librarian"); taggedBy = items the agent TAGGED. Filters combine. Paginated: returns { count, total, hasMore, items, nextCursor }; page by passing nextCursor back with the SAME filters. Items are compact (id, title, url, feed, published, tags, added_by, excerpt). Use weir_listSources first to see feed/folder names.',
    inputSchema: {
      type: 'object', properties: {
        q: { type: 'string', description: 'Substring search over title/excerpt/text' },
        feed: { type: 'string', description: 'Scope to one source — its feed id or display name (e.g. "Saved Links")' },
        category: { type: 'string', description: 'Scope to one folder by name ("" = ungrouped)' },
        type: { type: 'string', description: 'Item type filter' },
        view: { type: 'string', enum: ['inbox', 'saved', 'archived'], description: 'Which view to scope to' },
        unread: { type: 'boolean', description: 'Only unread items' },
        saved: { type: 'boolean', description: 'Only saved (true) / only unsaved (false)' },
        addedBy: { description: 'Items the agent ADDED — true (any agent) or an identity string (e.g. "claude:librarian")' },
        taggedBy: { description: 'Items the agent TAGGED — true (any agent) or an identity string' },
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
    description: 'Subscribe to a feed by URL — adapter auto-detected (RSS/Atom/JSON Feed, YouTube channel, GitHub repo); an initial poll fires in the app. Optional `name` + `category` (folder). When YOU (Claude) add it, it is stamped source:agent + your identity and lands in weir_reviewQueue as a `feed` proposal for the user to ratify — pass `rationale` so they see WHY. Returns the created feed.',
    inputSchema: {
      type: 'object', properties: {
        url: { type: 'string', description: 'Feed or page URL to subscribe to' },
        name: { type: 'string', description: 'Display name (default: derived from the URL/adapter)' },
        category: { type: 'string', description: 'Folder to file it under' },
        rationale: { type: 'string', description: 'Why you are proposing this feed — shown in the review queue at ratify time' },
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
    description: "Get one weir item by id: glass facets + description (if cataloged), the card's `card` authorship block (cataloger=provider:model, reviewer human|agent, by=identity, needs_review), item provenance (`added_by`, plus `tag_src`/`tag_by` = who applied each tag), and its knowledge-graph edges — `links` (what its body links to via [[ref]], resolved to {ref,id,title}) and `backlinks` (items whose body links to it). Pass content:true to include the extracted article/note text (capped 8k).",
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'Item id (from weir_queryItems)' },
        content: { type: 'boolean', description: 'Include the extracted body text' },
      }, required: ['id'],
    },
    annotations: { readOnlyHint: true, title: 'Get a weir item' },
  },
  {
    name: 'weir_getItems', fn: 'getItems',
    description: 'BATCH weir_getItem — fetch many items at once (reference work fans out: one search → pull a dozen cards). Pass `ids` (from weir_search / weir_queryItems / weir_queryCatalog). Returns { count, items:[…same shape as weir_getItem], missing?:[ids not found], omitted? }. With content:true each body is capped at 8k so the batch is capped tighter (~25 vs ~60). Saves a round-trip storm vs. calling weir_getItem N times.',
    inputSchema: {
      type: 'object', properties: {
        ids: { type: 'array', items: { type: 'string' }, description: 'Item ids to fetch' },
        content: { type: 'boolean', description: 'Include each item\'s extracted body text (capped 8k each)' },
      }, required: ['ids'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, title: 'Get weir items (batch)' },
  },
  {
    name: 'weir_search', fn: 'search',
    description: 'RANKED full-text search (the librarian BM25 index) — relevance-ordered, better than weir_queryItems\'s substring `q` for "most relevant about X" on a large corpus. CURATION-AWARE by default: results are reranked so the curated minority (books, notes, repo `doc` items, saved links) outranks the auto-ingested feed/video firehose, with a bonus when the query matches an item\'s facet terms — for a reference query the curated layer is the signal (pass rerank:false for raw BM25, or curated:true to hard-scope to the curated tier only). Each hit carries its `tier` (curated|neutral|firehose) when reranked. VOCAB-SYNONYM EXPANSION is also on by default: a query term that is a controlled-vocabulary prefLabel/altLabel also matches its synonyms (the seeded cross-lingual pairs like kriging↔krigagem bridge lexically, no embeddings) — the response carries `expanded:{term→[synonyms]}` when it fires; pass expand:false for the literal query. SEES THE ARCHIVE by default (the standing corpus, never-delete) — hits carry `archived:true` when archived; pass includeArchived:false to limit to active. Optional scope filters (feed/type/category/view/unread/saved) narrow it like queryItems. Returns { ranked, reranked?, count, items:[…,score,tier?,archived?] } (ranked:false = index not ready, fell back to substring). Use queryItems to LIST a whole feed/folder; use search to FIND by relevance; use weir_queryCatalog to search WITHIN a facet set.',
    inputSchema: {
      type: 'object', properties: {
        q: { type: 'string', description: 'The search query' },
        feed: { type: 'string', description: 'Scope to a source (id or display name)' },
        category: { type: 'string', description: 'Scope to a folder ("" = ungrouped)' },
        type: { type: 'string', description: 'Scope to an item type (e.g. "doc" for repo/project docs)' },
        view: { type: 'string', enum: ['inbox', 'saved', 'archived'], description: 'Scope to a view' },
        unread: { type: 'boolean', description: 'Only unread' },
        saved: { type: 'boolean', description: 'Only saved' },
        curated: { type: 'boolean', description: 'Hard-scope to the curated tier only (books/notes/repo docs/saved links) — excludes the feed firehose' },
        rerank: { type: 'boolean', description: 'Curation-aware reranking (default true); pass false for raw BM25 relevance' },
        expand: { type: 'boolean', description: 'Vocab-synonym query expansion (default true): a query term that is a controlled-vocabulary prefLabel/altLabel also matches its synonyms — bridges curated + cross-lingual pairs (kriging↔krigagem) lexically. Pass false for the literal query. When it fires, the response carries `expanded:{term→[synonyms]}`.' },
        weights: { type: 'object', description: 'PER-CALL rerank weight override (ephemeral — for tuning; defaults are curated 2.5 / neutral 1.0 / firehose 0.6 / facet 0.2). Clamped 0–10. Sweep these against the eval queries, then report the winning set to bake as the default.', properties: { curated: { type: 'number' }, neutral: { type: 'number' }, firehose: { type: 'number' }, facet: { type: 'number', description: 'per-matched-facet-term bonus increment' } } },
        explain: { type: 'boolean', description: 'Surface the raw lexical `lex` score per hit + the `weights` used, so you can SEE why each item ranked where it did while tuning' },
        includeArchived: { type: 'boolean', description: 'Include archived items (default TRUE — the reference desk sees the whole archive; pass false to limit to active)' },
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
    name: 'weir_provenanceMigrate', fn: 'provenanceMigrate',
    description: 'One-shot cleanup: normalize the agent\'s historical authorship stamps to the unified `source:agent` tier — tags previously marked \'llm\' and relation edges marked \'claude\' (both meant Claude) become \'agent\'. Pass `backfillBooks` (an identity string, e.g. "claude:librarian") to ALSO repair agent-proposed book holdings whose `added_by` was stripped by the pre-fix makeItem bug — identified by their `web-proposed` tag — so they re-enter the review queue. Idempotent and safe to re-run; nothing is deleted. Returns { migrated: { tags, edges, books } }.',
    inputSchema: { type: 'object', properties: { backfillBooks: { type: 'string', description: 'Identity to stamp on web-proposed books missing added_by (e.g. "claude:librarian"); omit to skip the book backfill' } } },
    annotations: { title: 'Migrate / backfill provenance' },
  },
  {
    name: 'weir_addBook', fn: 'addBooks',
    description: 'Add OR update owned/physical books in the holdings (the "Books" library) — e.g. cataloging a real shelf, or stamping series/seq onto books already there. Each book: title (required), author, isbn (→ Open Library fills cover/date/publisher), series + seq (the volume number — series+seq keep a numbered set TOGETHER and in volume order on the shelf; without seq a series scatters by year), date, tags (yours), ddc/lcc (display codes). To UPDATE an existing holding in place, pass its `id` (e.g. "book:269049145", from the shelf list / weir_queryItems) — read/saved/tags and the catalog card are preserved, and `structured` is MERGED, so you only pass the fields you are changing (existing isbn/ddc/lcc/series/seq are kept; a plain LibraryThing re-import will not wipe a stamped series). Without an id a new book is created (keyed by isbn||title). Batch with `books:[…]` (preferred) or pass ONE book inline. A NEW book YOU add is stamped source:agent and surfaces in weir_reviewQueue as a `book` proposal (tag it `to-buy` for a wishlist item you don\'t own yet); pass `rationale` so the user sees why. Returns { inserted, updated, books }.',
    inputSchema: {
      type: 'object', properties: {
        books: {
          type: 'array', description: 'The books to add/update (batch).',
          items: {
            type: 'object', properties: {
              id: { type: 'string', description: 'Existing holding id to UPDATE in place (e.g. "book:269049145"); omit to create a new book' },
              title: { type: 'string', description: 'Book title (required for a NEW book; omit when updating an existing holding by id, e.g. a shelved-status write)' },
              author: { type: 'string', description: 'Author ("Surname, Given" or "Given Surname")' },
              isbn: { type: 'string', description: 'ISBN-10/13 (enables Open Library enrichment)' },
              series: { type: 'string', description: 'Series title for a numbered set (e.g. "YKK")' },
              seq: { type: 'number', description: 'Volume number within the series' },
              date: { type: 'string', description: 'Publication date (year or ISO date)' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Your tags (stamped as human; only applied when creating)' },
              ddc: { type: 'string', description: 'Dewey number (display metadata)' },
              lcc: { type: 'string', description: 'Library of Congress class (display metadata)' },
              shelved: { type: 'boolean', description: 'Physical-shelf status — round-trips with the shelf-list export’s "shelved" JSON; preloads the sheet checkboxes' },
              rationale: { type: 'string', description: 'Why you are proposing this book (e.g. a to-buy suggestion) — shown in the review queue; tag it "to-buy" for a wishlist item you don\'t own yet' },
            },
          },
        },
        id: { type: 'string', description: 'Shortcut: update a single existing holding by id' },
        title: { type: 'string', description: 'Shortcut: add/update a single book by its title (with the same sibling fields)' },
        author: { type: 'string' }, isbn: { type: 'string' }, series: { type: 'string' }, seq: { type: 'number' },
        date: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, ddc: { type: 'string' }, lcc: { type: 'string' },
      },
    },
    annotations: { title: 'Add/update book(s) in holdings' },
  },
  {
    name: 'weir_addLink', fn: 'addLink',
    description: 'Save a link into weir\'s "Saved Links" — the same source the Telegram bot feeds, so you can save a URL directly (not only via Telegram). Pass `url` (one link) or `links:[{ url, title?, tags?, date? }]`. The background resolver follows wrapped/shortened URLs and fetches title/excerpt/thumbnail over time; it then catalogs like any item. Idempotent (keyed by URL hash) — re-saving updates in place and never resets read/saved/tags. A NEW save is stamped source:agent + your identity (its tags too); a re-import of an existing link is not relabeled. Returns { inserted, updated, links }.',
    inputSchema: {
      type: 'object', properties: {
        url: { type: 'string', description: 'A single link URL to save' },
        title: { type: 'string', description: 'Optional title (else derived from the host; the resolver may improve it)' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags to apply (stamped as yours-via-agent)' },
        date: { type: 'string', description: 'Optional publish date (ISO or year)' },
        links: { type: 'array', description: 'Batch: [{ url, title?, tags?, date? }] (preferred over a single url for many)', items: { type: 'object', properties: { url: { type: 'string' }, title: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, date: { type: 'string' } }, required: ['url'] } },
      },
    },
    annotations: { title: 'Save a link' },
  },
  {
    name: 'weir_ingestRepo', fn: 'ingestRepo',
    description: 'Ingest a code repo’s own DOCS as a first-class source (SPEC-repos-as-source) — so the GCU constellation becomes a queryable subgraph in weir. weir never runs git; YOU (with the files + git) decide WHAT to ingest. `repo` = the repo name/path (e.g. "auditable"). `anchor` = the commit SHA these docs are from. TWO ways to supply content: (a) **`paths`** = [path strings, or { path, title?, url? }] — weir reads each NAMED file from the read-only repos folder you mounted in Settings (no full text through this call; the way to ingest at fidelity without a verbatim conduit); (b) **`docs`** = [{ path, title?, markdown, url?, date? }] — you pass the body inline (use for a gitignored/untracked file like CLAUDE.md, or when no folder is mounted). Mix both. README/SPEC/docs/CLAUDE.md — docs, NOT code. First call CREATES the source as a proposal (→ weir_reviewQueue, ratify like a feed); later calls REFRESH it (and can fix the name/category/rationale in place). REFRESH recipe: read the stored anchor from weir_listSources, run `git diff --name-only <anchor> HEAD -- <doc globs>` (+ `--diff-filter=D` for deletions) locally, then call this with only the changed `paths`/`docs` + the new HEAD as `anchor` + deleted paths in `removed`. Idempotent (stable ids; never resets read/saved/tags); `removed` archives (never deletes). Docs become `doc` items — searchable, quotable, relatable; relate your dive-map (a stacks note) to them with weir_relate. Returns { ok, source, inserted, updated, removed, anchor, skipped? }.',
    inputSchema: {
      type: 'object', properties: {
        repo: { type: 'string', description: 'The repo name or path (e.g. "auditable" or "../auditable") — the source key + mounted-folder dir is its basename' },
        name: { type: 'string', description: 'Display name for the source (default: "<repo> (repo)"); updatable on refresh' },
        anchor: { type: 'string', description: 'The commit SHA these docs are from — the dive-ledger anchor; advanced on each refresh' },
        paths: { type: 'array', description: 'Doc paths to READ from the mounted repos folder: ["README.md", …] or [{ path, title?, url? }]. No verbatim conduit — weir reads the named files itself.', items: {} },
        docs: { type: 'array', description: 'Docs with inline bodies: [{ path, title?, markdown, url?, date? }] — for gitignored/untracked files or when no folder is mounted', items: { type: 'object', properties: { path: { type: 'string' }, title: { type: 'string' }, markdown: { type: 'string' }, url: { type: 'string' }, date: { type: 'string' } }, required: ['path'] } },
        removed: { type: 'array', items: { type: 'string' }, description: 'Doc paths deleted since the anchor — archived (never deleted)' },
        category: { type: 'string', description: 'Folder to group the source under (default "repos"); updatable on refresh' },
        rationale: { type: 'string', description: 'Why you are adding this source — shown in the review queue; updatable on refresh (capped to a short blurb)' },
      }, required: ['repo'],
    },
    annotations: { title: 'Ingest a repo as a source' },
  },
  {
    name: 'weir_catalogItem', fn: 'catalogItem',
    description: 'Catalog one item with the configured LLM right now (fills its glass facets + description) — best for items with real body text. Returns glass_id, facets, description. On a metadata-only item (too little text to read, e.g. a book with no body/abstract) it ABSTAINS rather than fabricate: returns ok:false + skipped + a note, leaving it needs_review — author it yourself via weir_reviewItem({ id, description, facets }). Needs the cataloger configured and reachable (Lemonade via the bridge).',
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
    description: 'The UNIFIED review queue — everything awaiting human attention, tagged by `kind`: "catalog" = cataloger cards flagged low-confidence/unparseable (carry facets + confidence); "feed"/"relation"/"book" = things the agent ADDED (source:agent) not yet ratified — a feed, a relation edge, or a book holding (e.g. a to-buy suggestion). Each item carries the proposer `by` identity, a `rationale` (why), and `ratifyWith` — the tool to act on it: catalog → weir_reviewItem (confirm/correct), feed/relation/book → weir_ratify (bless or dismiss). Returns { counts:{catalog,feed,relation,book,total}, count, items }. Optional `kind` filters to one. This is the decides-vs-proposes gate: the agent proposes, you ratify here.',
    inputSchema: { type: 'object', properties: { kind: { type: 'string', enum: ['catalog', 'feed', 'relation', 'book'], description: 'Filter to one kind (default: all)' }, limit: { type: 'integer', description: 'Max items (default 30, cap 100)' } } },
    annotations: { readOnlyHint: true, title: 'Review queue' },
  },
  {
    name: 'weir_listMine', fn: 'listMine',
    description: 'Your footprint on the corpus — every contribution stamped by an agent identity, across kinds, with its ratification status. The provenance LENS for self-audit, the propose-vs-ratify ledger, and cross-channel coordination; pairs with weir_reviewQueue (which shows only the pending tray). Defaults to the CALLING channel\'s identity; pass identity:"*" for any agent (the cross-channel view), or a specific identity string. `kinds` filters to a subset of tag|note|edge|feed|book|catalog; `status` filters to one (pending|ratified|applied|authored|dismissed). Returns { identity, counts:{total, byKind, byStatus}, contributions:[{ kind, id, label, identity, status, … }] }. IMPORTANT: this is a CURRENT-STATE lens, not a history — contributions later undone or corrected by a human are NOT shown (weir\'s stamps are attribution; the undo paths erase them). It is the ground truth to reconcile your MEMORY against (memory says you added X but it is not here → your memory is stale). Read-only.',
    inputSchema: {
      type: 'object', properties: {
        identity: { type: 'string', description: 'Scope to an identity (default: the calling channel); "*" = any agent' },
        kinds: { type: 'array', items: { type: 'string', enum: ['tag', 'note', 'edge', 'feed', 'book', 'catalog'] }, description: 'Limit to these contribution kinds' },
        status: { type: 'string', description: 'Filter to one status: pending | ratified | applied | authored | dismissed' },
        limit: { type: 'integer', description: 'Max contributions (default 100, cap 500)' },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, title: 'List my contributions' },
  },
  {
    name: 'weir_ratify', fn: 'ratify',
    description: 'Ratify or dismiss an agent STRUCTURAL proposal from the review queue (decides-vs-proposes §2.1) — a feed the agent added, a relation edge it proposed, or a book holding it suggested. `action:"ratify"` blesses it (it stays, marked ratified, and leaves the queue); `action:"dismiss"` undoes it (feed → remove it + its just-polled items; relation → unrelate; book → archive it, non-destructive). For kind "feed" pass `feedId`; "book" pass `bookId`; "relation" pass `from` + `to` (+ optional `type`). Catalog cards are confirmed via weir_reviewItem instead, not here. Returns the action taken.',
    inputSchema: {
      type: 'object', properties: {
        kind: { type: 'string', enum: ['feed', 'relation', 'book'], description: 'What kind of proposal' },
        action: { type: 'string', enum: ['ratify', 'dismiss'], description: 'ratify = keep + bless; dismiss = undo (default ratify)' },
        feedId: { type: 'string', description: 'kind "feed": the proposed feed id (from weir_reviewQueue)' },
        bookId: { type: 'string', description: 'kind "book": the proposed book holding id' },
        from: { type: 'string', description: 'kind "relation": the source item id or glass_id' },
        to: { type: 'string', description: 'kind "relation": the target item id or glass_id' },
        type: { type: 'string', description: 'kind "relation": optionally scope to one edge type' },
      }, required: ['kind'],
    },
    annotations: { title: 'Ratify / dismiss a proposal' },
  },
  {
    name: 'weir_reviewItem', fn: 'reviewItem',
    description: 'Confirm, correct, or AUTHOR a catalog card. Facets-only on an existing card = confirm (clears needs_review). Pass a `description` (a precise one-sentence summary) to set the card\'s blurb by hand — and if the item has no card yet, this CREATES one (a deliberate "I know this item" add, e.g. a metadata-only book the cataloger can only hallucinate). Authored over MCP, the card is stamped source:agent + your identity. `facets` is an object of facet→string[] overwriting only the given facets (e.g. {"entity":["minecraft"],"scale":[]}). Pairs with weir_addBook → weir_reviewItem to land a pointed add fully formed.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'Item id (from weir_reviewQueue / weir_queryItems)' },
        description: { type: 'string', description: 'A precise one-sentence card summary to set by hand (creates the card if none exists)' },
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
    description: 'The knowledge graph around an item OR stacks note (GLASS §10): its ratified `related` edges — outgoing + backlinks — PLUS on-demand SUGGESTIONS (set suggest:false to skip) from facet co-occurrence, each carrying the shared facet terms (the "why") and a score, PLUS the soft `wikilinks` layer (resolved [[name]] cross-references + who annotates this, navigable without ratification). Pass an item id (from weir_queryItems), a glass_id, or a stacks PATH (e.g. "gcu/README.md"). An uncataloged note has no ratified edges yet but still shows its wikilinks. Suggestions/wikilinks are NOT edges until ratified via weir_relate.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'Item id, glass_id, or stacks path' },
        suggest: { type: 'boolean', description: 'Include facet-overlap suggestions (default true)' },
        limit: { type: 'integer', description: 'Max suggestions (default 8, cap 25)' },
      }, required: ['id'],
    },
    annotations: { readOnlyHint: true, title: 'Related items + suggestions' },
  },
  {
    name: 'weir_relate', fn: 'relate',
    description: 'Propose a typed `related` edge between two items or stacks notes — decides-vs-proposes (GLASS §2.1): a facet-overlap suggestion becomes a real edge ONLY when declared here. `from`/`to` are item ids, glass_ids, OR stacks paths (e.g. "gcu/README.md"); an uncataloged endpoint (e.g. a fresh note) is auto-carded at Stage-0 so it can join the graph — no manual catalog step needed. `type` ∈ related | same-topic | extends | contradicts | responds-to | same-work (default "related"). Pass `rationale` (why these relate) — it shows in weir_reviewQueue as a `relation` proposal until the user ratifies. Pass remove:true to delete the edge (optionally just one type). Stored on the from-item, stamped source:agent + your identity; reversible (weir never deletes the items).',
    inputSchema: {
      type: 'object', properties: {
        from: { type: 'string', description: 'Source item id / glass_id / stacks path' },
        to: { type: 'string', description: 'Target item id / glass_id / stacks path' },
        type: { type: 'string', description: 'related | same-topic | extends | contradicts | responds-to | same-work' },
        rationale: { type: 'string', description: 'Why these relate — shown in the review queue at ratify time' },
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
    name: 'weir_queryCatalog', fn: 'queryCatalog',
    description: 'Faceted INTERSECTION query over the catalog — the Ranganathan move: find interdisciplinary material by intersecting facets instead of one shelf or keyword. Pass `facets`, a map of facet → term(s): within a facet the terms UNION, across facets they INTERSECT — e.g. { domain:["geostatistics"], entity:["kriging","itabirite"], process:["estimation"] } = (geostatistics) AND (kriging OR itabirite) AND (estimation). Facets: domain, entity, process, method, scale, spatial, stance, form, provenance, temporal (weir_listFacets shows live terms). Terms resolve against the controlled vocabulary (a synonym → its preferred term); unknown or zero-hit terms come back in `vocabularyNotes` instead of silently missing. Optional `q` ANDs a ranked full-text constraint (composes with weir_search). Finds what excerpt/substring search cannot — e.g. entity:"itabirite" hits a cataloged item even when the word is not in its title. Read-only. Returns { count, total, items:[{ …, glass_id?, facets, matchedTerms }], vocabularyNotes? }.',
    inputSchema: {
      type: 'object', properties: {
        facets: { type: 'object', description: 'Map of facet name → term or [terms]. e.g. { domain: ["geostatistics"], entity: ["kriging","itabirite"] }. Union within a facet, intersect across facets.' },
        q: { type: 'string', description: 'Optional free-text to AND a ranked-search constraint (weir_search) onto the intersection' },
        includeArchived: { type: 'boolean', description: 'Include archived items (default TRUE — sees the whole archive; pass false to limit to active)' },
        limit: { type: 'integer', description: 'Max items (default 20, cap 100)' },
      }, required: ['facets'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, title: 'Faceted catalog query' },
  },
  {
    name: 'weir_quote', fn: 'quote',
    description: 'Verify a citation against a source — strict-grounding\'s self-check. Given an item `id` and a candidate `quote`, confirm the text actually appears in that source and get a stable locator + surrounding context (so you can cite it precisely, or REFUSE if it is not there). Whitespace is normalized before matching (HTML/wrapping ignored), with a case-insensitive fallback. Returns { found:true, locator:"<glass_id|id>#start-end", quote (the source\'s verbatim span), before, after, match } when present, or { found:false, note } when the quote is NOT in the source — in which case do not assert it as grounded. Read-only. Pair with weir_getItem (the body + citation chain) and weir_search/weir_queryCatalog (to find the id).',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'The item id to verify against (from weir_search / weir_queryItems / weir_queryCatalog)' },
        quote: { type: 'string', description: 'The candidate quote/claim text to locate in the source' },
        context: { type: 'integer', description: 'Chars of surrounding context to return on each side (default 240, max 1000)' },
      }, required: ['id', 'quote'],
    },
    annotations: { readOnlyHint: true, idempotentHint: true, title: 'Verify a quote' },
  },
  {
    name: 'weir_cite', fn: 'cite',
    description: 'Render a canonical, stable citation for an item — the companion to weir_quote (quote VERIFIES a span; cite RENDERS the reference). Pass `id` for one item, or `ids` for a batch. SINGLE mode: pass `quote` to fold verification in — you get `cited:true` + the verified verbatim span + a `glass_id#start-end` locator embedded in the reference, or `cited:false` (and NO reference) if the quote is not in the source, so a fabricated claim cannot get a citation. (Or pass a `locator` you already got from weir_quote to splice it without re-verifying.) Each citation comes in every form: `inline` "(Author year)", `reference` (a full reference-list line with a durable weir handle that survives a dead URL), `footnote` (markdown [^key]: …), `wikilink` ([[handle]] — a LIVE graph backlink once written into a stacks note), and `csl` (CSL-JSON for machine reuse), plus `missing` (essentials absent — cite what is known, never fabricate). BATCH mode (`ids`): returns per-item `entries`, a `keys` map (stable BibTeX-style cite-keys), and an assembled `bibliography` (markdown footnotes by default; `style:"numbered"|"plain"`). Read-only; pure render over metadata weir already holds.',
    inputSchema: {
      type: 'object', properties: {
        id: { type: 'string', description: 'One item id / glass_id to cite' },
        ids: { type: 'array', items: { type: 'string' }, description: 'Batch: item ids → entries + a deduped bibliography with cite-keys' },
        quote: { type: 'string', description: 'Single mode: a candidate quote to VERIFY + embed (refuses with cited:false if not in the source)' },
        locator: { type: 'string', description: 'Single mode: a weir_quote locator (glass_id#start-end) to splice in without re-verifying' },
        style: { type: 'string', description: 'Batch bibliography format: footnotes (default) | numbered | plain' },
      },
    },
    annotations: { readOnlyHint: true, idempotentHint: true, title: 'Cite an item' },
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
    description: 'Create OR update a stacks NOTE — "draft a note straight into the stacks". If `path` names an existing note, its body is updated (uid/created preserved); otherwise a new note is created. Address it with `path` (e.g. "specs/weir/idea.md") OR `folder`+`name`. If you give NO folder (bare name / bare path), the note is filed to inbox/ as triage and the result says so (routedToInbox:true) — pass `folder` (or a path that includes a folder) to file it directly. `markdown` is the body (required); `title` and `tags` optional (tags stamped as yours-via-Claude). Link other notes/holdings with [[uid]] or [[name]] (resolved by weir_relatedTo). For a one-line change, prefer weir_stacksEdit (find/replace/append) over rewriting the whole note here. Returns { ok, id, path, uid, title, tags, folder, routedToInbox? }. Files are dropped via Telegram or the app, not here.',
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
    name: 'weir_stacksEdit', fn: 'stacksEdit',
    description: 'Partial edit of a stacks NOTE — change one part without rewriting the whole note (the way the agent Edit tool works). Address it by `path`. Either replace text: `find` (the exact string to locate) + `replace` (its replacement; omit/empty to delete the text) — `find` must be UNIQUE unless you pass replaceAll:true. OR append: `append` (a block added to the end of the note). Exact-string match; errors are explicit (find-not-found / find-not-unique), never silent. Identity (uid/created) and source-stamp are preserved. Notes only (not files). Returns { ok, id, path, uid, title, tags, markdown }.',
    inputSchema: {
      type: 'object', properties: {
        path: { type: 'string', description: 'Entry path, e.g. "gcu/README.md"' },
        find: { type: 'string', description: 'Exact text to locate (must be unique unless replaceAll)' },
        replace: { type: 'string', description: 'Replacement for `find` (omit or empty string to delete it)' },
        replaceAll: { type: 'boolean', description: 'Replace every occurrence of `find` (default false → must be unique)' },
        append: { type: 'string', description: 'A block to append to the end of the note (alternative to find/replace)' },
      }, required: ['path'],
    },
    annotations: { title: 'Edit a stacks note' },
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
    mc.registerTool({ name: t.name, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations, execute: (input, client) => tools[t.fn](input || {}, client) });
  }

  if (wm) {
    wm.name = 'weir';
    wm.fetch = fetch;                       // route the HTTP transport through gcuFetch (public-origin/PNA)
    if (app && app.renderWebmcpStatus) wm.onStateChange = (s) => app.renderWebmcpStatus(s);
    if (app && app.renderWebmcpChannels) wm.onChannelState = () => app.renderWebmcpChannels();
  }

  const read = () => { try { return localStorage.getItem(LS_KEY) || ''; } catch { return ''; } };
  // fs-transport token storage, keyed by channel id. 'default' keeps LS_FS (back-compat);
  // extra channels (e.g. 'dev') get LS_FS + ':<id>'. Handle persistence mirrors it via
  // fsHandleKey. Multiple channels = multiple agents at once (SPEC-numen-multichannel.md).
  const fsKey = (id) => (id && id !== 'default') ? (LS_FS + ':' + id) : LS_FS;
  const readFs = (id) => { try { return localStorage.getItem(fsKey(id || 'default')) || ''; } catch { return ''; } };
  const defaultIdentity = (id) => (!id || id === 'default') ? 'claude:librarian' : ('claude:' + id);
  const KNOWN_FS = ['default', 'dev'];   // the supported channel ids (cap small, per spec §5)
  const api = {
    available: !!wm,
    state: () => (wm ? wm.state : 'unavailable'),
    mode: () => (readFs() ? 'fs' : (read() ? 'socket' : 'none')),
    stored: read,
    storedFs: readFs,                       // storedFs(id) → that channel's token ('default' if omitted)
    fsHandleKey: (id) => (id && id !== 'default') ? ('webmcp-fs-' + id) : 'webmcp-fs',   // no ':' — showDirectoryPicker id rejects it
    channels: () => (wm ? wm.channels : []),
    set onChannelState(fn) { if (wm) wm.onChannelState = fn; },
    // localhost transport — a port:token string (ws/http via the bridge extension).
    connect(connStr) {
      const v = String(connStr || '').trim();
      if (!/^\d+:[0-9a-f]{8,}/i.test(v)) throw new Error('expected port:token (e.g. 7801:…)');
      try { localStorage.setItem(LS_KEY, v); localStorage.removeItem(LS_FS); } catch { /* private mode */ }
      if (wm) { wm.folder = null; wm.connect(v); }
    },
    // fs transport — a folder handle + a bare machine token (no port, no extension).
    // opts.id names the channel ('default' = librarian; add e.g. 'dev'); opts.identity
    // is the agent label carried into tool dispatch (folder = identity, SPEC-librarian
    // §2). The CALLER persists the handle (saveHandle(fsHandleKey(id))). TRANSPORTS §6.1.
    connectFolder(handle, token, opts) {
      opts = opts || {};
      const id = opts.id || 'default';
      const t = String(token || '').trim();
      if (!handle) throw new Error('pick a folder first');
      if (!t) throw new Error('a machine token is required (the bridge prints it: --transport fs --info)');
      if (!wm) throw new Error('the webmcp shim is not loaded');
      try { localStorage.setItem(fsKey(id), t); localStorage.removeItem(LS_KEY); } catch { /* private mode */ }
      wm.addFolder({ id, handle, token: t, identity: opts.identity || defaultIdentity(id) });
    },
    disconnectFolder(id) {
      id = id || 'default';
      try { localStorage.removeItem(fsKey(id)); } catch { /* ignore */ }
      if (wm) wm.removeFolder(id);
    },
    disconnect() {
      try { localStorage.removeItem(LS_KEY); for (const id of KNOWN_FS) localStorage.removeItem(fsKey(id)); } catch { /* ignore */ }
      if (wm) { wm.folder = null; wm.disconnect(); }
    },
  };

  // Auto-reconnect a SOCKET connection on load. The fs path reconnects from boot.js
  // instead — it needs the persisted folder handle + a permission re-grant gesture.
  const stored = read();
  if (wm && stored && !readFs()) { try { wm.connect(stored); } catch { /* bad stored string */ } }
  return api;
}
