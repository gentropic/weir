// UI controller (SPEC §4). Vanilla DOM: renders the rail + stream from the store,
// handles keyboard nav and inline expand-to-read, and drives the poller. Plain
// re-render on store events (fine at v0.1 scale); selection/expansion are app
// state, content is cached to avoid re-reading on every keystroke.

import { relativeTime, isoTitle, escapeHtml, fmtDuration, fmtCount, dailyCounts, sparkPoints } from './format.js';
import { parseOpml, buildOpml } from '../opml.js';
import { DEFAULT_ROUTING } from '../router.js';
import { recoverFeed } from '../wayback.js';
import { parseFeed } from '../adapters/feed.js';

const VIEW_LABELS = { inbox: 'Inbox', saved: 'Saved', archived: 'Archived' };
const TEXT_TYPES = new Set(['article', 'paper', 'release', 'track', 'status', 'commit', 'issue']);
const RENDER_CAP = 300;
const RAIL_CAP = 60;

export class App {
  constructor({ store, poller, router, adapters }) {
    this.store = store;
    this.poller = poller;
    this.router = router;
    this.adapters = adapters || [];
    this.view = 'inbox';
    this.feedFilter = null;
    this.route = null;          // active routed view (#name), or null
    this.searchText = '';
    this.selectedId = null;
    this.expandedId = null;
    this.items = [];
    this._content = new Map();   // id → sanitized html (cache)
    this._g = false;
    this.pendingImport = null;   // { feeds, youtube } awaiting confirmation
  }

  mount() {
    this.stream = document.getElementById('stream');
    this.sources = document.getElementById('sources');
    this.searchEl = document.getElementById('search-input');

    for (const ev of ['items', 'item', 'prune']) this.store.on(ev, () => this.renderAll());
    this.store.on('feed', () => { this.renderRail(); this.renderTopbar(); });
    this.poller.on('polled', () => this.renderPollStatus());
    this.poller.on('cycle', () => this.renderPollStatus());

    document.querySelectorAll('.navrow[data-view]').forEach((row) =>
      row.addEventListener('click', () => this.setView(row.dataset.view)));
    this.sources.addEventListener('click', (e) => {
      const s = e.target.closest('.source'); if (!s) return;
      this.feedFilter = this.feedFilter === s.dataset.feed ? null : s.dataset.feed;
      this.renderAll();
    });
    this.stream.addEventListener('click', (e) => this.onStreamClick(e));

    const form = document.getElementById('addfeed');
    form.addEventListener('submit', (e) => { e.preventDefault(); const v = form.querySelector('input').value.trim(); if (v) this.addFeed(v); });
    this.searchEl.addEventListener('input', () => { this.searchText = this.searchEl.value.trim(); this.renderStream(); this.renderTopbar(); });

    const fileEl = document.getElementById('opml-file');
    document.getElementById('btn-import')?.addEventListener('click', () => fileEl.click());
    fileEl?.addEventListener('change', async () => { const f = fileEl.files[0]; if (f) this.importOpml(await f.text()); fileEl.value = ''; });
    document.getElementById('btn-export')?.addEventListener('click', () => this.exportOpml());

    document.getElementById('routes')?.addEventListener('click', (e) => { const r = e.target.closest('[data-route]'); if (r) this.setRoute(r.dataset.route); });
    document.getElementById('btn-recover')?.addEventListener('click', () => { if (this.feedFilter) this.recoverHistory(this.feedFilter); });
    document.getElementById('open-rules')?.addEventListener('click', () => this.openRules());
    document.getElementById('rules-save')?.addEventListener('click', () => this.saveRules());
    document.getElementById('rules-rerun')?.addEventListener('click', () => this.uiRerunRules());
    document.getElementById('rules-close')?.addEventListener('click', () => this.closeRules());
    this.store.on('notify', () => this.renderNotify());

    document.addEventListener('keydown', (e) => this.onKey(e));
    setInterval(() => this.renderPollStatus(), 30_000);

    this.renderAll();
    this.renderNotify();
    this.renderPollStatus();
  }

  query() {
    if (this.route) return this.store.query({ route: this.route, text: this.searchText || undefined });
    return this.store.query({ view: this.view, feed_id: this.feedFilter || undefined, text: this.searchText || undefined });
  }

  renderAll() { this.renderCounts(); this.renderRail(); this.renderRoutes(); this.renderTopbar(); this.renderStream(); }

  renderCounts() {
    const c = this.store.counts();
    const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
    set('count-inbox', c.inbox); set('count-saved', c.saved); set('count-archived', c.archived);
  }

  renderTopbar() {
    const feed = this.feedFilter && this.store.getFeed(this.feedFilter);
    const rb = document.getElementById('btn-recover'); if (rb) rb.hidden = !this.feedFilter;
    document.getElementById('view-title').textContent = this.route ? `#${this.route}` : feed ? feed.name : (VIEW_LABELS[this.view] || this.view);
    const n = this.items.length;
    const feeds = this.store.listFeeds().length;
    let sub;
    if (this.searchText) sub = `${n} match${n === 1 ? '' : 'es'} for “${this.searchText}”`;
    else if (!feeds) sub = 'no feeds yet';
    else sub = `${n} item${n === 1 ? '' : 's'}${feed ? '' : ` · ${feeds} source${feeds === 1 ? '' : 's'}`}`;
    document.getElementById('view-sub').textContent = sub;
  }

  renderRail() {
    const feeds = this.store.listFeeds();
    document.querySelectorAll('.navrow[data-view]').forEach((r) =>
      r.classList.toggle('active', !this.feedFilter && !this.route && r.dataset.view === this.view));
    if (!feeds.length) { this.sources.innerHTML = '<div class="rail-empty">No sources yet</div>'; return; }
    const shown = feeds.slice(0, RAIL_CAP);
    this.sources.innerHTML = shown.map((f) => {
      const ids = this.store.byFeed.get(f.id) || new Set();
      const times = []; let unread = 0;
      for (const id of ids) { const r = this.store.items.get(id); if (!r) continue; if (r.published_at) times.push(r.published_at); if (!r.read && !r.archived) unread++; }
      const pts = sparkPoints(dailyCounts(times, 7));
      const cls = f.state === 'failing' ? 'dead' : f.state === 'slow' ? 'slow' : 'up';
      const active = this.feedFilter === f.id ? ' active' : '';
      const spark = pts ? `<svg width="44" height="13" viewBox="0 0 44 13"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/></svg>` : '';
      return `<div class="source ${cls}${active}" data-feed="${escapeHtml(f.id)}" title="${escapeHtml(f.name)}${f.feed_health?.last_error ? ' — ' + escapeHtml(f.feed_health.last_error) : ''}">`
        + `<span class="spark">${spark}</span><span class="sname">${escapeHtml(f.name)}</span><span class="scount">${unread || ''}</span></div>`;
    }).join('') + (feeds.length > RAIL_CAP ? `<div class="rail-empty">+ ${feeds.length - RAIL_CAP} more sources</div>` : '');
  }

  renderStream() {
    if (this.pendingImport) { this.stream.innerHTML = this.importReviewHtml(); return; }
    this.items = this.query();
    if (this.selectedId && !this.items.some((x) => x.id === this.selectedId)) this.selectedId = null;
    if (!this.selectedId && this.items.length) this.selectedId = this.items[0].id;

    if (!this.items.length) { this.stream.innerHTML = this.emptyHtml(); return; }
    const shown = this.items.slice(0, RENDER_CAP);
    let html = shown.map((it) => this.rowHtml(it)).join('');
    if (this.items.length > RENDER_CAP) html += `<div class="more">+ ${this.items.length - RENDER_CAP} more not shown</div>`;
    this.stream.innerHTML = html;
    this.renderTopbar();
  }

  emptyHtml() {
    const hasFeeds = this.store.listFeeds().length > 0;
    if (hasFeeds) return `<div class="empty">Nothing in ${escapeHtml(VIEW_LABELS[this.view] || this.view)}${this.searchText ? ' for that search' : ''}.</div>`;
    return `<section class="onboard">
      <div class="onboard-glyph">⬓</div>
      <h2>No feeds yet</h2>
      <p>Paste a feed (or site) URL in the box up top to start, or try one:</p>
      <div class="onboard-actions">
        <button class="btn" data-sample="https://hnrss.org/frontpage">Hacker News</button>
        <button class="btn" data-sample="https://www.theverge.com/rss/index.xml">The Verge</button>
      </div>
    </section>`;
  }

  rowHtml(it) {
    const feed = this.store.getFeed(it.feed_id);
    const cls = `item${it.id === this.selectedId ? ' sel' : ''}${it.read ? ' read' : ''}${it.id === this.expandedId ? ' expanded' : ''}`;
    const meta = [feed ? escapeHtml(feed.name) : escapeHtml(it.feed_id), it.author && escapeHtml(it.author),
      `<span title="${escapeHtml(isoTitle(it.published_at))}">${relativeTime(it.published_at)}</span>`].filter(Boolean).join('<span class="dot-sep">·</span>');
    const tags = (it.tags || []).map((t) => `<span class="tag">${escapeHtml(t)}</span>`).join('');
    const saved = it.saved ? '<span class="flag">★</span>' : '';

    let body;
    if (it.type === 'video' || (it.media && it.media.thumbnail && !TEXT_TYPES.has(it.type))) {
      const dur = it.media?.duration_seconds ? `<span class="dur">${fmtDuration(it.media.duration_seconds)}</span>` : '';
      const thumb = it.media?.thumbnail
        ? `<img class="thumbimg" loading="lazy" src="${escapeHtml(it.media.thumbnail)}" alt="">`
        : '';
      const views = it.structured?.views ? `<span class="dot-sep">·</span><span>${fmtCount(it.structured.views)} views</span>` : '';
      body = `<div class="ivideo"><div class="thumb">${thumb}<span class="playover">▶</span>${dur}</div><div class="vbody"><div class="ititle">${saved}${escapeHtml(it.title)}</div><div class="imeta">${meta}${views} ${tags}</div></div></div>`;
    } else {
      body = `<div class="ititle">${saved}${escapeHtml(it.title)}</div>${it.excerpt ? `<div class="iexcerpt">${escapeHtml(it.excerpt)}</div>` : ''}<div class="imeta">${meta} ${tags}</div>`;
    }
    return `<article class="${cls}" data-id="${escapeHtml(it.id)}"><div class="pillcol"><span class="pill ${escapeHtml(it.type)}">${escapeHtml(it.type)}</span></div>`
      + `<div class="ibody">${body}<div class="iexpand">${it.id === this.expandedId ? this.expandedHtml(it) : ''}</div></div></article>`;
  }

  expandedHtml(it) {
    let inner = '';
    if (it.type === 'podcast' && it.media?.audio_url) inner += `<audio class="player" controls preload="none" src="${escapeHtml(it.media.audio_url)}"></audio>`;

    const cached = this._content.get(it.id);
    if (cached === undefined && it.has_content) {
      this.store.getContent(it.id).then((html) => { this._content.set(it.id, html || ''); if (this.expandedId === it.id) this.renderStream(); });
      inner += '<div class="icontent loading">loading…</div>';
    } else {
      const html = (cached && cached.length) ? cached : `<p>${escapeHtml(it.excerpt || 'No content.')}</p>`;
      inner += `<div class="icontent">${html}</div>`;
    }

    const suppressed = (cached || '').includes('data-weir-src');
    inner += '<div class="ifooter">';
    if (it.url) inner += '<button data-act="open">open original ↗</button>';
    inner += `<button data-act="save">${it.saved ? 'unsave' : 'save'}</button>`;
    inner += '<button data-act="archive">archive</button>';
    if (suppressed) inner += '<button data-act="images">load images</button>';
    inner += '</div>';
    return inner;
  }

  importReviewHtml() {
    const { feeds, youtube } = this.pendingImport;
    const total = feeds.length, feedsOnly = total - youtube;
    return `<section class="onboard">
      <div class="onboard-glyph">⬓</div>
      <h2>Import ${total} feed${total === 1 ? '' : 's'}</h2>
      <p>${youtube ? `${feedsOnly} feeds + ${youtube} YouTube subscriptions. YouTube subs are bulky — you can leave them out for now and add them later.` : 'Ready to import.'}</p>
      <div class="onboard-actions">
        <button class="btn" data-import="all">Import all (${total})</button>
        ${youtube ? `<button class="btn" data-import="feeds">Feeds only (${feedsOnly})</button>` : ''}
        <button class="btn" data-import="cancel">Cancel</button>
      </div>
    </section>`;
  }

  // ── interaction ──
  onStreamClick(e) {
    const imp = e.target.closest('[data-import]');
    if (imp) { this.runImport(imp.dataset.import); return; }
    const sample = e.target.closest('[data-sample]');
    if (sample) { document.getElementById('addfeed-input').value = sample.dataset.sample; this.addFeed(sample.dataset.sample); return; }
    const btn = e.target.closest('[data-act]');
    const row = e.target.closest('.item');
    if (!row) return;
    const id = row.dataset.id;
    if (btn) { e.stopPropagation(); this.doAct(btn.dataset.act, id); return; }
    if (e.target.closest('.ititle')) { this.select(id); this.toggleExpand(id); }
    else this.select(id);
  }

  select(id) {
    this.selectedId = id;
    this.stream.querySelectorAll('.item').forEach((r) => r.classList.toggle('sel', r.dataset.id === id));
    const row = this.rowEl(id);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  rowEl(id) { for (const r of this.stream.querySelectorAll('.item')) if (r.dataset.id === id) return r; return null; }

  toggleExpand(id) { if (this.expandedId === id) this.collapse(); else this.expand(id); }
  expand(id) {
    this.expandedId = id; this.selectedId = id;
    const it = this.store.getItem(id);
    if (it && !it.read) this.store.setState(id, { read: true });   // emits → renderAll
    else this.renderStream();
    const row = this.rowEl(id); if (row) row.scrollIntoView({ block: 'nearest' });
  }
  collapse() { this.expandedId = null; this.renderStream(); }

  moveSelection(delta) {
    if (!this.items.length) return;
    let i = this.items.findIndex((x) => x.id === this.selectedId);
    i = Math.max(0, Math.min(this.items.length - 1, (i < 0 ? 0 : i) + delta));
    const id = this.items[i].id;
    if (this.expandedId) this.expand(id);   // reading-mode walk
    else this.select(id);
  }

  doAct(act, id) {
    const it = this.store.getItem(id);
    if (!it) return;
    if (act === 'open') { if (it.url) window.open(it.url, '_blank', 'noopener'); }
    else if (act === 'save') this.store.setState(id, { saved: !it.saved });
    else if (act === 'read') this.store.setState(id, { read: !it.read });
    else if (act === 'archive') { this.store.setState(id, { archived: true }); if (this.expandedId === id) this.expandedId = null; }
    else if (act === 'images') this.loadImages(id);
  }

  loadImages(id) {
    const row = this.rowEl(id); if (!row) return;
    row.querySelectorAll('.icontent img[data-weir-src]').forEach((img) => {
      const m = img.getAttribute('data-weir-src') || '';
      img.setAttribute('src', m.replace(/^["']|["']$/g, ''));
      img.removeAttribute('data-weir-src');
    });
    row.querySelector('[data-act="images"]')?.remove();
  }

  setView(view) { this.view = view; this.feedFilter = null; this.route = null; this.selectedId = null; this.expandedId = null; this.renderAll(); }
  setRoute(name) { this.route = name; this.view = null; this.feedFilter = null; this.selectedId = null; this.expandedId = null; this.renderAll(); }

  onKey(e) {
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') {
        if (e.target === this.searchEl) { e.target.value = ''; this.searchText = ''; this.renderStream(); }
        else if (e.target.id === 'rules-text') { this.closeRules(); }
        e.target.blur();
      }
      return;
    }
    if (this._g) {
      this._g = false;
      if (e.key === 'i') return this.setView('inbox');
      if (e.key === 's') return this.setView('saved');
      if (e.key === 'a') return this.setView('archived');
      return;
    }
    switch (e.key) {
      case 'j': e.preventDefault(); this.moveSelection(1); break;
      case 'k': e.preventDefault(); this.moveSelection(-1); break;
      case 'Enter': if (this.selectedId) { e.preventDefault(); this.toggleExpand(this.selectedId); } break;
      case 'Escape': if (this.expandedId) this.collapse(); break;
      case 'r': if (this.selectedId) this.doAct('read', this.selectedId); break;
      case 's': if (this.selectedId) this.doAct('save', this.selectedId); break;
      case 'e': if (this.selectedId) { const cur = this.selectedId; this.moveSelection(1); this.doAct('archive', cur); } break;
      case 'o': if (this.selectedId) this.doAct('open', this.selectedId); break;
      case 'g': this._g = true; setTimeout(() => { this._g = false; }, 800); break;
      case '/': e.preventDefault(); this.searchEl.focus(); break;
      default: break;
    }
  }

  async addFeed(url) {
    let host = url; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
    const adapter = this.adapters.find((a) => { try { return a.match(url); } catch { return false; } })?.name || 'feed';
    try {
      const feed = await this.store.putFeed({ url, name: host, adapter });
      this.renderRail();
      this.setView('inbox');
      const input = document.getElementById('addfeed-input'); if (input) input.value = '';
      await this.poller.pollFeed(feed);
      this.renderPollStatus();
    } catch (e) {
      console.error('addFeed failed', e);
      document.getElementById('view-sub').textContent = `couldn't add feed: ${e.message}`;
    }
  }

  // ── OPML ──
  importOpml(text) {
    const feeds = parseOpml(text);
    if (!feeds.length) { document.getElementById('view-sub').textContent = 'OPML had no feeds'; return; }
    this.pendingImport = { feeds, youtube: feeds.filter((f) => f.kind === 'youtube').length };
    this.renderStream();
  }

  async runImport(mode) {
    const pending = this.pendingImport;
    this.pendingImport = null;
    if (mode === 'cancel' || !pending) { this.renderAll(); return; }
    const list = pending.feeds.filter((f) => mode === 'all' || f.kind !== 'youtube');
    // Spread next_poll_at so a big import doesn't hammer every source at once.
    const t = Date.now();
    let i = 0;
    for (const f of list) {
      await this.store.putFeed({
        url: f.xmlUrl, name: f.title, site_url: f.htmlUrl,
        adapter: f.kind === 'youtube' ? 'youtube' : 'feed',
        category: f.category, next_poll_at: t + (i++ * 1500),
      });
    }
    document.getElementById('view-sub').textContent = `imported ${list.length} feeds — polling…`;
    this.setView('inbox');
  }

  exportOpml() {
    const xml = buildOpml(this.store.listFeeds(), 'weir feeds');
    const blob = new Blob([xml], { type: 'text/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'weir-feeds.opml'; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  renderRoutes() {
    const el = document.getElementById('routes'); const sec = document.getElementById('routes-section');
    if (!el || !sec) return;
    const routes = this.store.counts().routes;
    const names = Object.keys(routes).sort();
    sec.style.display = names.length ? '' : 'none';
    el.innerHTML = names.map((n) =>
      `<div class="navrow${this.route === n ? ' active' : ''}" data-route="${escapeHtml(n)}"><span class="lbl"><span class="ico">#</span> ${escapeHtml(n)}</span><span class="count">${routes[n]}</span></div>`).join('');
  }

  renderNotify() {
    const el = document.getElementById('notify-status'); if (!el) return;
    const n = this.store.notifications.length;
    el.textContent = n ? `🔔 ${n}` : '';
  }

  // ── feed archaeology (Wayback recovery) ──
  async recoverHistory(feedId) {
    const feed = this.store.getFeed(feedId);
    if (!feed) return;
    const s = this.store.getSettings();
    const btn = document.getElementById('btn-recover');
    const setPoll = (t) => { const el = document.getElementById('poll-status'); if (el) el.textContent = t; };
    if (btn) btn.disabled = true;
    setPoll(`recovering ${feed.name} from the archive…`);
    try {
      const r = await recoverFeed(feed.url, {
        fetch: this.poller.fetch, parseFeed, feed,
        maxSnapshots: s.wayback_max_snapshots, minIntervalMs: s.wayback_min_interval_ms,
        onProgress: (p) => setPoll(`recovering ${feed.name}: ${p.fetched}/${p.total} snapshots · ${p.items} items`),
      });
      const up = await this.store.upsertItems(r.items);
      await this.store.flush();
      setPoll(`recovered ${up.inserted} new from ${r.fetched}/${r.total} snapshots${r.failed ? ` (${r.failed} failed)` : ''}`);
      this.renderAll();
    } catch (e) {
      setPoll(`recovery failed: ${e.message}`);
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── routing rules editor ──
  async openRules() {
    const cur = await this.store.getRouting();
    document.getElementById('rules-text').value = cur && cur.trim() ? cur : DEFAULT_ROUTING;
    document.getElementById('rules-error').textContent = this.router?.error ? `error: ${this.router.error}` : '';
    document.getElementById('rules-overlay').hidden = false;
    document.getElementById('rules-text').focus();
  }
  closeRules() { document.getElementById('rules-overlay').hidden = true; }
  async saveRules() {
    const text = document.getElementById('rules-text').value;
    await this.store.setRouting(text);
    const err = this.router.load(text);
    document.getElementById('rules-error').textContent = err ? `error: ${err}` : 'saved ✓ (applies to new items)';
    if (!err) setTimeout(() => this.closeRules(), 700);
  }
  uiRerunRules() {
    const r = this.store.rerunRules();
    document.getElementById('rules-error').textContent = `re-ran over history — ${r.matched} item${r.matched === 1 ? '' : 's'} matched`;
    this.renderAll();
  }

  renderPollStatus() {
    const el = document.getElementById('poll-status'); if (!el) return;
    const last = this.poller.lastPollAt ? `last ${relativeTime(this.poller.lastPollAt)}` : 'idle';
    const nextAt = this.poller.nextPollAt();
    const next = nextAt ? ` · next ${nextAt <= Date.now() ? 'due' : 'in ' + relativeTime(2 * Date.now() - nextAt)}` : '';
    el.textContent = last + next;
  }
}
