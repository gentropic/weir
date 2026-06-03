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
  fsKey, hash32, slugify, deriveExcerpt, deriveSearchText, computeExpiry, now,
} from './schema.js';
import { buildCard, nextGlassId } from '../glass.js';
import { inputMultiplier } from '../llm.js';
import { channelIdOf } from '../affinity.js';

const FLUSH_DELAY_MS = 250;

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
    this._dirtyFeeds = new Set();
    this._dirtyCards = new Set();     // card-shard buckets needing a rewrite
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
  _contentPath(feedId, itemId) { return `${this._contentDir(feedId)}/${fsKey(itemId)}.html`; }
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

  // ── hydrate ──
  async _hydrate() {
    for (const d of ['/feeds', '/items', '/content']) await this._ensureDir(d);

    if (!(await this._readJSON('/meta.json', null))) {
      await this.vfs.writeFile('/meta.json', JSON.stringify({ schema: SCHEMA_VERSION, created: now() }, null, 2));
    }
    this.settings = { ...DEFAULT_SETTINGS, ...(await this._readJSON('/settings.json', {})) };
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
    for (const f of feedFiles) {
      if (!f.endsWith('.json')) continue;
      const feed = await this._readJSON(`/feeds/${f}`, null);
      if (feed && feed.id) { this.feeds.set(feed.id, makeFeed(feed)); this._feedSet(feed.id); }
    }
    for (const fid of this.feeds.keys()) await this._loadShard(fid);
    await this._loadCatalog();
  }

  // Hydrate the in-memory card index from packed shards, migrating any legacy
  // per-file cards (/catalog/glass-*.json — one file each) into shards once. The
  // migration is non-destructive + idempotent: it writes the shards FIRST and only
  // then removes the legacy files, so an interruption just re-runs next load.
  async _loadCatalog() {
    await this._ensureDir('/catalog');
    let files = [];
    try { files = await this.vfs.readdir('/catalog'); } catch { return; }
    for (const f of files) {
      if (!/^cards-[0-9a-f]{2}\.ndjson$/.test(f)) continue;
      for (const line of (await this._readText(`/catalog/${f}`)).split('\n')) {
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
    try { await this.vfs.rm(this._contentDir(id), { recursive: true }); } catch { /* gone */ }
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
      if (rec.has_content) { try { html = await this._readText(rec.content_path || this._contentPath(oldId, oldItemId), null); } catch { html = null; } }
      rec.feed_id = newId;
      rec.id = newItemId;
      if (rec.content_path) rec.content_path = this._contentPath(newId, newItemId);
      if (oldItemId !== newItemId) this.items.delete(oldItemId);
      this.items.set(newItemId, rec);
      newSet.add(newItemId);
      if (html != null) await this._writeContent(newId, newItemId, html);
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
        if (raw.title != null) existing.title = raw.title;
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
    // (e.g. /stacks/<path>) instead of the lazy /content/<feed>/… file.
    return this._readText(rec.content_path || this._contentPath(rec.feed_id, rec.id), null);
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

  async _writeContent(feedId, itemId, html) {
    await this._ensureDir(this._contentDir(feedId));
    await this.vfs.writeFile(this._contentPath(feedId, itemId), String(html));
  }
  async _deleteContent(rec) {
    try { await this.vfs.unlink(this._contentPath(rec.feed_id, rec.id)); } catch { /* gone */ }
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
