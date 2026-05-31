// UI controller (SPEC §4). Vanilla DOM: renders the rail + stream from the store,
// handles keyboard nav and inline expand-to-read, and drives the poller. Plain
// re-render on store events (fine at v0.1 scale); selection/expansion are app
// state, content is cached to avoid re-reading on every keystroke.

import { relativeTime, isoTitle, escapeHtml, fmtDuration, fmtCount, fmtBytes, dailyCounts, sparkPoints } from './format.js';
import { parseOpml, buildOpml } from '../opml.js';
import { DEFAULT_ROUTING } from '../router.js';
import { parseWatchDigest } from '../affinity.js';
import { showMenu } from './menu.js';
import { extractArticle } from '../extract.js';
import { checkForUpdateNow, setAutoCheck } from '../pwa.js';
import { recoverFeed } from '../wayback.js';
import { parseFeed } from '../adapters/feed.js';
import { monogram } from '../favicon.js';
import { assessFeed } from '../health.js';

const VIEW_LABELS = { inbox: 'Inbox', saved: 'Saved', archived: 'Archived' };
const TEXT_TYPES = new Set(['article', 'paper', 'release', 'track', 'status', 'commit', 'issue']);
const RENDER_CAP = 300;
const RAIL_CAP = 60;
// Default folder order in the rail (active-first; dead-heavy topics like geo sink).
const CAT_ORDER = ['dev', 'hardware', 'ideas', 'tech', 'games', 'comics-art', 'fiction', 'data', 'cloud', 'news', 'geo', 'personal'];

export class App {
  constructor({ store, poller, router, adapters, faviconFetcher }) {
    this.store = store;
    this.poller = poller;
    this.router = router;
    this.adapters = adapters || [];
    this.faviconFetcher = faviconFetcher || null;
    this.view = 'inbox';
    this.feedFilter = null;
    this.route = null;          // active routed view (#name), or null
    this.catFilter = null;      // active folder/category view, or null
    this.smartView = null;      // active saved view (smart folder), or null
    this.collapsedCats = new Set();
    this._loadingFull = new Set();   // items with a full-content fetch in flight
    this._fullTried = new Set();     // items whose auto full-fetch already failed (don't retry on every open)
    this.searchText = '';
    this.selectedId = null;
    this.expandedId = null;
    this.items = [];
    this._content = new Map();   // id → sanitized html (cache)
    this._health = new Map();    // feed_id → {status, reasons} for non-ok feeds (hijack/stale/failing)
    this._g = false;
    this.pendingImport = null;   // { feeds, youtube } awaiting confirmation
  }

  mount() {
    this.stream = document.getElementById('stream');
    this.sources = document.getElementById('sources');
    this.searchEl = document.getElementById('search-input');

    // Counts update live (cheap, no flicker); the rail+stream rebuild is debounced
    // so a burst of poll inserts doesn't tear the rows out from under the cursor.
    for (const ev of ['items', 'prune']) this.store.on(ev, () => { this.renderCounts(); this._scheduleRender(); });
    this.store.on('item', () => this.renderCounts());   // single state changes refresh their row in-place via doAct
    this.store.on('feed', () => this._scheduleRender());
    this.poller.on('polled', () => this.renderPollStatus());
    this.poller.on('cycle', () => this.renderPollStatus());

    document.querySelectorAll('.navrow[data-view]').forEach((row) => {
      row.addEventListener('click', () => this.setView(row.dataset.view));
      row.addEventListener('contextmenu', (e) => { e.preventDefault(); this.viewMenu(row.dataset.view, e.clientX, e.clientY); });
    });
    this.sources.addEventListener('click', (e) => {
      const head = e.target.closest('.cat-head');
      if (head) {
        if (e.target.closest('.cat-toggle')) this.toggleCat(head.dataset.cat);
        else this.setCategory(head.dataset.cat);
        return;
      }
      const s = e.target.closest('.source'); if (!s) return;
      this.catFilter = null; this.route = null; this.smartView = null;
      this.feedFilter = this.feedFilter === s.dataset.feed ? null : s.dataset.feed;
      this.renderAll();
    });
    this.stream.addEventListener('click', (e) => this.onStreamClick(e));
    this.stream.addEventListener('auxclick', (e) => { if (e.button !== 1) return; const row = e.target.closest('.item'); if (!row) return; const it = this.store.getItem(row.dataset.id); if (it?.url) { e.preventDefault(); window.open(it.url, '_blank', 'noopener'); } });
    this.stream.addEventListener('contextmenu', (e) => { const row = e.target.closest('.item'); if (!row) return; e.preventDefault(); this.select(row.dataset.id); this.itemMenu(row.dataset.id, e.clientX, e.clientY); });
    this.sources.addEventListener('contextmenu', (e) => {
      const s = e.target.closest('.source'); const h = e.target.closest('.cat-head');
      if (s) { e.preventDefault(); this.feedMenu(s.dataset.feed, e.clientX, e.clientY); }
      else if (h) { e.preventDefault(); this.catMenu(h.dataset.cat, e.clientX, e.clientY); }
    });

    const form = document.getElementById('addfeed');
    form.addEventListener('submit', (e) => { e.preventDefault(); const v = form.querySelector('input').value.trim(); if (v) this.addFeed(v); });
    this.searchEl.addEventListener('input', () => { this.searchText = this.searchEl.value.trim(); this.renderStream(); this.renderTopbar(); });

    const fileEl = document.getElementById('opml-file');
    document.getElementById('btn-import')?.addEventListener('click', () => fileEl.click());
    fileEl?.addEventListener('change', async () => {
      const texts = [];
      for (const f of fileEl.files) texts.push(await f.text());
      fileEl.value = '';
      if (texts.length) this.importOpmlFiles(texts);
    });
    document.getElementById('btn-export')?.addEventListener('click', () => this.exportOpml());

    document.getElementById('routes')?.addEventListener('click', (e) => { const r = e.target.closest('[data-route]'); if (r) this.setRoute(r.dataset.route); });
    const sv = document.getElementById('smart-views');
    sv?.addEventListener('click', (e) => { const r = e.target.closest('[data-view-id]'); if (r) this.setSmartView(r.dataset.viewId); });
    sv?.addEventListener('contextmenu', (e) => { const r = e.target.closest('[data-view-id]'); if (r) { e.preventDefault(); this.smartViewMenu(r.dataset.viewId, e.clientX, e.clientY); } });
    document.getElementById('btn-saveview')?.addEventListener('click', () => this.saveSearchAsView());
    this.store.on('views', () => this.renderViews());
    document.getElementById('btn-recover')?.addEventListener('click', () => { if (this.feedFilter) this.recoverHistory(this.feedFilter); });
    document.getElementById('open-rules')?.addEventListener('click', () => this.openRules());
    document.getElementById('open-settings')?.addEventListener('click', () => this.openSettings());
    document.getElementById('settings-save')?.addEventListener('click', () => this.saveSettings());
    document.getElementById('settings-close')?.addEventListener('click', () => this.closeSettings());
    document.getElementById('set-request-persist')?.addEventListener('click', () => this.requestPersist());
    document.getElementById('set-check-update')?.addEventListener('click', () => this.checkUpdates());
    document.getElementById('open-help')?.addEventListener('click', () => this.openHelp());
    document.getElementById('help-close')?.addEventListener('click', () => this.closeHelp());
    document.getElementById('health-status')?.addEventListener('click', () => this.openHealth());
    document.getElementById('health-close')?.addEventListener('click', () => this.closeHealth());
    document.getElementById('health-body')?.addEventListener('click', (e) => this.onHealthClick(e));
    const affFile = document.getElementById('affinity-file');
    document.getElementById('set-import-affinity')?.addEventListener('click', () => affFile.click());
    affFile?.addEventListener('change', async () => { const f = affFile.files[0]; if (f) await this.importWatchData(await f.text()); affFile.value = ''; });
    document.getElementById('feededit-save')?.addEventListener('click', () => this.saveFeedEdit());
    document.getElementById('feededit-close')?.addEventListener('click', () => this.closeFeedEdit());
    document.getElementById('rules-save')?.addEventListener('click', () => this.saveRules());
    document.getElementById('rules-rerun')?.addEventListener('click', () => this.uiRerunRules());
    document.getElementById('rules-close')?.addEventListener('click', () => this.closeRules());
    this.store.on('notify', () => this.renderNotify());

    document.getElementById('set-density')?.addEventListener('change', (e) => this._setDensity(e.target.value));

    this._initRailResize();
    this._setDensity(this.store.getSettings().density);
    document.addEventListener('keydown', (e) => this.onKey(e));
    setInterval(() => this.renderPollStatus(), 30_000);

    this.renderAll();
    this.renderNotify();
    this.renderPollStatus();
  }

  query() {
    if (this.smartView) return this.store.query({ ...this.smartView.query, text: this.searchText || this.smartView.query.text || undefined });
    if (this.route) return this.store.query({ route: this.route, text: this.searchText || undefined });
    if (this.catFilter != null) return this.store.query({ category: this.catFilter, text: this.searchText || undefined });   // '' = ungrouped
    return this.store.query({ view: this.view, feed_id: this.feedFilter || undefined, text: this.searchText || undefined });
  }

  renderAll() { this.renderCounts(); this.renderRail(); this.renderRoutes(); this.renderViews(); this.renderTopbar(); this.renderStream(); }

  // Debounced rail+stream rebuild for store-driven changes (polling), so rows
  // aren't recreated under the cursor on every insert.
  _scheduleRender() {
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => { this._renderTimer = null; this.renderRail(); this.renderRoutes(); this.renderViews(); this.renderStream(); }, 250);
  }

  // Replace a single row in place — instant feedback for a click action, no
  // full-stream rebuild (so no flicker).
  _refreshRow(id) {
    const row = this.rowEl(id); const it = this.store.getItem(id);
    if (!row || !it) return;
    const wrap = document.createElement('div'); wrap.innerHTML = this.rowHtml(it);
    const fresh = wrap.firstElementChild; if (fresh) row.replaceWith(fresh);
  }

  renderCounts() {
    const c = this.store.counts();
    const set = (id, n) => { const el = document.getElementById(id); if (el) el.textContent = n; };
    set('count-inbox', c.inbox); set('count-saved', c.saved); set('count-archived', c.archived);
  }

  renderTopbar() {
    const feed = this.feedFilter && this.store.getFeed(this.feedFilter);
    const rb = document.getElementById('btn-recover'); if (rb) rb.hidden = !this.feedFilter;
    document.getElementById('view-title').textContent = this.smartView ? this.smartView.name : this.catFilter != null ? (this.catFilter || 'ungrouped') : this.route ? `#${this.route}` : feed ? feed.name : (VIEW_LABELS[this.view] || this.view);
    const n = this.items.length;
    const feeds = this.store.listFeeds().length;
    let sub;
    if (this.searchText) sub = `${n} match${n === 1 ? '' : 'es'} for “${this.searchText}”`;
    else if (!feeds) sub = 'no feeds yet';
    else sub = `${n} item${n === 1 ? '' : 's'}${feed ? '' : ` · ${feeds} source${feeds === 1 ? '' : 's'}`}`;
    document.getElementById('view-sub').textContent = sub;
    this._reflectSearch();
  }

  feedUnread(id) {
    let n = 0; const ids = this.store.byFeed.get(id) || new Set();
    for (const i of ids) { const r = this.store.items.get(i); if (r && !r.read && !r.archived) n++; }
    return n;
  }

  sourceRow(f) {
    const ids = this.store.byFeed.get(f.id) || new Set();
    const times = []; let unread = 0;
    for (const id of ids) { const r = this.store.items.get(id); if (!r) continue; if (r.published_at) times.push(r.published_at); if (!r.read && !r.archived) unread++; }
    const pts = sparkPoints(dailyCounts(times, 7));
    const cls = f.state === 'failing' || f.state === 'archived' ? 'dead' : f.state === 'slow' ? 'slow' : 'up';
    const active = this.feedFilter === f.id ? ' active' : '';
    const spark = pts ? `<svg width="40" height="12" viewBox="0 0 44 13"><polyline points="${pts}" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/></svg>` : '';
    const icon = f.favicon
      ? `<img class="favi" src="${escapeHtml(f.favicon)}" alt="" loading="lazy">`
      : (() => { const m = monogram(f); return `<span class="favi mono" style="--mh:${m.hue}">${escapeHtml(m.ch)}</span>`; })();
    const fav = f.affinity >= 100 ? ' <span class="fav">★</span>' : '';
    const aff = f.affinity ? ` · watch-affinity ${f.affinity}` : '';
    const health = this._health.get(f.id);
    const hcls = health ? ` ${health.status}` : '';
    const hbadge = health ? `<span class="hbadge ${health.status}">${health.status === 'stale' ? '◌' : '⚠'}</span>` : '';
    const htip = health ? ` — ${health.status}: ${health.reasons.join('; ')}` : (f.feed_health?.last_error ? ' — ' + f.feed_health.last_error : '');
    return `<div class="source ${cls}${hcls}${active}" data-feed="${escapeHtml(f.id)}" title="${escapeHtml(f.name)}${aff}${escapeHtml(htip)}">`
      + `<span class="sicon">${icon}</span><span class="sname">${escapeHtml(f.name)}${fav}${hbadge}</span><span class="spark">${spark}</span><span class="scount">${unread || ''}</span></div>`;
  }

  // Classify every feed from its stored items (hijack/drift/stale/failing).
  // Cheap heuristics, no network; only non-ok results are cached. See health.js.
  recomputeHealth() {
    const staleDays = this.store.getSettings().feed_stale_days || 120;
    this._health.clear();
    for (const f of this.store.listFeeds()) {
      const ids = this.store.byFeed.get(f.id) || new Set();
      const items = [];
      for (const id of ids) { const r = this.store.items.get(id); if (r) items.push(r); }
      const h = assessFeed(f, items, Date.now(), { staleDays });
      if (h.status !== 'ok') this._health.set(f.id, h);
    }
  }

  renderHealthStatus() {
    const el = document.getElementById('health-status'); if (!el) return;
    let suspect = 0, failing = 0, stale = 0;
    for (const h of this._health.values()) { if (h.status === 'suspect') suspect++; else if (h.status === 'failing') failing++; else if (h.status === 'stale') stale++; }
    const parts = [];
    if (suspect) parts.push(`⚠ ${suspect} suspect`);
    if (failing) parts.push(`${failing} failing`);
    if (stale) parts.push(`${stale} stale`);
    el.textContent = parts.join(' · ');
    el.classList.toggle('clickable', parts.length > 0);
    el.classList.toggle('alert', suspect > 0 || failing > 0);
  }

  renderRail() {
    const feeds = this.store.listFeeds();
    this.faviconFetcher?.enqueue(feeds);   // lazily backfill site icons (polite, once each)
    this.recomputeHealth();
    this.renderHealthStatus();
    document.querySelectorAll('.navrow[data-view]').forEach((r) =>
      r.classList.toggle('active', !this.feedFilter && !this.route && !this.smartView && this.catFilter == null && r.dataset.view === this.view));
    if (!feeds.length) { this.sources.innerHTML = '<div class="rail-empty">No sources yet</div>'; return; }

    const groups = new Map();
    for (const f of feeds) { const c = f.category || ''; (groups.get(c) || groups.set(c, []).get(c)).push(f); }

    // No folders → flat list (single-feed users); else grouped, ordered, collapsible.
    if (![...groups.keys()].some((c) => c)) {
      this.sources.innerHTML = feeds.slice(0, RAIL_CAP).map((f) => this.sourceRow(f)).join('')
        + (feeds.length > RAIL_CAP ? `<div class="rail-empty">+ ${feeds.length - RAIL_CAP} more</div>` : '');
      return;
    }

    const rank = (c) => { const i = CAT_ORDER.indexOf(c); return i < 0 ? 90 : i; };
    const cats = [...groups.keys()].sort((a, b) => (a === '' ? 1 : b === '' ? -1 : rank(a) - rank(b) || a.localeCompare(b)));

    let html = '';
    for (const c of cats) {
      // Most-watched first within a folder (affinity), then alphabetical.
      const list = groups.get(c).sort((x, y) => (y.affinity || 0) - (x.affinity || 0) || x.name.localeCompare(y.name));
      const collapsed = this.collapsedCats.has(c);
      const unread = list.reduce((n, f) => n + this.feedUnread(f.id), 0);
      const activeCat = this.catFilter === c ? ' active' : '';
      html += `<div class="cat-head${activeCat}" data-cat="${escapeHtml(c)}">`
        + `<span class="cat-toggle">${collapsed ? '▸' : '▾'}</span>`
        + `<span class="cat-name">${escapeHtml(c || 'ungrouped')}</span>`
        + `<span class="cat-count">${unread || list.length}</span></div>`;
      if (!collapsed) html += `<div class="cat-feeds">${list.map((f) => this.sourceRow(f)).join('')}</div>`;
    }
    this.sources.innerHTML = html;
  }

  setCategory(cat) { this.catFilter = cat == null ? null : cat; this.view = null; this.feedFilter = null; this.route = null; this.smartView = null; this.selectedId = null; this.expandedId = null; this.renderAll(); }
  toggleCat(c) { if (this.collapsedCats.has(c)) this.collapsedCats.delete(c); else this.collapsedCats.add(c); this.renderRail(); }

  setSmartView(id) {
    const v = this.store.getViews().find((x) => x.id === id);
    if (!v) return;
    this.smartView = v;
    this.view = null; this.feedFilter = null; this.route = null; this.catFilter = null;
    this.selectedId = null; this.expandedId = null;
    this.renderAll();
  }

  renderStream() {
    if (this.pendingImport) { this.stream.innerHTML = this.importReviewHtml(); return; }
    const scrollTop = this.stream.scrollTop;   // preserve scroll across rebuild
    this.items = this.query();
    if (this.selectedId && !this.items.some((x) => x.id === this.selectedId)) this.selectedId = null;
    if (!this.selectedId && this.items.length) this.selectedId = this.items[0].id;

    if (!this.items.length) { this.stream.innerHTML = this.emptyHtml(); return; }
    const shown = this.items.slice(0, RENDER_CAP);
    let html = shown.map((it) => this.rowHtml(it)).join('');
    if (this.items.length > RENDER_CAP) html += `<div class="more">+ ${this.items.length - RENDER_CAP} more not shown</div>`;
    this.stream.innerHTML = html;
    this.stream.scrollTop = scrollTop;
    this.renderTopbar();
  }

  emptyHtml() {
    const hasFeeds = this.store.listFeeds().length > 0;
    if (hasFeeds) return `<div class="empty">Nothing in ${escapeHtml(VIEW_LABELS[this.view] || this.view)}${this.searchText ? ' for that search' : ''}.</div>`;
    return `<section class="onboard">
      <div class="onboard-glyph">⬓</div>
      <h2>No feeds yet</h2>
      <p>Import an OPML export (Inoreader, Feedly, …) — you can pick several files at once. Or paste a single feed URL in the box up top.</p>
      <div class="onboard-actions">
        <button class="btn btn-primary" data-onboard="import">Import OPML…</button>
      </div>
      <p class="onboard-or">or try one:</p>
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
    const actions = `<div class="iactions">`
      + `<button data-act="save" title="${it.saved ? 'Unsave' : 'Save'} (s)">${it.saved ? '★' : '☆'}</button>`
      + `<button data-act="read" title="Mark ${it.read ? 'unread' : 'read'} (r)">${it.read ? '○' : '●'}</button>`
      + `<button data-act="archive" title="Archive (e)">⌫</button>`
      + (it.url ? `<button data-act="open" title="Open original (o)">↗</button>` : '')
      + `</div>`;
    return `<article class="${cls}" data-id="${escapeHtml(it.id)}"><div class="pillcol"><span class="pill ${escapeHtml(it.type)}">${escapeHtml(it.type)}</span></div>`
      + `<div class="ibody">${actions}${body}<div class="iexpand">${it.id === this.expandedId ? this.expandedHtml(it) : ''}</div></div></article>`;
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
    if (it.url && !it.full) inner += '<button data-act="fullcontent">load full article ↡</button>';
    if (it.url) inner += '<button data-act="open">open original ↗</button>';
    inner += `<button data-act="save">${it.saved ? 'unsave' : 'save'}</button>`;
    inner += '<button data-act="archive">archive</button>';
    if (suppressed) inner += '<button data-act="images">load images</button>';
    inner += '</div>';
    return inner;
  }

  importReviewHtml() {
    const { feeds, youtube, files } = this.pendingImport;
    const total = feeds.length, feedsOnly = total - youtube;
    const desc = (youtube && feedsOnly)
      ? `${feedsOnly} feeds + ${youtube} YouTube subscriptions${files > 1 ? ` from ${files} files` : ''}. You can leave the YouTube subs out for now and add them later.`
      : youtube
        ? `${youtube} YouTube channels${files > 1 ? ` from ${files} files` : ''}.`
        : `${total} feeds${files > 1 ? ` from ${files} files` : ''}, ready to import.`;
    return `<section class="onboard">
      <div class="onboard-glyph">⬓</div>
      <h2>Import ${total} feed${total === 1 ? '' : 's'}</h2>
      <p>${desc}</p>
      <div class="onboard-actions">
        <button class="btn" data-import="all">Import all (${total})</button>
        ${(youtube && feedsOnly) ? `<button class="btn" data-import="feeds">Feeds only (${feedsOnly})</button>` : ''}
        <button class="btn" data-import="cancel">Cancel</button>
      </div>
    </section>`;
  }

  // ── interaction ──
  onStreamClick(e) {
    const onb = e.target.closest('[data-onboard]');
    if (onb) { if (onb.dataset.onboard === 'import') document.getElementById('opml-file')?.click(); return; }
    const imp = e.target.closest('[data-import]');
    if (imp) { this.runImport(imp.dataset.import); return; }
    const sample = e.target.closest('[data-sample]');
    if (sample) { document.getElementById('addfeed-input').value = sample.dataset.sample; this.addFeed(sample.dataset.sample); return; }
    const btn = e.target.closest('[data-act]');
    const row = e.target.closest('.item');
    if (!row) return;
    const id = row.dataset.id;
    if (btn) { e.stopPropagation(); this.doAct(btn.dataset.act, id); return; }
    if (e.metaKey || e.ctrlKey) { const it = this.store.getItem(id); if (it?.url) window.open(it.url, '_blank', 'noopener'); return; }
    if (e.target.closest('.iexpand')) return;   // clicks inside the open article (links, text) — leave alone
    this.select(id);
    this.toggleExpand(id);   // click the row to open/close the inline reader
  }

  select(id) {
    this.selectedId = id;
    this.stream.querySelectorAll('.item').forEach((r) => r.classList.toggle('sel', r.dataset.id === id));
    const row = this.rowEl(id);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }

  rowEl(id) { return this.stream.querySelector(`.item[data-id="${(window.CSS && CSS.escape) ? CSS.escape(id) : id}"]`); }

  // Reflect one item's new state in the DOM: refresh its row if it still matches
  // the current view, remove it if not, and keep this.items + the topbar in sync.
  // Single place every action site uses, so no path forgets to re-render.
  reflectItem(id) {
    this.items = this.query();
    const visible = this.items.some((x) => x.id === id);
    const row = this.rowEl(id);
    if (!visible) { if (row) row.remove(); }
    else if (row) this._refreshRow(id);
    else this._scheduleRender();
    this.renderTopbar();
  }

  toggleExpand(id) { if (this.expandedId === id) this.collapse(); else this.expand(id); }
  expand(id) {
    this.expandedId = id; this.selectedId = id;
    const it = this.store.getItem(id);
    if (it && !it.read) this.store.setState(id, { read: true });   // counts update via 'item'
    this.renderStream();
    const row = this.rowEl(id); if (row) row.scrollIntoView({ block: 'nearest' });
    const feed = it && this.store.getFeed(it.feed_id);
    if (feed?.fetch_full_content && it && it.url && !it.full && !this._fullTried.has(id)) this.loadFullContent(id);   // auto-fetch full text (once)
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
    if (act === 'open') { if (it.url) window.open(it.url, '_blank', 'noopener'); return; }
    if (act === 'fullcontent') { this.loadFullContent(id); return; }
    if (act === 'images') { this.loadImages(id); return; }
    if (act === 'save') { this.store.setState(id, { saved: !it.saved }); this.reflectItem(id); return; }
    if (act === 'read') { this.store.setState(id, { read: !it.read }); this.reflectItem(id); return; }
    if (act === 'archive') {
      this.store.setState(id, { archived: true });
      if (this.expandedId === id) this.expandedId = null;
      if (this.view !== 'archived') this.showUndo(`Archived “${it.title}”`, () => { this.store.setState(id, { archived: false }); this.reflectItem(id); });
      this.reflectItem(id);   // removes it from the inbox view (or refreshes in Archived)
    }
  }

  // Brief undo toast for forgiving one-key/one-click actions.
  showUndo(message, onUndo) {
    const el = document.getElementById('undo-toast'); if (!el) return;
    el.querySelector('.undo-msg').textContent = message;
    const btn = el.querySelector('#undo-btn');
    const fresh = btn.cloneNode(true); btn.replaceWith(fresh);   // drop old listeners
    fresh.addEventListener('click', () => { el.classList.remove('on'); clearTimeout(this._undoTimer); try { onUndo(); } catch {} this.renderAll(); });
    el.classList.add('on');
    clearTimeout(this._undoTimer);
    this._undoTimer = setTimeout(() => el.classList.remove('on'), 6000);
  }

  // Fetch the item's page through the bridge, extract the main article, store it.
  async loadFullContent(id) {
    const it = this.store.getItem(id);
    if (!it || !it.url || this._loadingFull.has(id)) return;   // de-dup concurrent fetches
    this._loadingFull.add(id);
    const setMsg = (msg) => { const s = this.rowEl(id)?.querySelector('.iexpand .icontent'); if (s) { s.classList.add('loading'); s.textContent = msg; } };
    setMsg('fetching full article…');
    try {
      const res = await this.poller.fetch(it.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);   // don't cache 4xx/5xx error pages as the article
      const html = await res.text();
      const feed = this.store.getFeed(it.feed_id);
      const article = extractArticle(html, it.url, { allowImages: feed?.images_allowed });
      if (!article) { this._fullTried.add(id); setMsg('Couldn’t extract the article — open the original instead.'); return; }
      await this.store.setContent(id, article, { full: true });
      this._content.set(id, article);
      if (this.expandedId === id) this.renderStream();   // only re-render if still open
    } catch (e) {
      this._fullTried.add(id);
      setMsg(`Fetch failed: ${e.message}`);
    } finally {
      this._loadingFull.delete(id);
    }
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

  // ── context menus ──
  itemMenu(id, x, y) {
    const it = this.store.getItem(id); if (!it) return;
    showMenu(x, y, [
      it.url && { label: 'Open original ↗', onClick: () => window.open(it.url, '_blank', 'noopener') },
      { label: this.expandedId === id ? 'Close' : 'Open here', onClick: () => this.toggleExpand(id) },
      { sep: true },
      { label: it.saved ? 'Unsave' : 'Save', onClick: () => this.doAct('save', id) },
      { label: it.read ? 'Mark unread' : 'Mark read', onClick: () => this.doAct('read', id) },
      { label: it.archived ? 'Unarchive' : 'Archive', onClick: () => { if (it.archived) { this.store.setState(id, { archived: false }); this.reflectItem(id); } else this.doAct('archive', id); } },
      it.url && { label: 'Copy link', onClick: () => navigator.clipboard?.writeText(it.url).catch(() => {}) },
    ].filter(Boolean));
  }

  feedMenu(feedId, x, y) {
    const feed = this.store.getFeed(feedId); if (!feed) return;
    showMenu(x, y, [
      { label: 'Show only this feed', onClick: () => { this.catFilter = null; this.route = null; this.smartView = null; this.feedFilter = feedId; this.renderAll(); } },
      (feed.site_url || feed.url) && { label: 'Open site ↗', onClick: () => window.open(feed.site_url || feed.url, '_blank', 'noopener') },
      { sep: true },
      { label: 'Mark all read', onClick: () => this.store.markAllRead({ feed_id: feedId }) },
      { label: 'Edit feed…', onClick: () => this.openFeedEdit(feedId) },
      { label: feed.images_allowed ? 'Block images' : 'Always load images', onClick: () => this.store.updateFeed(feedId, { images_allowed: !feed.images_allowed }) },
      { label: feed.fetch_full_content ? 'Don’t auto-fetch full text' : 'Auto-fetch full text', onClick: () => this.store.updateFeed(feedId, { fetch_full_content: !feed.fetch_full_content }) },
      { label: 'Recover history…', onClick: () => this.recoverHistory(feedId) },
      { sep: true },
      { label: 'Remove feed', danger: true, onClick: () => { if (confirm(`Remove "${feed.name}" and its items?`)) { this.store.removeFeed(feedId); if (this.feedFilter === feedId) this.feedFilter = null; this.renderAll(); } } },
    ].filter(Boolean));
  }

  openFeedEdit(feedId) {
    const feed = this.store.getFeed(feedId); if (!feed) return;
    this._editingFeed = feedId;
    const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    val('fe-name', feed.name || '');
    val('fe-url', feed.url || '');
    val('fe-folder', feed.category || '');
    chk('fe-images', feed.images_allowed);
    chk('fe-full', feed.fetch_full_content);
    chk('fe-clear', false);
    const count = (this.store.byFeed.get(feedId) || new Set()).size;
    document.getElementById('fe-itemcount').textContent = `${count} item${count === 1 ? '' : 's'}`;
    document.getElementById('feededit-msg').textContent = '';
    document.getElementById('feededit-overlay').hidden = false;
    document.getElementById('fe-name').focus();
  }

  closeFeedEdit() { document.getElementById('feededit-overlay').hidden = true; this._editingFeed = null; }

  async saveFeedEdit() {
    const feedId = this._editingFeed;
    const feed = feedId && this.store.getFeed(feedId);
    if (!feed) return this.closeFeedEdit();
    const v = (id) => document.getElementById(id).value.trim();
    const chk = (id) => document.getElementById(id).checked;
    const name = v('fe-name'); const url = v('fe-url');
    if (!url) { document.getElementById('feededit-msg').textContent = 'feed URL is required'; return; }
    try { new URL(url); } catch { document.getElementById('feededit-msg').textContent = 'not a valid URL'; return; }

    const urlChanged = url !== feed.url;
    const patch = {
      name: name || feed.name,
      url,
      category: v('fe-folder') || undefined,
      images_allowed: chk('fe-images'),
      fetch_full_content: chk('fe-full'),
    };
    if (urlChanged) patch.next_poll_at = Date.now();   // re-point → poll the new source now
    await this.store.updateFeed(feedId, patch);
    if (chk('fe-clear')) await this.store.clearFeedItems(feedId);
    this.closeFeedEdit();
    this.renderAll();
    if (urlChanged) {   // fetch immediately so the new source's items appear without waiting for the cycle
      const fresh = this.store.getFeed(feedId);
      if (fresh) this.poller.pollFeed(fresh).then(() => this.renderAll()).catch(() => {});
    }
  }

  openHelp() { document.getElementById('help-overlay').hidden = false; }
  closeHelp() { document.getElementById('help-overlay').hidden = true; }

  // Feed-health overlay — the flagged feeds with their reasons + one-click fix.
  openHealth() {
    const rank = { suspect: 0, failing: 1, stale: 2 };
    const ico = { suspect: '⚠', failing: '⚠', stale: '◌' };
    const rows = this.store.listFeeds()
      .map((f) => ({ f, h: this._health.get(f.id) })).filter((x) => x.h)
      .sort((a, b) => (rank[a.h.status] - rank[b.h.status]) || a.f.name.localeCompare(b.f.name));
    const body = rows.map(({ f, h }) => `<div class="health-row" data-feed="${escapeHtml(f.id)}">`
      + `<div class="hr-head"><span class="hbadge ${h.status}">${ico[h.status]}</span>`
      + `<span class="hr-name">${escapeHtml(f.name)}</span><span class="hr-status ${h.status}">${h.status}</span></div>`
      + `<div class="hr-why">${escapeHtml(h.reasons.join(' · '))}</div>`
      + `<div class="hr-actions"><button data-hact="edit">Edit feed…</button>`
      + ((f.site_url || f.url) ? `<button data-hact="open">Open site ↗</button>` : '')
      + `<button data-hact="view">Show items</button></div></div>`).join('')
      || '<div class="hint">All feeds look healthy — nothing flagged.</div>';
    document.getElementById('health-body').innerHTML = body;
    document.getElementById('health-overlay').hidden = false;
  }

  closeHealth() { document.getElementById('health-overlay').hidden = true; }

  onHealthClick(e) {
    const btn = e.target.closest('[data-hact]'); if (!btn) return;
    const row = e.target.closest('.health-row'); const feedId = row?.dataset.feed; if (!feedId) return;
    const feed = this.store.getFeed(feedId); if (!feed) return;
    if (btn.dataset.hact === 'edit') { this.closeHealth(); this.openFeedEdit(feedId); }
    else if (btn.dataset.hact === 'open') { window.open(feed.site_url || feed.url, '_blank', 'noopener'); }
    else if (btn.dataset.hact === 'view') { this.closeHealth(); this.catFilter = null; this.route = null; this.smartView = null; this.view = 'inbox'; this.feedFilter = feedId; this.renderAll(); }
  }

  catMenu(cat, x, y) {
    showMenu(x, y, [
      { label: 'View this folder', onClick: () => this.setCategory(cat) },
      { label: 'Mark all read', onClick: () => this.store.markAllRead({ category: cat }) },
      { label: this.collapsedCats.has(cat) ? 'Expand' : 'Collapse', onClick: () => this.toggleCat(cat) },
    ]);
  }

  viewMenu(view, x, y) {
    showMenu(x, y, [{ label: 'Mark all read', onClick: () => this.store.markAllRead({ view }) }]);
  }

  _reflectSearch() { const b = document.getElementById('btn-saveview'); if (b) b.hidden = !this.searchText || !!this.smartView; }

  setView(view) { this.view = view; this.feedFilter = null; this.route = null; this.catFilter = null; this.smartView = null; this.selectedId = null; this.expandedId = null; this.renderAll(); }
  setRoute(name) { this.route = name; this.view = null; this.feedFilter = null; this.catFilter = null; this.smartView = null; this.selectedId = null; this.expandedId = null; this.renderAll(); }

  onKey(e) {
    // Esc closes any open overlay first, from anywhere.
    if (e.key === 'Escape') {
      for (const id of ['help-overlay', 'settings-overlay', 'rules-overlay', 'feededit-overlay', 'health-overlay']) {
        const ov = document.getElementById(id);
        if (ov && !ov.hidden) { ov.hidden = true; return; }
      }
    }
    const tag = e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') {
      if (e.key === 'Escape') {
        if (e.target === this.searchEl) { e.target.value = ''; this.searchText = ''; this.renderStream(); }
        else if (e.target.id === 'rules-text') { this.closeRules(); }
        else if (e.target.closest('#settings-overlay')) { this.closeSettings(); }
        else if (e.target.closest('#feededit-overlay')) { this.closeFeedEdit(); }
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
      case '?': e.preventDefault(); this.openHelp(); break;
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
  importOpml(text) { return this.importOpmlFiles([text]); }

  // Combine one or more OPML files into a single review (dedup by feed URL across
  // files), so the whole curated set imports in one go.
  importOpmlFiles(texts) {
    const seen = new Set(); const feeds = [];
    for (const t of texts) {
      for (const f of parseOpml(t)) { if (seen.has(f.xmlUrl)) continue; seen.add(f.xmlUrl); feeds.push(f); }
    }
    if (!feeds.length) { document.getElementById('view-sub').textContent = 'no feeds in those file(s)'; return; }
    this.pendingImport = { feeds, youtube: feeds.filter((f) => f.kind === 'youtube').length, files: texts.length };
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

  _setRailWidth(px) { document.documentElement.style.setProperty('--rail-w', `${Math.round(px)}px`); }
  _setDensity(v) { document.documentElement.dataset.density = v === 'compact' ? 'compact' : 'comfortable'; }

  _initRailResize() {
    this._setRailWidth(this.store.getSettings().rail_width || 240);
    const r = document.getElementById('rail-resizer');
    if (!r) return;
    let dragging = false;
    const clamp = (x) => Math.max(170, Math.min(Math.round(window.innerWidth * 0.5), x));
    const onMove = (e) => { if (dragging) this._setRailWidth(clamp(e.clientX)); };
    const onUp = () => {
      if (!dragging) return;
      dragging = false; r.classList.remove('dragging'); document.body.style.userSelect = '';
      const w = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--rail-w'), 10);
      if (w) this.store.setSettings({ rail_width: w });
    };
    r.addEventListener('mousedown', (e) => { dragging = true; r.classList.add('dragging'); document.body.style.userSelect = 'none'; e.preventDefault(); });
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
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

  // Saved smart views in the rail. Built-in type views hide when empty; the
  // count shows unread (falling back to total), like the built-in views.
  renderViews() {
    const el = document.getElementById('smart-views'); if (!el) return;
    const ICONS = { video: '▶', article: '☰', paper: '✦', release: '⬡', track: '♪', search: '⌕' };
    const rows = [];
    for (const v of this.store.getViews()) {
      const items = this.store.query(v.query);
      if (v.builtin && items.length === 0) continue;     // empty type default → hide
      const unread = items.reduce((n, i) => n + (i.read ? 0 : 1), 0);
      const ico = ICONS[v.query.type] || (v.query.text ? ICONS.search : '◆');
      const active = this.smartView?.id === v.id ? ' active' : '';
      rows.push(`<div class="navrow view${active}" data-view-id="${escapeHtml(v.id)}" title="${escapeHtml(this.viewSummary(v))}">`
        + `<span class="lbl"><span class="ico">${ico}</span> ${escapeHtml(v.name)}</span><span class="count">${unread || items.length || ''}</span></div>`);
    }
    el.innerHTML = rows.join('');
  }

  viewSummary(v) {
    const q = v.query || {};
    const parts = [];
    if (q.type) parts.push(`type: ${q.type}`);
    if (q.text) parts.push(`search: “${q.text}”`);
    if (q.saved) parts.push('saved only');
    if (q.tag) parts.push(`#${q.tag}`);
    if (q.category != null) parts.push(`folder: ${q.category || 'ungrouped'}`);
    return parts.join(' · ') || 'all items';
  }

  smartViewMenu(id, x, y) {
    const v = this.store.getViews().find((x2) => x2.id === id); if (!v) return;
    showMenu(x, y, [
      { label: 'Rename…', onClick: () => this.renameView(id) },
      { label: 'Delete view', danger: true, onClick: () => this.deleteView(id) },
    ]);
  }

  async renameView(id) {
    const views = this.store.getViews();
    const v = views.find((x) => x.id === id); if (!v) return;
    const name = prompt('Rename view:', v.name);
    if (name === null || !name.trim()) return;
    v.name = name.trim();
    await this.store.saveViews(views);
    if (this.smartView?.id === id) this.smartView = v;
    this.renderViews(); this.renderTopbar();
  }

  async deleteView(id) {
    const views = this.store.getViews().filter((x) => x.id !== id);
    await this.store.saveViews(views);
    if (this.smartView?.id === id) { this.smartView = null; this.view = 'inbox'; this.renderAll(); }
    else this.renderViews();
  }

  async saveSearchAsView() {
    const text = this.searchText.trim();
    if (!text) return;
    const name = prompt('Name this view:', text.length > 24 ? text.slice(0, 24) + '…' : text);
    if (name === null || !name.trim()) return;
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'view';
    const id = `v-${slug}-${this.store.getViews().length}`;
    const views = [...this.store.getViews(), { id, name: name.trim(), query: { text } }];
    await this.store.saveViews(views);
    this.searchEl.value = ''; this.searchText = '';
    this.setSmartView(id);
  }

  renderDripStatus(st) {
    const el = document.getElementById('drip-status'); if (!el) return;
    if (!st || (!st.current && !st.queued)) { el.textContent = ''; return; }
    const cur = st.current ? `recovering ${st.current.idx}/${st.current.total}` : 'recovery queued';
    el.textContent = `⏪ ${cur}${st.queued ? ` · ${st.queued} waiting` : ''}`;
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

  // ── settings ──
  async openSettings() {
    const s = this.store.getSettings();
    const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    val('set-poll-interval', s.default_poll_interval_minutes);
    chk('set-adaptive', s.adaptive_polling);
    val('set-poll-concurrency', s.poll_concurrency);
    chk('set-pause-hidden', s.pause_polling_when_hidden);
    chk('set-images', s.images_default_allowed);
    chk('set-fullcontent', s.fetch_full_content_default);
    val('set-density', s.density || 'comfortable');
    chk('set-retention', s.retention_enabled);
    chk('set-autocheck', s.auto_check_updates);
    val('set-drip-interval', Math.round(s.recovery_drip_interval_ms / 60000));
    val('set-wb-interval', Math.round(s.wayback_min_interval_ms / 1000));
    val('set-wb-max', s.wayback_max_snapshots);
    val('set-ia-access', s.ia_access_key || '');
    val('set-ia-secret', s.ia_secret_key || '');
    document.getElementById('settings-msg').textContent = '';
    const aff = this.store.feedsWithAffinity();
    document.getElementById('affinity-status').textContent = aff ? `watch data on ${aff} feeds` : 'no watch data loaded';
    this._refreshStorageInfo();
    document.getElementById('settings-overlay').hidden = false;
  }

  async importWatchData(text) {
    let r;
    try { r = await this.store.applyAffinity(parseWatchDigest(text)); }
    catch (e) { document.getElementById('affinity-status').textContent = `bad digest: ${e.message}`; return; }
    document.getElementById('affinity-status').textContent = `applied to ${r.matched} feed${r.matched === 1 ? '' : 's'} ✓`;
    this.renderRail();
  }

  async _refreshStorageInfo() {
    try { const p = navigator.storage?.persisted ? await navigator.storage.persisted() : false; const el = document.getElementById('set-persist'); if (el) el.textContent = p ? 'persistent' : 'best-effort'; } catch { /* unsupported */ }
    try { const est = await this.store.estimate(); if (est) { const el = document.getElementById('set-usage'); if (el) el.textContent = `${fmtBytes(est.usage)} / ${fmtBytes(est.quota)}`; } } catch { /* unsupported */ }
  }

  closeSettings() { document.getElementById('settings-overlay').hidden = true; }

  async saveSettings() {
    const cur = this.store.getSettings();
    const num = (id, def) => { const v = parseFloat(document.getElementById(id).value); return Number.isFinite(v) ? v : def; };
    const chk = (id) => document.getElementById(id).checked;
    const patch = {
      default_poll_interval_minutes: Math.max(1, num('set-poll-interval', cur.default_poll_interval_minutes)),
      adaptive_polling: chk('set-adaptive'),
      poll_concurrency: Math.max(1, Math.min(32, num('set-poll-concurrency', cur.poll_concurrency))),
      pause_polling_when_hidden: chk('set-pause-hidden'),
      images_default_allowed: chk('set-images'),
      fetch_full_content_default: chk('set-fullcontent'),
      density: document.getElementById('set-density')?.value === 'compact' ? 'compact' : 'comfortable',
      retention_enabled: chk('set-retention'),
      auto_check_updates: chk('set-autocheck'),
      recovery_drip_interval_ms: Math.max(60000, num('set-drip-interval', 8) * 60000),
      wayback_min_interval_ms: Math.max(1000, num('set-wb-interval', 5) * 1000),
      wayback_max_snapshots: Math.max(1, Math.round(num('set-wb-max', 40))),
      ia_access_key: document.getElementById('set-ia-access').value.trim(),
      ia_secret_key: document.getElementById('set-ia-secret').value.trim(),
    };
    await this.store.setSettings(patch);
    this._setDensity(patch.density);
    setAutoCheck(patch.auto_check_updates);   // push the preference to the SW
    if (patch.retention_enabled) this.store.runRetention();   // apply immediately if just enabled
    document.getElementById('settings-msg').textContent = 'saved ✓';
    setTimeout(() => this.closeSettings(), 700);
  }

  async checkUpdates() {
    const el = document.getElementById('update-check-status');
    if (el) el.textContent = 'checking…';
    const at = await checkForUpdateNow();
    if (el) el.textContent = at == null ? 'no service worker (serve over https / install)' : 'checked — a reload prompt appears if there’s an update';
  }

  async requestPersist() {
    try {
      const ok = navigator.storage?.persist ? await navigator.storage.persist() : false;
      const label = ok ? 'persistent' : 'best-effort';
      const a = document.getElementById('set-persist'); if (a) a.textContent = label;
      const b = document.getElementById('persist-status'); if (b) b.textContent = label;
    } catch { /* unsupported */ }
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
