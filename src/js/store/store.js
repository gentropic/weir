// The store — weir's only shared mutable surface (SPEC §1). Built on the
// vendored VFS so the backend is swappable: IndexedDB by default, FSA when the
// user mounts a directory, memory for tests. Everything is files; the queryable
// index lives in memory, hydrated at startup from compact per-feed shards
// (NOT IndexedDB-native compound indexes — see CLAUDE.md).
//
// On-disk layout (identical on every backend, so OPFS/FSA is a pure swap):
//   /meta.json                         schema version
//   /settings.json /tags.json /routing.js
//   /archived_index.ndjson             tombstones (resurrection guard, SPEC §5)
//   /feeds/<feedKey>.json              one Feed record per file
//   /items/<feedKey>.ndjson            metadata shard: one Item (sans content) per line
//   /content/<feedKey>/<itemKey>.html  sanitized body, lazy-loaded

import { VFS } from '../../../vendor/vfs.js';
import {
  SCHEMA_VERSION, DEFAULT_SETTINGS, DEFAULT_VIEWS, makeItem, makeFeed, makeTombstone,
  fsKey, hash32, slugify, simhash, hamming64, deriveExcerpt, deriveTitle, deriveSearchText, computeExpiry, now,
} from './schema.js';
import { buildCard, nextGlassId, RELATION_TYPES, TOPICAL_FACETS, sharedTopicalTerms, relatednessScore } from '../glass.js';
import { inputMultiplier } from '../llm.js';
import { channelIdOf } from '../affinity.js';

const FLUSH_DELAY_MS = 250;
const CONTENT_CACHE_MAX = 12;   // per-feed content packs kept in memory (LRU); each holds one feed's bodies

export class Store {
  constructor(vfs) {
    this.vfs = vfs;
    this.feeds = new Map();          // id → Feed
    this.items = new Map();          // id → Item metadata record (no content)
    this.byFeed = new Map();         // feed_id → Set<item id>
    this.archived = new Set();       // tombstoned item ids (pruned/expired)
    this.tombstones = [];            // ArchiveRecord[]
    this.tags = {};                  // name → Tag
    this.savedViews = [];            // smart views (saved item filters); see DEFAULT_VIEWS
    this.settings = { ...DEFAULT_SETTINGS };
    this.router = null;              // optional Router; applied to new items on insert
    this.notifications = [];         // items a rule flagged notify:true (ephemeral)
    this.cards = new Map();          // glass_id → catalog card (in-memory; persisted as bucketed shards)
    this.vocab = {};                 // facet → { term → SKOS concept {alt,broader,narrower,related} } (controlled vocabulary / thesaurus, GLASS §7; one /schema/vocab/<facet>.json each)
    this._dirtyFeeds = new Set();
    this._dirtyCards = new Set();     // card-shard buckets needing a rewrite
    this._dirtyVocab = new Set();     // facet vocab files needing a rewrite
    this._contentShards = new Map();  // feedId → Map<fsKey(itemId), html>: lazily-loaded per-feed content packs
    this._dirtyContent = new Set();   // feedIds whose content pack needs a rewrite
    this._contentLRU = [];            // feedIds in load order, for cache eviction
    this._archivedDirty = false;
    this._ensured = new Set();       // dirs already mkdir'd
    this._listeners = new Map();
    this._flushTimer = null;
  }

  static async open(opts = {}) {
    const vfs = await VFS.create(opts.backend);   // undefined → memory; {type:'idb',name} → IDB
    const store = new Store(vfs);
    await store._hydrate();
    return store;
  }

  // ── events ──
  on(ev, fn) { (this._listeners.get(ev) || this._listeners.set(ev, new Set()).get(ev)).add(fn); return () => this.off(ev, fn); }
  off(ev, fn) { this._listeners.get(ev)?.delete(fn); }
  emit(ev, data) { this._listeners.get(ev)?.forEach((fn) => { try { fn(data); } catch (e) { console.error('listener error', e); } }); }

  // ── path helpers ──
  feedKey(feedId) { return fsKey(feedId); }
  _shardPath(feedId) { return `/items/${this.feedKey(feedId)}.ndjson`; }
  _feedPath(feedId) { return `/feeds/${this.feedKey(feedId)}.json`; }
  _contentDir(feedId) { return `/content/${this.feedKey(feedId)}`; }
  _contentPath(feedId, itemId) { return `${this._contentDir(feedId)}/${fsKey(itemId)}.html`; }   // legacy per-item file (pre-pack; read only by migration)
  _contentShardPath(feedId) { return `/content/${this.feedKey(feedId)}.ndjson`; }                 // per-feed content pack
  _feedSet(feedId) { let s = this.byFeed.get(feedId); if (!s) this.byFeed.set(feedId, s = new Set()); return s; }

  // ── low-level fs ──
  async _ensureDir(d) { if (this._ensured.has(d)) return; await this.vfs.mkdir(d, { recursive: true }); this._ensured.add(d); }
  async _readText(p, fallback = '') {
    try { return await this.vfs.readFile(p, 'utf8'); }
    catch (e) { if (e && e.code === 'ENOENT') return fallback; throw e; }
  }
  async _readJSON(p, fallback) {
    const t = await this._readText(p, null);
    if (t == null || t === '') return fallback;
    try { return JSON.parse(t); } catch { return fallback; }
  }

  // Bounded-concurrency map — overlaps IndexedDB reads (the boot hydrate read hundreds of
  // shards one at a time, which was the slow-boot bottleneck). IDB serializes internally; JS
  // is single-threaded so the Map writes inside the callbacks are race-free.
  async _pool(items, fn, c = 16) {
    for (let i = 0; i < items.length; i += c) await Promise.all(items.slice(i, i + c).map(fn));
  }

  // ── hydrate ──
  async _hydrate() {
    for (const d of ['/feeds', '/items', '/content']) await this._ensureDir(d);

    if (!(await this._readJSON('/meta.json', null))) {
      await this.vfs.writeFile('/meta.json', JSON.stringify({ schema: SCHEMA_VERSION, created: now() }, null, 2));
    }
    this.settings = { ...DEFAULT_SETTINGS, ...(await this._readJSON('/settings.json', {})) };
    if (!this.settings.sync_instance_id) {   // per-device id for sync state-deltas (SYNC.md 2e) — generate once, device-local
      this.settings.sync_instance_id = (globalThis.crypto?.randomUUID?.() || String(Math.random()).slice(2)).slice(0, 12);
      await this.vfs.writeFile('/settings.json', JSON.stringify(this.settings, null, 2));
    }
    this.tags = await this._readJSON('/tags.json', {});

    // Smart views — seed the type defaults on first run; persisted thereafter
    // (so deletions stick and aren't re-seeded).
    const storedViews = await this._readJSON('/views.json', null);
    if (storedViews && Array.isArray(storedViews)) {
      this.savedViews = storedViews;
      // One-time: introduce the built-in Links view on installs that predate it.
      // Guarded by a flag so a user who deletes it doesn't get it re-added.
      if (!this.settings.links_view_seeded) {
        if (!this.savedViews.find((v) => v.id === 'v-links')) {
          const def = DEFAULT_VIEWS.find((v) => v.id === 'v-links');
          const at = this.savedViews.findIndex((v) => v.id === 'v-articles');
          this.savedViews.splice(at >= 0 ? at + 1 : this.savedViews.length, 0, { ...def });
          await this.vfs.writeFile('/views.json', JSON.stringify(this.savedViews, null, 2));
        }
        this.settings.links_view_seeded = true;
        await this.vfs.writeFile('/settings.json', JSON.stringify(this.settings, null, 2));
      }
    } else {
      this.savedViews = DEFAULT_VIEWS.map((v) => ({ ...v }));
      this.settings.links_view_seeded = true;   // fresh install already includes it
      await this.vfs.writeFile('/views.json', JSON.stringify(this.savedViews, null, 2));
    }

    for (const line of (await this._readText('/archived_index.ndjson')).split('\n')) {
      if (!line.trim()) continue;
      try { const t = JSON.parse(line); this.tombstones.push(t); this.archived.add(String(t.id)); } catch { /* skip bad line */ }
    }

    let feedFiles = [];
    try { feedFiles = await this.vfs.readdir('/feeds'); } catch { /* empty */ }
    await this._pool(feedFiles.filter((f) => f.endsWith('.json')), async (f) => {
      const feed = await this._readJSON(`/feeds/${f}`, null);
      if (feed && feed.id) { this.feeds.set(feed.id, makeFeed(feed)); this._feedSet(feed.id); }
    });
    await this._pool([...this.feeds.keys()], (fid) => this._loadShard(fid));
    await this._loadCatalog();
    await this._loadVocab();
    this._migrateContent().catch((e) => console.error('content migration', e));   // BACKGROUND (not awaited): legacy per-item files → packs. getContent falls back to the legacy file meanwhile, so boot never freezes on it.
  }

  // Re-read the whole store from the VFS, replacing the in-memory index. Used after a sync
  // PULL writes files underneath us (SYNC.md): the files are authoritative, so we drop the
  // in-memory state — and any pending debounced flush (the sync caller flushes BEFORE
  // pulling, so nothing unsaved is lost) — and re-hydrate. Emits so the UI + search refresh.
  async reload() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    this.feeds.clear(); this.items.clear(); this.byFeed.clear(); this.archived.clear();
    this.tombstones = []; this.tags = {}; this.savedViews = []; this.cards.clear(); this.vocab = {};
    this._dirtyFeeds.clear(); this._dirtyCards.clear(); this._dirtyVocab.clear(); this._archivedDirty = false;
    this._contentShards.clear(); this._dirtyContent.clear(); this._contentLRU = [];
    this._ensured.clear();
    await this._hydrate();
    this.emit('feeds', { reload: true });
    this.emit('items', { reload: true });
  }

  // Controlled-vocabulary / thesaurus store (GLASS §7), SKOS-shaped from the start
  // so it's a standard (exportable as JSON-LD, seedable from published SKOS) rather
  // than a bespoke format we'd have to migrate. One file per facet under
  // /schema/vocab/. A concept is keyed by its preferred term (skos:prefLabel) and
  // holds { alt: [skos:altLabel/UF], broader: [BT], narrower: [NT], related: [RT] }.
  async _loadVocab() {
    let files = [];
    try { files = await this.vfs.readdir('/schema/vocab'); } catch { return; }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const facet = f.replace(/\.json$/, '');
      const v = await this._readJSON(`/schema/vocab/${f}`, null);
      if (v && typeof v === 'object') {
        const { clean, changed } = this._sanitizeVocab(v.concepts || v);   // self-heal malformed terms (e.g. a stringified-array target)
        this.vocab[facet] = clean;
        if (changed) this._markVocabDirty(facet);
      }
    }
  }
  // A valid term is a plain label — never JSON punctuation. Drop malformed concept
  // keys and relation targets (defends the vocab against a bad write upstream).
  _sanitizeVocab(concepts) {
    const bad = (s) => typeof s !== 'string' || /[\[\]"{}]/.test(s);
    const clean = {}; let changed = false;
    for (const [term, c] of Object.entries(concepts || {})) {
      if (bad(term)) { changed = true; continue; }
      const out = { alt: [], broader: [], narrower: [], related: [] };
      for (const k of ['alt', 'broader', 'narrower', 'related']) {
        for (const t of (c && c[k]) || []) { if (bad(t)) { changed = true; } else if (!out[k].includes(t)) out[k].push(t); }
      }
      clean[term] = out;
    }
    return { clean, changed };
  }
  _vocabPath(facet) { return `/schema/vocab/${String(facet).replace(/[^a-z0-9_-]/gi, '')}.json`; }   // facets are simple enumerated names
  _markVocabDirty(facet) { this._dirtyVocab.add(facet); this._scheduleFlush(); }
  async _writeVocab(facet) {
    await this._ensureDir('/schema/vocab');
    const concepts = this.vocab[facet] || {};
    if (Object.keys(concepts).length) await this.vfs.writeFile(this._vocabPath(facet), JSON.stringify({ facet, concepts }, null, 2));
    else { try { await this.vfs.unlink(this._vocabPath(facet)); } catch { /* already gone */ } }
  }

  // Hydrate the in-memory card index from packed shards, migrating any legacy
  // per-file cards (/catalog/glass-*.json — one file each) into shards once. The
  // migration is non-destructive + idempotent: it writes the shards FIRST and only
  // then removes the legacy files, so an interruption just re-runs next load.
  async _loadCatalog() {
    await this._ensureDir('/catalog');
    let files = [];
    try { files = await this.vfs.readdir('/catalog'); } catch { return; }
    const cardFiles = files.filter((f) => /^cards-[0-9a-f]{2}\.ndjson$/.test(f));
    const texts = await Promise.all(cardFiles.map((f) => this._readText(`/catalog/${f}`)));   // read shards concurrently
    for (const text of texts) {
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { const c = JSON.parse(line); const gid = c.glass && c.glass.glass_id; if (gid) this.cards.set(String(gid), c); } catch { /* skip bad line */ }
      }
    }
    const legacy = files.filter((f) => /^glass-.*\.json$/.test(f));
    if (legacy.length) {
      for (const f of legacy) {
        const c = await this._readJSON(`/catalog/${f}`, null);
        const gid = c && c.glass && c.glass.glass_id;
        if (gid) { this.cards.set(String(gid), c); this._dirtyCards.add(this._cardBucket(gid)); }
      }
      for (const b of this._dirtyCards) await this._writeCardShard(b);   // shards written first
      this._dirtyCards.clear();
      for (const f of legacy) { try { await this.vfs.unlink(`/catalog/${f}`); } catch { /* leave it; re-run is safe */ } }
    }
  }

  async _loadShard(feedId) {
    const text = await this._readText(this._shardPath(feedId));
    const set = this._feedSet(feedId);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const r = JSON.parse(line); this.items.set(String(r.id), r); set.add(String(r.id)); } catch { /* skip */ }
    }
  }

  // ── feeds ──
  listFeeds() { return [...this.feeds.values()]; }
  getFeed(id) { return this.feeds.get(id) || null; }

  async putFeed(raw) {
    // Collision-free id for NEW feeds (no explicit id). makeFeed slugifies the
    // name, so two feeds whose names slugify alike — e.g. two bsky.app profiles
    // that both fell back to the host name 'bsky.app' → 'bsky-app' — would share
    // an id and the second would clobber the first's record + items. Keep the
    // readable slug; disambiguate with a short url-hash ONLY on a real collision
    // (a different url claiming a taken slug). Re-adding the same url reuses its
    // id, so re-add stays idempotent.
    if (!raw.id) {
      const base = slugify(raw.name || raw.url || 'feed');
      const taken = this.feeds.get(base);
      if (taken && taken.url !== (raw.url || '')) {
        raw = { ...raw, id: `${base}-${hash32(String(raw.url || '')).slice(0, 6)}` };
      }
    }
    const feed = makeFeed(raw);
    this.feeds.set(feed.id, feed);
    this._feedSet(feed.id);
    await this._ensureDir('/feeds');
    await this.vfs.writeFile(this._feedPath(feed.id), JSON.stringify(feed, null, 2));
    this.emit('feed', { id: feed.id });
    return feed;
  }

  // Shallow-merge a patch into an existing feed and persist it. Lighter than
  // putFeed (which rebuilds the record through makeFeed); for in-place edits
  // like rename, move-to-folder, and cached favicons. No-op if the feed is gone.
  async updateFeed(id, patch) {
    const cur = this.feeds.get(id);
    if (!cur) return null;
    const feed = { ...cur, ...patch };
    this.feeds.set(id, feed);
    await this.vfs.writeFile(this._feedPath(id), JSON.stringify(feed, null, 2));
    this.emit('feed', { id });
    return feed;
  }

  // Stamp watch-affinity scores onto matching YouTube feeds (from a Takeout
  // digest). Returns how many feeds matched.
  async applyAffinity(scoreMap) {
    let matched = 0;
    for (const feed of this.feeds.values()) {
      const cid = channelIdOf(feed.url);
      if (cid && scoreMap[cid] != null && feed.affinity !== scoreMap[cid]) {
        feed.affinity = scoreMap[cid];
        await this.vfs.writeFile(this._feedPath(feed.id), JSON.stringify(feed, null, 2));
        matched++;
      }
    }
    if (matched) this.emit('feed', { affinity: matched });
    return { matched };
  }

  feedsWithAffinity() { let n = 0; for (const f of this.feeds.values()) if (f.affinity) n++; return n; }

  async removeFeed(id) {
    const set = this.byFeed.get(id);
    if (set) for (const itemId of set) this.items.delete(itemId);
    this.byFeed.delete(id);
    this.feeds.delete(id);
    this._dirtyFeeds.delete(id);
    for (const p of [this._feedPath(id), this._shardPath(id)]) {
      try { await this.vfs.unlink(p); } catch { /* gone */ }
    }
    try { await this.vfs.rm(this._contentDir(id), { recursive: true }); } catch { /* gone (legacy per-item dir) */ }
    try { await this.vfs.unlink(this._contentShardPath(id)); } catch { /* gone */ }
    this._contentShards.delete(id); this._dirtyContent.delete(id);
    this.emit('feed', { id, removed: true });
  }

  // Re-key a feed and EVERYTHING that references it, atomically in memory then
  // persisted: the feed record, its items, their stored content files, the
  // archived-index tombstones, and any glass cards. This is not a rename of a
  // display field — a feed's id is load-bearing:
  //   • the `feed` / `youtube` adapters mint item ids as `<feed.id>:<guid>` on
  //     EVERY poll, so leaving item ids on the old prefix would make the next
  //     poll re-insert all of them as "new" and orphan the originals;
  //   • content/shard/feed FILES are addressed by feedKey(id) and fsKey(itemId);
  //   • tombstones (resurrection guard) and cards (document_ref) point at item ids.
  // Item state (read/saved/tags/glass_id) rides along untouched (never-reset,
  // SPEC §5). Files are RELOCATED (write-new-then-unlink-old) — content is moved,
  // never data-deleted. Returns null if oldId is gone; throws if newId is taken
  // (the caller picks a free id). Built as a general capability, not a one-off:
  // weir will accrete more id mistakes worth correcting cleanly.
  async renameFeed(oldId, newId) {
    oldId = String(oldId);
    newId = slugify(String(newId));
    if (!newId) throw new Error('renameFeed: empty target id');
    const feed = this.feeds.get(oldId);
    if (!feed) return null;
    if (newId === oldId) return { renamed: oldId, from: oldId, items: 0, tombstones: 0 };
    if (this.feeds.has(newId)) throw new Error(`feed id "${newId}" already exists`);
    const prefix = `${oldId}:`;
    const rekey = (id) => (String(id).startsWith(prefix) ? `${newId}:${String(id).slice(prefix.length)}` : String(id));

    // 1. Move the feed record.
    const moved = { ...feed, id: newId };
    this.feeds.delete(oldId);
    this.feeds.set(newId, moved);

    // 2. Re-key items + relocate their content. Content path derives from BOTH
    //    feed id and item id, so a re-keyed item's html must be rewritten under
    //    the new address. content_path is normally undefined for feed items (it
    //    resolves via _contentPath); only stacks set it, and stacks isn't renamed.
    const oldSet = this.byFeed.get(oldId) || new Set();
    const newSet = new Set();
    for (const oldItemId of [...oldSet]) {
      const rec = this.items.get(oldItemId);
      if (!rec) continue;
      const newItemId = rekey(oldItemId);
      let html = null;
      if (rec.has_content) {
        if (rec.content_path) { try { html = await this._readText(rec.content_path, null); } catch { html = null; } }
        else { const om = await this._loadContentShard(oldId); html = om.get(fsKey(oldItemId)) ?? null; }
      }
      rec.feed_id = newId;
      rec.id = newItemId;
      if (rec.content_path) rec.content_path = this._contentPath(newId, newItemId);
      if (oldItemId !== newItemId) this.items.delete(oldItemId);
      this.items.set(newItemId, rec);
      newSet.add(newItemId);
      if (html != null && !rec.content_path) { const nm = await this._loadContentShard(newId); nm.set(fsKey(newItemId), html); this._dirtyContent.add(newId); }
    }
    this.byFeed.delete(oldId);
    this.byFeed.set(newId, newSet);

    // 3. archived-index tombstones — keep the resurrection guard valid.
    let tombstones = 0;
    for (const t of this.tombstones) {
      if (t.feed_id === oldId) t.feed_id = newId;
      const nid = rekey(t.id);
      if (nid !== t.id) { this.archived.delete(String(t.id)); t.id = nid; this.archived.add(nid); tombstones++; }
    }
    if (tombstones) this._archivedDirty = true;

    // 4. glass cards — document_ref points at an item id.
    for (const card of this.cards.values()) {
      const ref = card.glass && card.glass.document_ref;
      if (ref && String(ref).startsWith(prefix)) { card.glass.document_ref = rekey(ref); this._markCardDirty(card.glass.glass_id); }
    }

    // 5. pending notifications keyed by item id (drives the notify badge).
    for (const n of this.notifications) n.id = rekey(n.id);

    // 6. Persist the new layout, then drop the now-empty old files (relocation).
    await this._ensureDir('/feeds');
    await this.vfs.writeFile(this._feedPath(newId), JSON.stringify(moved, null, 2));
    this._dirtyFeeds.delete(oldId);
    this._markFeedDirty(newId);
    await this.flush();
    for (const p of [this._feedPath(oldId), this._shardPath(oldId)]) { try { await this.vfs.unlink(p); } catch { /* gone */ } }
    try { await this.vfs.rm(this._contentDir(oldId), { recursive: true }); } catch { /* gone */ }
    try { await this.vfs.unlink(this._contentShardPath(oldId)); } catch { /* gone */ }
    this._contentShards.delete(oldId); this._dirtyContent.delete(oldId);

    this.emit('feed', { id: newId, renamedFrom: oldId });
    return { renamed: newId, from: oldId, items: newSet.size, tombstones };
  }

  // Remove all of a feed's items (and their stored content), saved items exempt.
  // For re-pointing a feed to a new source — the old items belong to the old
  // URL. Unlike prune(), it does NOT tombstone: the new source has its own ids,
  // and we don't want a stale-id guard blocking them.
  async clearFeedItems(feedId) {
    const set = this.byFeed.get(feedId);
    if (!set) return { removed: 0 };
    let removed = 0;
    for (const id of [...set]) {
      const r = this.items.get(id);
      if (!r || r.saved) continue;
      this.items.delete(id);
      set.delete(id);
      await this._deleteContent(r);
      removed++;
    }
    if (removed) { this._markFeedDirty(feedId); this.emit('items', { inserted: 0, updated: 0, skipped: 0, removed }); }
    return { removed };
  }

  // ── FRBR work-grouping (GLASS §4.1) ──
  // Canonical URL for syndication identity: drop www, fragment, trailing slash, and
  // known tracking params — but KEEP meaningful query (a YouTube `?v=`, a WP `?p=`),
  // so the same article via different feeds collapses while distinct videos don't.
  _canonicalUrl(u) {
    if (!u) return '';
    try {
      const x = new URL(u);
      const host = x.hostname.replace(/^www\./, '').toLowerCase();
      const params = new URLSearchParams(x.search);
      for (const k of [...params.keys()]) if (/^(utm_.*|fbclid|gclid|mc_eid|mc_cid|ref|ref_src|igshid|si|spm|cmpid)$/i.test(k)) params.delete(k);
      const q = params.toString();
      const path = x.pathname.replace(/\/+$/, '') || '/';
      return host + path + (q ? '?' + q : '');
    } catch { return ''; }
  }

  // Assign `work_id` across items so manifestations of one Work group together
  // (de-dup as GROUPING, never discarding — every item kept; work_id is a reversible
  // overlay). Two deterministic signals (precision-first, GLASS §4.1 steps 2–3):
  // (a) identical canonical URL (syndication), (b) SimHash near-duplicate via 4×16-bit
  // LSH bands. NOT an LLM call. Recompute-from-scratch (clears prior work_ids), so it
  // self-corrects. Returns { items, works, manifestations, biggest }.
  async regroupWorks({ maxHamming = 3 } = {}) {
    const live = [...this.items.values()].filter((i) => !i.archived);
    for (const it of live) if (it.simhash == null) it.simhash = simhash(`${it.title || ''} ${it.excerpt || ''}`);
    const parent = new Map(); for (const it of live) parent.set(it.id, it.id);
    const find = (x) => { let r = x; while (parent.get(r) !== r) r = parent.get(r); while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; } return r; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    // (a) canonical-URL identity (cap group size — real syndication is a handful, not a sea)
    const byUrl = new Map();
    for (const it of live) { const c = this._canonicalUrl(it.url); if (!c) continue; (byUrl.get(c) || byUrl.set(c, []).get(c)).push(it.id); }
    for (const grp of byUrl.values()) { if (grp.length < 2 || grp.length > 12) continue; for (let i = 1; i < grp.length; i++) union(grp[0], grp[i]); }
    // (b) SimHash near-dup — 4 bands of 16 bits; compare only within a band bucket
    const withHash = live.filter((it) => it.simhash && it.simhash.length === 16);
    for (let band = 0; band < 4; band++) {
      const buckets = new Map();
      for (const it of withHash) { const key = it.simhash.slice(band * 4, band * 4 + 4); (buckets.get(key) || buckets.set(key, []).get(key)).push(it); }
      for (const bucket of buckets.values()) {
        if (bucket.length < 2 || bucket.length > 200) continue;   // skip huge chance-collision buckets
        for (let i = 0; i < bucket.length; i++) for (let j = i + 1; j < bucket.length; j++) {
          // A Work spans DIFFERENT feeds (syndication/cross-post). Same-feed near-dup
          // titles are a *series*, not one Work — never near-dup-group within a feed.
          if (bucket[i].feed_id === bucket[j].feed_id) continue;
          if (find(bucket[i].id) !== find(bucket[j].id) && hamming64(bucket[i].simhash, bucket[j].simhash) <= maxHamming) union(bucket[i].id, bucket[j].id);
        }
      }
    }
    // assign work_id = "w:" + smallest member id, for clusters ≥2; clear singletons
    const clusters = new Map();
    for (const it of live) { const r = find(it.id); (clusters.get(r) || clusters.set(r, []).get(r)).push(it); }
    let works = 0, manifestations = 0, biggest = 0; const touched = new Set();
    for (const members of clusters.values()) {
      const wid = members.length >= 2 ? 'w:' + members.map((m) => m.id).reduce((a, b) => (a < b ? a : b)) : undefined;
      if (members.length >= 2) { works++; manifestations += members.length; if (members.length > biggest) biggest = members.length; }
      for (const it of members) if (it.work_id !== wid) { it.work_id = wid; touched.add(it.feed_id); }
    }
    for (const fid of touched) this._markFeedDirty(fid);
    if (touched.size) await this.flush();
    this.emit('works', { works, manifestations });
    return { items: live.length, works, manifestations, biggest };
  }

  // Multi-manifestation Works, biggest first — for inspecting grouping precision.
  listWorks(limit = 20) {
    const byWork = new Map();
    for (const it of this.items.values()) { if (!it.work_id) continue; (byWork.get(it.work_id) || byWork.set(it.work_id, []).get(it.work_id)).push(it); }
    return [...byWork.entries()].map(([work_id, members]) => ({
      work_id, size: members.length,
      members: members.map((m) => ({ id: m.id, title: m.title, feed: (this.feeds.get(m.feed_id) || {}).name || m.feed_id })),
    })).sort((a, b) => b.size - a.size).slice(0, limit);
  }

  // ── items ──
  // Dedup guards on insert (SPEC §5): a tombstoned id is never resurrected; an
  // existing id updates mutable fields only — never read/saved/archived/tags.
  async upsertItems(rawItems) {
    const res = { inserted: 0, updated: 0, skipped: 0 };
    const touched = new Set();
    for (const raw of rawItems) {
      const id = String(raw.id);
      const feed = this.feeds.get(raw.feed_id);
      if (!feed) { res.skipped++; continue; }
      if (this.archived.has(id)) { res.skipped++; continue; }   // pruned-and-gone: do not resurface

      const existing = this.items.get(id);
      if (existing) {
        // Title-less items keep a body-derived title (microblogs etc.); re-derive
        // it on update so already-stored "(untitled)" items heal as their content
        // refreshes. A real title supersedes the synthesized one.
        if (raw.title != null && String(raw.title).trim() !== '') { existing.title = raw.title; existing.title_synth = undefined; }
        else if (raw.content != null) { const t = deriveTitle(raw.content); if (t) { existing.title = t; existing.title_synth = true; } }
        if (raw.url != null) existing.url = raw.url;
        if (raw.author !== undefined) existing.author = raw.author || undefined;
        if (raw.media !== undefined) existing.media = raw.media;
        if (raw.enriched !== undefined) existing.enriched = raw.enriched;   // link-resolver: fetched+parsed marker
        if (raw.resolve_parked !== undefined) existing.resolve_parked = raw.resolve_parked || undefined;   // durable: link gave up after maxMisses (survives reload; cleared on explicit re-enrich)
        if (raw.structured !== undefined) existing.structured = raw.structured;
        if (raw.excerpt !== undefined) existing.excerpt = raw.excerpt;
        else if (raw.content !== undefined) existing.excerpt = deriveExcerpt(raw.content);
        existing.search_text = deriveSearchText(existing);
        if (raw.content !== undefined) {
          await this._writeContent(feed.id, id, raw.content);
          existing.has_content = !!String(raw.content).length;
        }
        res.updated++;
      } else {
        const rec = makeItem(raw, feed);
        if (this.router) this._route(rec, feed);
        if (raw.content !== undefined && String(raw.content).length) await this._writeContent(feed.id, id, raw.content);
        this.items.set(id, rec);
        this._feedSet(feed.id).add(id);
        res.inserted++;
      }
      touched.add(feed.id);
    }
    for (const fid of touched) this._markFeedDirty(fid);
    if (res.inserted || res.updated) this.emit('items', { ...res });
    return res;
  }

  // Apply routing rules to a brand-new record (mutates tags/read/saved, sets
  // route/expiry, collects notifications). Re-derives expires_at since a rule
  // may have changed `saved` or asked for a retain override.
  _route(rec, feed) {
    const fx = this.router.apply(rec);
    if (fx.retain !== undefined) rec.expires_at = fx.retain === 'forever' ? null : rec.published_at + fx.retain * 86_400_000;
    else rec.expires_at = computeExpiry(rec, feed);
    if (fx.route) rec.route = fx.route;
    if (fx.notify) { this.notifications.push({ id: rec.id, at: now() }); this.emit('notify', { id: rec.id }); }
    return fx;
  }

  // Re-evaluate the current ruleset over all stored items (explicit verb — rules
  // are not retroactive otherwise, SPEC §6). Additive: tags accumulate, marks
  // apply. Returns the number of items that matched at least one rule.
  rerunRules() {
    if (!this.router) return { matched: 0 };
    let matched = 0;
    const touched = new Set();
    for (const rec of this.items.values()) {
      const fx = this._route(rec, this.feeds.get(rec.feed_id) || { id: rec.feed_id });
      if (fx.matched.length) { matched++; touched.add(rec.feed_id); }
    }
    for (const fid of touched) this._markFeedDirty(fid);
    if (matched) this.emit('items', { inserted: 0, updated: matched, skipped: 0 });
    return { matched };
  }

  getItem(id) { return this.items.get(String(id)) || null; }

  async getContent(id) {
    const rec = this.items.get(String(id));
    if (!rec || !rec.has_content) return null;
    // Stacks entries (and anything else) may pin their body to a real tree path
    // (e.g. /stacks/<path>) instead of the per-feed content pack.
    if (rec.content_path) return this._readText(rec.content_path, null);
    const m = await this._loadContentShard(rec.feed_id);
    const v = m.get(fsKey(rec.id));
    if (v != null) return v;
    return this._readText(this._contentPath(rec.feed_id, rec.id), null);   // legacy per-item file (migration still pending)
  }

  // Replace an item's stored content (e.g. fetched full article). Marks `full`
  // so we don't re-fetch and so the UI can hide the "load full article" button.
  async setContent(id, html, opts = {}) {
    const rec = this.items.get(String(id));
    if (!rec) return;
    await this._writeContent(rec.feed_id, rec.id, html);
    rec.has_content = !!String(html).length;
    if (opts.full) rec.full = true;
    this._markFeedDirty(rec.feed_id);
    this.emit('item', { id: rec.id });
  }

  async _deleteContent(rec) {
    if (rec.content_path) return;   // stacks body — not ours to delete here
    const m = await this._loadContentShard(rec.feed_id);
    if (m.delete(fsKey(rec.id))) { this._dirtyContent.add(rec.feed_id); this._scheduleFlush(); }
  }

  // Write an item's body into its feed's pack (insert / full-fetch). Pack is keyed by fsKey(itemId).
  async _writeContent(feedId, itemId, html) {
    const m = await this._loadContentShard(feedId);
    if (String(html).length) m.set(fsKey(itemId), String(html)); else m.delete(fsKey(itemId));
    this._dirtyContent.add(feedId); this._scheduleFlush();
  }

  // ── per-feed content packs: one /content/<feed>.ndjson, {id,html} per line (id = fsKey(itemId)).
  // Lazy-loaded into a bounded LRU cache (the bodies are the bulk; we don't hold them all). ──
  async _loadContentShard(feedId) {
    let m = this._contentShards.get(feedId);
    if (m) { this._touchContent(feedId); return m; }
    m = new Map();
    const text = await this._readText(this._contentShardPath(feedId), '');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const e = JSON.parse(line); if (e && e.id != null) m.set(String(e.id), e.html ?? ''); } catch { /* skip bad line */ }
    }
    this._contentShards.set(feedId, m); this._contentLRU.push(feedId); this._evictContent();
    return m;
  }
  _touchContent(fid) { const i = this._contentLRU.indexOf(fid); if (i >= 0) this._contentLRU.splice(i, 1); this._contentLRU.push(fid); }
  _evictContent() {   // drop LRU clean packs over the cap (never evict an unsaved one)
    while (this._contentShards.size > CONTENT_CACHE_MAX) {
      const fid = this._contentLRU.find((f) => !this._dirtyContent.has(f));
      if (fid === undefined) break;
      this._contentLRU.splice(this._contentLRU.indexOf(fid), 1);
      this._contentShards.delete(fid);
    }
  }
  async _writeContentShard(feedId) {
    const m = this._contentShards.get(feedId);
    if (!m || m.size === 0) { try { await this.vfs.unlink(this._contentShardPath(feedId)); } catch { /* gone */ } return; }
    const lines = []; for (const [id, html] of m) lines.push(JSON.stringify({ id, html }));
    await this.vfs.writeFile(this._contentShardPath(feedId), lines.join('\n'));
  }

  // One-time migration: legacy per-item content (/content/<feed>/<item>.html — a directory per
  // feed) → per-feed packs (/content/<feed>.ndjson). Non-destructive + VERIFIED: write the pack,
  // confirm its line count matches the source files, and only THEN remove the old directory.
  // Idempotent — re-runs skip (no directories remain once migrated). Returns the feed count moved.
  async _migrateContent() {
    let entries; try { entries = await this.vfs.readdir('/content'); } catch { return 0; }
    let moved = 0;
    for (const name of entries) {
      let st; try { st = await this.vfs.stat('/content/' + name); } catch { continue; }
      if (st.type !== 'directory') continue;   // already a pack file (or unrelated)
      const dir = '/content/' + name;
      let files; try { files = (await this.vfs.readdir(dir)).filter((f) => f.endsWith('.html')); } catch { continue; }
      const lines = await Promise.all(files.map(async (f) =>
        JSON.stringify({ id: f.replace(/\.html$/, ''), html: await this._readText(dir + '/' + f, '') })));
      const packPath = '/content/' + name + '.ndjson';
      await this.vfs.writeFile(packPath, lines.join('\n'));
      const back = (await this._readText(packPath, '')).split('\n').filter((l) => l.trim()).length;
      if (back === files.length) { try { await this.vfs.rm(dir, { recursive: true }); } catch { /* leave it; re-run is safe */ } moved++; }
    }
    if (moved) { this._contentShards.clear(); this._contentLRU = []; }   // drop any stale-empty cached packs read mid-migration
    return moved;
  }

  // view: 'inbox' | 'saved' | 'archived' | undefined(=inbox-ish, excludes archived)
  query(opts = {}) {
    const { view, feed_id, type, read, saved, archived, tag, text, route, category, limit, sort = '-published_at' } = opts;
    const needle = text ? String(text).toLowerCase() : null;
    const out = [];
    for (const r of this.items.values()) {
      if (view === 'inbox' && (r.archived || r.route)) continue;   // routed items leave the inbox
      if (view === 'saved' && !r.saved) continue;
      if (view === 'archived' && !r.archived) continue;
      if (!view && !route && (r.archived || r.route)) continue;
      if (route && r.route !== route) continue;
      if (category != null) { const cf = this.feeds.get(r.feed_id); if ((cf?.category || '') !== category) continue; }   // '' = ungrouped
      if (feed_id && r.feed_id !== feed_id) continue;
      if (type && r.type !== type) continue;
      if (read !== undefined && r.read !== read) continue;
      if (saved !== undefined && r.saved !== saved) continue;
      if (archived !== undefined && r.archived !== archived) continue;
      if (tag && !r.tags.includes(tag)) continue;
      if (needle && !r.search_text.includes(needle)) continue;
      out.push(r);
    }
    const desc = sort.startsWith('-'); const key = desc ? sort.slice(1) : sort;
    out.sort((a, b) => { const av = a[key], bv = b[key]; const c = av < bv ? -1 : av > bv ? 1 : 0; return desc ? -c : c; });
    return limit > 0 ? out.slice(0, limit) : out;
  }

  // Cursor-scan substring search over search_text (SPEC §6 v0.1). The in-memory
  // index makes this an array scan; MiniSearch/librarian is the v0.2 swap.
  search(queryText, opts = {}) { return this.query({ ...opts, text: queryText }); }

  counts() {
    let inbox = 0, unread = 0, saved = 0, archived = 0;
    const byFeed = {}, routes = {};
    for (const r of this.items.values()) {
      if (r.archived) archived++;
      else if (r.route) routes[r.route] = (routes[r.route] || 0) + 1;
      else { inbox++; if (!r.read) unread++; byFeed[r.feed_id] = (byFeed[r.feed_id] || 0) + 1; }
      if (r.saved) saved++;
    }
    return { inbox, unread, saved, archived, byFeed, routes, feeds: this.feeds.size, total: this.items.size };
  }

  setState(id, patch) {
    const r = this.items.get(String(id));
    if (!r) return null;
    if (patch.read !== undefined) r.read = !!patch.read;
    if (patch.archived !== undefined) r.archived = !!patch.archived;
    if (patch.tags !== undefined) r.tags = [...patch.tags];
    if (patch.saved !== undefined) {
      r.saved = !!patch.saved;
      r.expires_at = computeExpiry(r, this.feeds.get(r.feed_id));
    }
    this._markFeedDirty(r.feed_id);
    this.emit('item', { id: r.id, patch });
    return r;
  }

  // ── tagging (shared verb: human via the UI, llm via WebMCP, rule via router) ──
  // Add a tag to an item, recording WHO applied it in tag_src for provenance. Tags
  // are searchable (deriveSearchText folds them in), queryable (query({tag})), and
  // feed the glass `entity` facet on the next catalog. Registers the tag name in
  // /tags.json so it's offered for autocomplete. Idempotent; returns the item.
  addTag(id, tag, source = 'human') {
    const r = this.items.get(String(id)); if (!r) return null;
    const t = String(tag).trim(); if (!t) return r;
    if (!r.tags.includes(t)) {
      r.tags = [...r.tags, t];
      r.tag_src = { ...(r.tag_src || {}), [t]: source };
      r.search_text = deriveSearchText(r);
      this.setTag(t, {});   // register the name (fire-and-forget persist)
      this._markFeedDirty(r.feed_id);
      this.emit('item', { id: r.id, patch: { tags: r.tags } });
    }
    return r;
  }
  removeTag(id, tag) {
    const r = this.items.get(String(id)); if (!r) return null;
    const t = String(tag).trim();
    if (r.tags.includes(t)) {
      r.tags = r.tags.filter((x) => x !== t);
      if (r.tag_src) { const ts = { ...r.tag_src }; delete ts[t]; r.tag_src = Object.keys(ts).length ? ts : undefined; }
      r.search_text = deriveSearchText(r);
      this._markFeedDirty(r.feed_id);
      this.emit('item', { id: r.id, patch: { tags: r.tags } });
    }
    return r;
  }

  // Bulk-add tags to many items at once (e.g. "tag everything in this search").
  // Registers the tag names + writes /tags.json ONCE (not per item — addTag would
  // thrash it N×M times), marks each touched feed dirty, single emit. Returns the
  // count of items actually changed. Pairs with a single flush() by the caller.
  addTagBulk(ids, tags, source = 'human') {
    const clean = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))];
    if (!clean.length) return 0;
    let n = 0; const feeds = new Set();
    for (const id of ids) {
      const r = this.items.get(String(id)); if (!r) continue;
      let changed = false;
      for (const t of clean) { if (r.tags.includes(t)) continue; r.tags = [...r.tags, t]; r.tag_src = { ...(r.tag_src || {}), [t]: source }; changed = true; }
      if (changed) { r.search_text = deriveSearchText(r); feeds.add(r.feed_id); n++; }
    }
    for (const t of clean) this.tags[t] = { name: t, ...this.tags[t] };   // register names (in-memory)
    this.vfs.writeFile('/tags.json', JSON.stringify(this.tags, null, 2)).catch(() => {});   // persist registry once
    for (const fid of feeds) this._markFeedDirty(fid);
    if (n) this.emit('items', { inserted: 0, updated: n, skipped: 0 });
    return n;
  }

  // Rename a tag across every item + the registry. If `newName` already exists,
  // this MERGES (items carrying both end up with one; provenance keeps the target's
  // for merged items, else carries the source's). Returns items changed.
  renameTag(oldName, newName) {
    const from = String(oldName).trim(); const to = String(newName).trim();
    if (!from || !to || from === to) return 0;
    let n = 0; const feeds = new Set();
    for (const r of this.items.values()) {
      if (!r.tags.includes(from)) continue;
      const had = r.tags.includes(to);
      r.tags = r.tags.filter((t) => t !== from);
      if (!had) r.tags.push(to);
      if (r.tag_src) {
        const src = r.tag_src[from]; const ts = { ...r.tag_src }; delete ts[from];
        if (!had && src) ts[to] = src;   // carry provenance only when not merging into an existing tag
        r.tag_src = Object.keys(ts).length ? ts : undefined;
      }
      r.search_text = deriveSearchText(r); feeds.add(r.feed_id); n++;
    }
    if (this.tags[from]) { if (!this.tags[to]) this.tags[to] = { ...this.tags[from], name: to }; delete this.tags[from]; }
    this.vfs.writeFile('/tags.json', JSON.stringify(this.tags, null, 2)).catch(() => {});
    for (const fid of feeds) this._markFeedDirty(fid);
    if (n) this.emit('items', { inserted: 0, updated: n, skipped: 0 });
    return n;
  }

  // Remove a tag from every item + the registry. Returns items changed.
  deleteTag(name) {
    const t = String(name).trim(); if (!t) return 0;
    let n = 0; const feeds = new Set();
    for (const r of this.items.values()) {
      if (!r.tags.includes(t)) continue;
      r.tags = r.tags.filter((x) => x !== t);
      if (r.tag_src) { const ts = { ...r.tag_src }; delete ts[t]; r.tag_src = Object.keys(ts).length ? ts : undefined; }
      r.search_text = deriveSearchText(r); feeds.add(r.feed_id); n++;
    }
    delete this.tags[t];
    this.vfs.writeFile('/tags.json', JSON.stringify(this.tags, null, 2)).catch(() => {});
    for (const fid of feeds) this._markFeedDirty(fid);
    if (n) this.emit('items', { inserted: 0, updated: n, skipped: 0 });
    return n;
  }

  // Per-tag item counts (includes registered-but-unused tags at 0). For the manager.
  tagCounts() {
    const out = {};
    for (const r of this.items.values()) for (const t of (r.tags || [])) out[t] = (out[t] || 0) + 1;
    for (const t of Object.keys(this.tags)) if (!(t in out)) out[t] = 0;
    return out;
  }

  // Bulk mark-read over exactly the items a view/folder/feed shows — reuses the
  // query predicate so scope always matches what's visible.
  markAllRead(opts = {}) {
    let n = 0; const touched = new Set();
    for (const r of this.query(opts)) {
      if (r.read) continue;
      r.read = true; touched.add(r.feed_id); n++;
    }
    for (const fid of touched) this._markFeedDirty(fid);
    if (n) this.emit('items', { inserted: 0, updated: n, skipped: 0 });
    return { read: n };
  }

  // Prune (retainer/manual): remove items + write tombstones so they never come
  // back. Saved items are exempt. `target` is an id array or a predicate.
  async prune(target, reason = 'pruned') {
    let ids;
    if (Array.isArray(target)) ids = target.map(String);
    else if (typeof target === 'function') { ids = []; for (const r of this.items.values()) if (target(r)) ids.push(r.id); }
    else return { pruned: 0 };

    let pruned = 0;
    for (const id of ids) {
      const r = this.items.get(id);
      if (!r || r.saved) continue;
      this.tombstones.push(makeTombstone(id, r.feed_id, reason));
      this.archived.add(id);
      this.items.delete(id);
      this._feedSet(r.feed_id).delete(id);
      await this._deleteContent(r);
      this._markFeedDirty(r.feed_id);
      pruned++;
    }
    if (pruned) { this._archivedDirty = true; this.emit('prune', { count: pruned, reason }); }
    return { pruned };
  }

  // Retention sweep — ARCHIVE (never delete) expired, non-saved, non-routed items
  // so the inbox stays processable but nothing is ever lost (SPEC §5, but
  // archive-not-prune per project decision). Off unless retention_enabled.
  runRetention(nowMs = now()) {
    if (!this.settings.retention_enabled) return { archived: 0 };
    const touched = new Set();
    let archived = 0;
    for (const r of this.items.values()) {
      if (r.saved || r.archived || r.route) continue;
      if (r.expires_at && r.expires_at < nowMs) { r.archived = true; touched.add(r.feed_id); archived++; }
    }
    for (const fid of touched) this._markFeedDirty(fid);
    if (archived) this.emit('items', { inserted: 0, updated: archived, skipped: 0 });
    return { archived };
  }

  // Bring every archived item back to active AND clear its expiry (recomputed →
  // null by default, so retention can't re-shelve it). The "I keep everything"
  // restore that reverses an over-eager auto-archive sweep. Nothing is deleted;
  // fully reversible. Returns the count unarchived.
  unarchiveAll() {
    let n = 0; const feeds = new Set();
    for (const r of this.items.values()) {
      if (!r.archived) continue;
      r.archived = false;
      r.expires_at = computeExpiry(r, this.feeds.get(r.feed_id));
      feeds.add(r.feed_id); n++;
    }
    for (const fid of feeds) this._markFeedDirty(fid);
    if (n) this.emit('items', { inserted: 0, updated: n, skipped: 0 });
    return n;
  }

  // ── stacks (STACKS.md) ──
  // A stacks entry is a normal Item under the synthetic 'stacks' feed, but its
  // identity is the stable `uid` (id = `stacks:<uid>`) and its body lives at the
  // real tree path. syncStacksEntry upserts WITHOUT resetting read/saved/human
  // state on re-scan (the never-reset rule, SPEC §5 dedup), and tags from the
  // file (frontmatter/sidecar) union with what's already there — EXCEPT when
  // opts.replaceTags is set (an authoritative save), where the given tags become the
  // exact set (so a save can remove a tag, not only add).
  syncStacksEntry(e, opts = {}) {
    const id = `stacks:${e.uid}`;
    const fileTags = Array.isArray(e.tags) ? e.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean) : [];
    let rec = this.items.get(id);
    if (!rec) {
      rec = makeItem({
        id, type: e.type === 'note' ? 'note' : 'file',
        title: e.title || e.path, author: e.source || undefined,
        published_at: e.created, fetched_at: e.created,
        excerpt: e.excerpt || '', tags: fileTags,
        uid: e.uid, path: e.path, content_path: `/stacks/${e.path}`, mime: e.mime,
      }, this.feeds.get('stacks') || { id: 'stacks' });
      rec.has_content = true;
      if (Array.isArray(e.links)) rec.links = e.links;   // [[ref]] targets, for backlinks
      if (e.target != null) rec.target = e.target;        // annotation target (item id) → backlinks
      this.items.set(id, rec);
      this._feedSet('stacks').add(id);
    } else {
      rec.title = e.title || rec.title;
      rec.type = e.type === 'note' ? 'note' : 'file';
      rec.path = e.path;
      rec.content_path = `/stacks/${e.path}`;
      rec.mime = e.mime || rec.mime;
      if (e.excerpt != null) rec.excerpt = e.excerpt;
      rec.missing = false;
      rec.has_content = true;
      if (Array.isArray(e.links)) rec.links = e.links;
      if (e.target != null) rec.target = e.target;
      if (opts.replaceTags) {
        // authoritative save → the given tags are the exact set (keep prior source
        // for surviving tags, 'file' for new; drop the rest)
        const src = {};
        for (const t of fileTags) src[t] = (rec.tag_src && rec.tag_src[t]) || 'file';
        rec.tags = fileTags;
        rec.tag_src = Object.keys(src).length ? src : undefined;
      } else {
        // scan/move → union additively, never dropping human/llm tags already on the item
        for (const t of fileTags) if (!rec.tags.includes(t)) { rec.tags = [...rec.tags, t]; rec.tag_src = { ...(rec.tag_src || {}), [t]: 'file' }; }
      }
      rec.search_text = deriveSearchText(rec);
    }
    this._markFeedDirty('stacks');
    return rec;
  }

  // After a scan, flag every stacks item whose uid isn't on disk as `missing`
  // (never delete — STACKS.md §9). `presentUids` is a Set of uids found this scan.
  markStacksMissing(presentUids) {
    let n = 0;
    for (const id of this._feedSet('stacks')) {
      const r = this.items.get(id);
      if (!r) continue;
      const want = r.uid ? presentUids.has(r.uid) : false;
      if (!want && !r.missing) { r.missing = true; n++; }
    }
    if (n) this._markFeedDirty('stacks');
    return n;
  }

  // "Forget missing" (STACKS.md §9) — drop stacks index entries whose files are
  // gone, so reorgs don't leave ghosts. The files are already gone; if one ever
  // reappears, the next scan re-adds it. No tombstone (we WANT re-add on return).
  forgetMissingStacks() {
    let n = 0; const set = this._feedSet('stacks');
    for (const id of [...set]) {
      const r = this.items.get(id);
      if (r && r.missing) { this.items.delete(id); set.delete(id); n++; }
    }
    if (n) { this._markFeedDirty('stacks'); this.emit('items', { inserted: 0, updated: 0, skipped: 0, removed: n }); }
    return n;
  }

  // ── settings / tags / routing ──
  getSettings() { return { ...this.settings }; }
  async setSettings(patch) {
    this.settings = { ...this.settings, ...patch };
    await this.vfs.writeFile('/settings.json', JSON.stringify(this.settings, null, 2));
    this.emit('settings', this.settings);
    return this.settings;
  }
  getTags() { return this.tags; }
  async setTag(name, meta) {
    this.tags[name] = { name, ...this.tags[name], ...meta };
    await this.vfs.writeFile('/tags.json', JSON.stringify(this.tags, null, 2));
    return this.tags[name];
  }
  // ── smart views ──
  getViews() { return this.savedViews.map((v) => ({ ...v })); }
  async saveViews(views) {
    this.savedViews = (views || []).map((v) => ({ ...v }));
    await this.vfs.writeFile('/views.json', JSON.stringify(this.savedViews, null, 2));
    this.emit('views', {});
  }

  async getRouting() { return this._readText('/routing.js', ''); }
  async setRouting(src) { await this.vfs.writeFile('/routing.js', String(src)); this.emit('routing', {}); }
  async getStacksRouting() { return this._readText('/stacks-routing.js', ''); }
  async setStacksRouting(src) { await this.vfs.writeFile('/stacks-routing.js', String(src)); this.emit('routing', { target: 'stacks' }); }

  // ── persistence ──
  _markFeedDirty(feedId) { this._dirtyFeeds.add(feedId); this._scheduleFlush(); }
  // Catalog cards are bucketed into ~256 shards by a hash of their glass_id (not
  // one file per card) — so the FSA mount + hydration + every write touch dozens
  // of files, not thousands. Same dirty-flush model as feed shards.
  _markCardDirty(glassId) { this._dirtyCards.add(this._cardBucket(glassId)); this._scheduleFlush(); }
  _cardBucket(glassId) { return hash32(String(glassId)).slice(0, 2); }
  _cardShardPath(bucket) { return `/catalog/cards-${bucket}.ndjson`; }
  async _writeCardShard(bucket) {
    await this._ensureDir('/catalog');
    const lines = [];
    for (const c of this.cards.values()) { const gid = c.glass && c.glass.glass_id; if (gid && this._cardBucket(gid) === bucket) lines.push(JSON.stringify(c)); }
    const path = this._cardShardPath(bucket);
    if (lines.length) await this.vfs.writeFile(path, lines.join('\n'));
    else { try { await this.vfs.unlink(path); } catch { /* already gone */ } }
  }
  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => { this._flushTimer = null; this.flush().catch((e) => console.error('flush failed', e)); }, FLUSH_DELAY_MS);
    if (this._flushTimer && typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
  }

  async flush() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    for (const fid of this._dirtyFeeds) await this._writeShard(fid);
    this._dirtyFeeds.clear();
    for (const b of this._dirtyCards) await this._writeCardShard(b);
    this._dirtyCards.clear();
    for (const f of this._dirtyVocab) await this._writeVocab(f);
    this._dirtyVocab.clear();
    for (const fid of this._dirtyContent) await this._writeContentShard(fid);
    this._dirtyContent.clear();
    if (this._archivedDirty) {
      await this.vfs.writeFile('/archived_index.ndjson', this.tombstones.map((t) => JSON.stringify(t)).join('\n'));
      this._archivedDirty = false;
    }
  }

  async _writeShard(feedId) {
    const set = this.byFeed.get(feedId);
    const lines = [];
    if (set) for (const id of set) { const r = this.items.get(id); if (r) lines.push(JSON.stringify(r)); }
    await this.vfs.writeFile(this._shardPath(feedId), lines.join('\n'));
  }

  async estimate() { try { return await this.vfs.estimate('/'); } catch { return null; } }

  // Per-area storage breakdown: bytes summed by top-level path segment (content,
  // catalog, items, feeds, …) from stat() metadata — cheap, no content reads.
  async storageBreakdown() {
    await this.flush();   // land pending item shards so the numbers are accurate
    const areas = {};
    const walk = async (dir) => {
      let names; try { names = await this.vfs.readdir(dir); } catch { return; }
      for (const name of names) {
        const p = dir === '/' ? `/${name}` : `${dir}/${name}`;
        let st; try { st = await this.vfs.stat(p); } catch { continue; }
        if (st.type === 'directory') await walk(p);
        else if (name !== '.health') { const area = p.split('/')[1] || '(root)'; areas[area] = (areas[area] || 0) + (st.size || 0); }
      }
    };
    await walk('/');
    let total = 0; for (const k in areas) total += areas[k];
    return { total, areas };
  }

  // Read/write round-trip health probe (proves the backend works end to end).
  async ping() {
    const stamp = String(now());
    await this.vfs.writeFile('/.health', stamp);
    return (await this.vfs.readFile('/.health', 'utf8')) === stamp;
  }

  // Recursively collect every file path under `dir` (depth-first). The VFS
  // layout is identical on every backend, so this captures the whole store.
  async _walk(dir, out) {
    let names;
    try { names = await this.vfs.readdir(dir); } catch { return out; }
    for (const name of names) {
      const p = dir === '/' ? `/${name}` : `${dir}/${name}`;
      let st; try { st = await this.vfs.stat(p); } catch { continue; }
      if (st.type === 'directory') await this._walk(p, out);
      else if (name !== '.health') out.push(p);   // skip the transient health probe
    }
    return out;
  }

  // Full backup: flush pending writes, then snapshot every file (path → text
  // content). The whole corpus — feeds, item shards, lazy content, tags, views,
  // routing, settings, tombstones — in one portable object. Durability against
  // IndexedDB eviction (SPEC §5 / never-delete).
  async exportAll() {
    await this.flush();
    const paths = await this._walk('/', []);
    const files = {};
    for (const p of paths) { try { files[p] = await this.vfs.readFile(p, 'utf8'); } catch { /* skip unreadable */ } }
    return { meta: { app: 'weir', schema: SCHEMA_VERSION, exported: now(), files: paths.length }, files };
  }

  // Restore a backup into this VFS: write every file (overwrite), then prune any
  // file NOT in the backup, so the result is an exact snapshot. Writes happen
  // before the prune, so a failure never leaves you with less than you had. The
  // caller must reload (re-hydrate) afterwards — the in-memory store is now stale.
  async importAll(backup) {
    if (!backup || typeof backup !== 'object' || !backup.files) throw new Error('not a weir backup (no files)');
    const want = new Set(Object.keys(backup.files));
    for (const [p, content] of Object.entries(backup.files)) {
      const slash = p.lastIndexOf('/');
      const dir = slash > 0 ? p.slice(0, slash) : '';
      if (dir) await this.vfs.mkdir(dir, { recursive: true });
      await this.vfs.writeFile(p, String(content));
    }
    let pruned = 0;
    for (const p of await this._walk('/', [])) {
      if (!want.has(p)) { try { await this.vfs.unlink(p); pruned++; } catch { /* gone */ } }
    }
    return { written: want.size, pruned };
  }

  // ── glass catalog (Stage 0: deterministic cards, no LLM — see GLASS.md) ──
  // Emit /catalog/<glass_id>.json for items that don't yet have one (or all, with
  // overwrite), from metadata weir already holds, and stamp each item's glass_id.
  async buildCatalog({ overwrite = false, cataloged } = {}) {
    await this._ensureDir('/catalog');
    const day = cataloged || new Date().toISOString().slice(0, 10);
    let n = 0, created = 0, skipped = 0;
    const touched = new Set();
    for (const item of this.items.values()) {
      if (item.glass_id && !overwrite) { skipped++; continue; }
      const glass_id = (overwrite && item.glass_id) ? item.glass_id : nextGlassId(day, ++n);
      const card = buildCard(item, this.feeds.get(item.feed_id), { glass_id, cataloged: day });
      this.cards.set(String(glass_id), card);
      this._dirtyCards.add(this._cardBucket(glass_id));
      if (item.glass_id !== glass_id) { item.glass_id = glass_id; touched.add(item.feed_id); }
      created++;
    }
    for (const fid of touched) this._markFeedDirty(fid);
    await this.flush();
    this.emit('catalog', { created, skipped });
    return { created, skipped, total: this.items.size };
  }

  async getCard(glassId) { return this.cards.get(String(glassId)) || null; }

  // Confirm/correct a cataloger card: clear needs_review, stamp the human review,
  // and optionally overwrite specific facets. Used by the review queue (UI + MCP).
  async markCardReviewed(glassId, opts = {}) {
    const card = this.cards.get(String(glassId));
    if (!card) throw new Error(`no such card: ${glassId}`);
    card.glass = card.glass || {};
    card.glass.needs_review = false;
    card.glass.reviewer = 'human';
    card.glass.reviewed_at = now();
    if (opts.confidence != null) card.glass.confidence = opts.confidence;
    else if (!(card.glass.confidence >= 0.9)) card.glass.confidence = 0.9;
    if (opts.facets && typeof opts.facets === 'object') card.facets = { ...card.facets, ...opts.facets };
    this._markCardDirty(glassId);
    this.emit('catalog', { id: glassId, reviewed: true });
    return card;
  }
  async catalogCount() { return this.cards.size; }

  // ── knowledge graph: typed `related` edges (GLASS §10, decides-vs-proposes §2.1) ──
  // No graph DB: edges live on the card (card.glass.related = [{ target, type, source,
  // at }]). Proposals are computed ON DEMAND from facet co-occurrence (free, no LLM);
  // only RATIFIED edges are stored. Backlinks are a scan (the card set is in memory).

  // {df, postings, N} over topical-facet terms across all cards. df = doc frequency
  // (→ IDF); postings[key] = Set<glass_id> sharing that facet:term (→ candidate gather).
  _relatednessIndex() {
    const df = new Map(), postings = new Map();
    for (const [gid, card] of this.cards) {
      const facets = card.facets || {};
      for (const f of TOPICAL_FACETS) for (const t of facets[f] || []) {
        const key = f + ' ' + t;
        df.set(key, (df.get(key) || 0) + 1);
        let set = postings.get(key); if (!set) postings.set(key, set = new Set());
        set.add(gid);
      }
    }
    return { df, postings, N: this.cards.size };
  }

  // Propose related cards for `glassId` by IDF-weighted facet co-occurrence — on demand,
  // deterministic, NOT stored (surfaced for ratification). Excludes self + already-related.
  // Returns [{ glass_id, score, shared, title, document_ref }] best-first. Pass opts._index
  // (from _relatednessIndex) to amortize over a batch.
  proposeRelated(glassId, opts = {}) {
    const gid = String(glassId);
    const card = this.cards.get(gid);
    if (!card) return [];
    const facets = card.facets || {};
    const { df, postings, N } = opts._index || this._relatednessIndex();
    const idf = (f, t) => Math.log((N + 1) / ((df.get(f + ' ' + t) || 0) + 1)) + 1;
    const cand = new Set();
    for (const f of TOPICAL_FACETS) for (const t of facets[f] || []) {
      const set = postings.get(f + ' ' + t); if (set) for (const g of set) if (g !== gid) cand.add(g);
    }
    const already = new Set(((card.glass && card.glass.related) || []).map((e) => e.target));
    const limit = Math.min(Math.max(1, opts.limit || 8), 50);
    const scored = [];
    for (const g of cand) {
      if (already.has(g)) continue;
      const other = this.cards.get(g); if (!other) continue;
      const shared = sharedTopicalTerms(facets, other.facets || {});
      if (!Object.keys(shared).length) continue;
      const score = relatednessScore(shared, idf);
      if (opts.minScore && score < opts.minScore) continue;
      scored.push({ glass_id: g, score: +score.toFixed(3), shared, title: (other.dublin_core && other.dublin_core.title) || g, document_ref: other.glass && other.glass.document_ref });
    }
    scored.sort((a, b) => b.score - a.score || (a.glass_id < b.glass_id ? -1 : 1));
    return scored.slice(0, limit);
  }

  // Ratify/create a typed edge fromGlassId → toGlassId. This IS the ratification — an
  // edge exists only once stored here (§2.1). Idempotent per (target, type).
  relateCards(fromGlassId, toGlassId, opts = {}) {
    const from = this.cards.get(String(fromGlassId));
    if (!from) throw new Error(`no such card: ${fromGlassId}`);
    if (!this.cards.get(String(toGlassId))) throw new Error(`no such card: ${toGlassId}`);
    if (String(fromGlassId) === String(toGlassId)) throw new Error('a card cannot relate to itself');
    const type = String(opts.type || 'related');
    if (!RELATION_TYPES.includes(type)) throw new Error(`unknown relation type "${type}" (one of: ${RELATION_TYPES.join(', ')})`);
    from.glass = from.glass || {};
    const related = from.glass.related || (from.glass.related = []);
    let edge = related.find((e) => e.target === String(toGlassId) && e.type === type);
    if (!edge) { edge = { target: String(toGlassId), type, source: opts.source || 'human', at: now() }; related.push(edge); }
    this._markCardDirty(String(fromGlassId));
    this.emit('catalog', { id: String(fromGlassId), related: true });
    return edge;
  }

  // Remove edge(s) fromGlassId → toGlassId (optionally only of `type`). Returns count.
  unrelateCards(fromGlassId, toGlassId, opts = {}) {
    const from = this.cards.get(String(fromGlassId));
    if (!from || !from.glass || !Array.isArray(from.glass.related)) return 0;
    const before = from.glass.related.length;
    from.glass.related = from.glass.related.filter((e) => !(e.target === String(toGlassId) && (!opts.type || e.type === opts.type)));
    const removed = before - from.glass.related.length;
    if (removed) { this._markCardDirty(String(fromGlassId)); this.emit('catalog', { id: String(fromGlassId), related: true }); }
    return removed;
  }

  // All ratified edges touching a card: outgoing (resolved) + backlinks (cards pointing
  // here). Backlinks are a scan over the in-memory card set.
  relatedOf(glassId) {
    const gid = String(glassId);
    const card = this.cards.get(gid);
    const resolve = (g) => { const c = this.cards.get(g); return { glass_id: g, title: (c && c.dublin_core && c.dublin_core.title) || g, document_ref: c && c.glass && c.glass.document_ref }; };
    const outgoing = (((card && card.glass) || {}).related || []).map((e) => ({ ...resolve(e.target), type: e.type, source: e.source }));
    const backlinks = [];
    for (const [g, c] of this.cards) {
      if (g === gid) continue;
      for (const e of ((c.glass || {}).related) || []) if (e.target === gid) backlinks.push({ ...resolve(g), type: e.type, source: e.source });
    }
    return { outgoing, backlinks };
  }

  // Controlled-vocabulary normalization (the thesaurus primitive): rewrite a term
  // across EVERY catalog card within one facet — `from` → `to`, de-duplicated,
  // order preserved. This is the term-level analog of markCardReviewed's per-card
  // edit: a single vocabulary decision applied catalog-wide, so facet-browsing
  // stops silently splitting one concept across spelling/synonym variants
  // (`usa` vs `united states`). `to` empty/null DROPS the term with no replacement
  // (collapse a junk/singleton term). Match on `from` is case-insensitive (terms
  // are stored lowercased). Returns the number of cards changed. Pure card edit —
  // items/content/reading state untouched; reversible by merging back.
  // ── controlled vocabulary / thesaurus (SKOS-shaped, GLASS §7) ──
  getVocab(facet) { return this.vocab[facet] || {}; }
  getConcept(facet, term) { return (this.vocab[facet] || {})[String(term).toLowerCase().trim()] || null; }
  _ensureConcept(facet, term) {
    const v = this.vocab[facet] || (this.vocab[facet] = {});
    return v[term] || (v[term] = { alt: [], broader: [], narrower: [], related: [] });
  }
  // Record `alt` as a non-preferred synonym (skos:altLabel / UF) of `pref`. If `alt`
  // was itself a concept, its labels + relations fold into `pref` (then it's removed
  // as a preferred term). The non-destructive memory behind a merge.
  recordSynonym(facet, pref, alt) {
    facet = String(facet || '').trim();
    pref = String(pref).toLowerCase().trim(); alt = String(alt).toLowerCase().trim();
    if (!facet || !pref || !alt || pref === alt) return;
    const c = this._ensureConcept(facet, pref);
    const old = (this.vocab[facet] || {})[alt];
    if (old) {                                  // fold a former preferred term into pref
      for (const a of old.alt || []) if (a !== pref && !c.alt.includes(a)) c.alt.push(a);
      for (const rel of ['broader', 'narrower', 'related']) for (const t of old[rel] || []) if (t !== pref && !c[rel].includes(t)) c[rel].push(t);
      delete this.vocab[facet][alt];
    }
    if (!c.alt.includes(alt)) c.alt.push(alt);
    // never let a term be both a preferred concept and someone's alt elsewhere → fine; alt simply redirects here
    this._markVocabDirty(facet);
  }
  // Declare a typed relation. relation ∈ alt|broader|narrower|related; inverse is
  // maintained (broader↔narrower; related is symmetric). `targets` = string | string[].
  setVocabRelation(facet, term, relation, targets) {
    facet = String(facet || '').trim();
    term = String(term).toLowerCase().trim();
    const list = (Array.isArray(targets) ? targets : [targets]).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
    if (!facet || !term || !list.length) throw new Error('setVocabRelation needs facet, term, relation, target(s)');
    if (relation === 'alt') { for (const t of list) this.recordSynonym(facet, term, t); return this.getConcept(facet, term); }
    if (!['broader', 'narrower', 'related'].includes(relation)) throw new Error(`unknown relation "${relation}"`);
    const c = this._ensureConcept(facet, term);
    const inverse = relation === 'broader' ? 'narrower' : relation === 'narrower' ? 'broader' : 'related';
    for (const t of list) {
      if (t === term) continue;
      if (!c[relation].includes(t)) c[relation].push(t);
      const o = this._ensureConcept(facet, t);
      if (!o[inverse].includes(term)) o[inverse].push(term);
    }
    this._markVocabDirty(facet);
    return this.getConcept(facet, term);
  }
  // SKOS JSON-LD export — proves the shape is a standard, not a bespoke format.
  vocabExportSkos(facet) {
    const facets = facet ? [facet] : Object.keys(this.vocab);
    const graph = [];
    for (const f of facets) for (const [term, c] of Object.entries(this.vocab[f] || {})) {
      const node = { '@id': `weir:${f}/${encodeURIComponent(term)}`, '@type': 'skos:Concept', 'skos:inScheme': `weir:${f}`, 'skos:prefLabel': term };
      if (c.alt && c.alt.length) node['skos:altLabel'] = c.alt;
      for (const [rel, key] of [['broader', 'skos:broader'], ['narrower', 'skos:narrower'], ['related', 'skos:related']]) {
        if (c[rel] && c[rel].length) node[key] = c[rel].map((t) => `weir:${f}/${encodeURIComponent(t)}`);
      }
      graph.push(node);
    }
    return { '@context': { skos: 'http://www.w3.org/2004/02/skos/core#', weir: 'https://gentropic.org/weir/vocab#' }, '@graph': graph };
  }

  mergeFacetTerm(facet, from, to) {
    facet = String(facet || '').trim();
    const fromT = String(from == null ? '' : from).toLowerCase().trim();
    const toT = String(to == null ? '' : to).toLowerCase().trim();
    if (!facet || !fromT) throw new Error('mergeFacetTerm needs a facet and a from-term');
    if (fromT === toT) return 0;
    // Record the merge as a vocabulary decision (non-destructive): the merged term
    // becomes a skos:altLabel of the target, so the synonym is remembered even if no
    // card currently uses it. (A drop — empty `to` — records nothing.)
    if (toT) this.recordSynonym(facet, toT, fromT);
    let changed = 0;
    for (const card of this.cards.values()) {
      const arr = card.facets && card.facets[facet];
      if (!Array.isArray(arr) || !arr.length) continue;
      let hit = false;
      const seen = new Set();
      const out = [];
      for (const t of arr) {
        const isFrom = String(t).toLowerCase() === fromT;
        if (isFrom) hit = true;
        const term = isFrom ? toT : String(t);
        if (!term) continue;                       // dropped (to === '')
        const key = term.toLowerCase();
        if (seen.has(key)) continue;               // dedup (to-term already present)
        seen.add(key); out.push(term);
      }
      if (!hit) continue;
      card.facets[facet] = out;
      this._markCardDirty(card.glass.glass_id);
      changed++;
    }
    if (changed) this.emit('catalog', { merged: facet });
    return changed;
  }

  // Discard the cards for every item in a scope (feed / folder / type) so they
  // re-queue for cataloging — the engine of a SCOPED RE-CATALOG ("re-do the books",
  // "re-facet the geostatistics domain"). Mirrors catalogScope's candidate set.
  // Items/content/reading state untouched; reversible by re-cataloging. Returns count.
  async uncatalogScope({ feed_id, category, type } = {}) {
    const inCat = category != null ? new Set(this.listFeeds().filter((f) => (f.category || '') === category).map((f) => f.id)) : null;
    let n = 0; const feeds = new Set();
    for (const it of this.items.values()) {
      if (!it.glass_id) continue;
      if (feed_id != null && it.feed_id !== feed_id) continue;
      if (inCat && !inCat.has(it.feed_id)) continue;
      if (type != null && it.type !== type) continue;
      const gid = it.glass_id;
      if (this.cards.has(gid)) { this.cards.delete(gid); this._markCardDirty(gid); }
      delete it.glass_id;
      feeds.add(it.feed_id); n++;
    }
    for (const fid of feeds) this._markFeedDirty(fid);
    if (n) this.emit('catalog', { uncataloged: n });
    return n;
  }

  // Discard one cataloger card (reject from the review queue): drop the card +
  // un-stamp the item so it's uncataloged again (re-cataloguable, or left out).
  // Mirrors clearCatalog for a single item; items/content/reading state untouched.
  async uncatalogItem(id) {
    const it = this.items.get(String(id)); if (!it || !it.glass_id) return null;
    const gid = it.glass_id;
    if (this.cards.has(gid)) { this.cards.delete(gid); this._markCardDirty(gid); }
    delete it.glass_id;
    this._markFeedDirty(it.feed_id);
    this.emit('catalog', { id: gid, discarded: true });
    return { discarded: gid };
  }

  // Wipe the catalog: delete every card file and un-stamp every item, so a fresh
  // catalog pass starts clean. (Cleanup for corruption like the seq-001 collision;
  // safe to re-run.) Does NOT touch items, content, usage, or the archive.
  async clearCatalog() {
    const cleared = this.cards.size;
    this.cards.clear();
    this._dirtyCards.clear();
    try { for (const f of await this.vfs.readdir('/catalog')) { if (/\.(ndjson|json)$/.test(f)) await this.vfs.unlink(`/catalog/${f}`); } } catch { /* no dir */ }
    const touched = new Set();
    for (const it of this.items.values()) { if (it.glass_id) { delete it.glass_id; touched.add(it.feed_id); } }
    for (const fid of touched) this._markFeedDirty(fid);
    await this.flush();
    this.emit('catalog', { cleared });
    return { cleared };
  }

  // Next free daily sequence for a glass_id (glass-YYYYMMDD-NNN). In-memory + sync,
  // so it's collision-safe even under concurrent writeCard (no await between
  // reading the max and the cards.set below — atomic in JS's single thread).
  _nextCatalogSeq(day) {
    const tag = `glass-${String(day).replace(/-/g, '')}-`;
    let max = 0;
    for (const gid of this.cards.keys()) { if (gid.startsWith(tag)) { const k = parseInt(gid.slice(tag.length), 10); if (k > max) max = k; } }
    return max + 1;
  }

  // Persist an (enriched) catalog card: assign a glass_id if missing, set it in the
  // in-memory index + mark its shard dirty (debounced flush — no per-card file
  // write / dir scan), and stamp the referenced item. Used by the Stage-1 cataloger.
  async writeCard(card) {
    card.glass = card.glass || {};
    if (!card.glass.glass_id) {
      const day = card.glass.cataloged || new Date().toISOString().slice(0, 10);
      card.glass.glass_id = nextGlassId(day, this._nextCatalogSeq(day));
    }
    const gid = String(card.glass.glass_id);
    this.cards.set(gid, card);
    this._markCardDirty(gid);
    const ref = card.glass.document_ref;
    if (ref) { const it = this.items.get(ref); if (it && it.glass_id !== gid) { it.glass_id = gid; this._markFeedDirty(it.feed_id); } }
    this.emit('catalog', { id: gid });
    return gid;
  }

  // LLM usage ledger (/usage.json). Tracks per-provider calls + tokens; for
  // nano-gpt also the billed INPUT tokens (×2 on multiplier models) — the unit
  // its weekly subscription pool meters. Never secret; lives in the store.
  async recordUsage(provider, model, usage = {}) {
    const u = await this._readJSON('/usage.json', { calls: 0, providers: {} });
    const p = u.providers[provider] || (u.providers[provider] = { calls: 0, input_tokens: 0, output_tokens: 0, billed_input: 0, since: now() });
    const inTok = usage.prompt_tokens || 0;
    p.calls++; u.calls = (u.calls || 0) + 1;
    p.input_tokens += inTok;
    p.output_tokens += usage.completion_tokens || 0;
    p.billed_input += inTok * inputMultiplier(provider, model);
    p.model = model;
    await this.vfs.writeFile('/usage.json', JSON.stringify(u, null, 2));
    this.emit('usage', u);
    return u;
  }
  async getUsage() { return this._readJSON('/usage.json', { calls: 0, providers: {} }); }

  async close() { await this.flush(); }
}
