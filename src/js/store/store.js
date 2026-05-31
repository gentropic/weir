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
  SCHEMA_VERSION, DEFAULT_SETTINGS, makeItem, makeFeed, makeTombstone,
  fsKey, deriveExcerpt, deriveSearchText, computeExpiry, now,
} from './schema.js';
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
    this.settings = { ...DEFAULT_SETTINGS };
    this.router = null;              // optional Router; applied to new items on insert
    this.notifications = [];         // items a rule flagged notify:true (ephemeral)
    this._dirtyFeeds = new Set();
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
    return this._readText(this._contentPath(rec.feed_id, rec.id), null);
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
  async getRouting() { return this._readText('/routing.js', ''); }
  async setRouting(src) { await this.vfs.writeFile('/routing.js', String(src)); this.emit('routing', {}); }

  // ── persistence ──
  _markFeedDirty(feedId) { this._dirtyFeeds.add(feedId); this._scheduleFlush(); }
  _scheduleFlush() {
    if (this._flushTimer) return;
    this._flushTimer = setTimeout(() => { this._flushTimer = null; this.flush().catch((e) => console.error('flush failed', e)); }, FLUSH_DELAY_MS);
    if (this._flushTimer && typeof this._flushTimer.unref === 'function') this._flushTimer.unref();
  }

  async flush() {
    if (this._flushTimer) { clearTimeout(this._flushTimer); this._flushTimer = null; }
    for (const fid of this._dirtyFeeds) await this._writeShard(fid);
    this._dirtyFeeds.clear();
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

  // Read/write round-trip health probe (proves the backend works end to end).
  async ping() {
    const stamp = String(now());
    await this.vfs.writeFile('/.health', stamp);
    return (await this.vfs.readFile('/.health', 'utf8')) === stamp;
  }

  async close() { await this.flush(); }
}
