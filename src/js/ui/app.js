// UI controller (SPEC §4). Vanilla DOM: renders the rail + stream from the store,
// handles keyboard nav and inline expand-to-read, and drives the poller. Plain
// re-render on store events (fine at v0.1 scale); selection/expansion are app
// state, content is cached to avoid re-reading on every keystroke.

import { createRails } from '../../../vendor/rails.js';   // dev-time clarity; build inlines rails.js → global createRails
import { relativeTime, isoTitle, escapeHtml, fmtDuration, fmtCount, fmtBytes, dailyCounts, sparkPoints } from './format.js';
import { parseOpml, buildOpml } from '../opml.js';
import { detectImport, isWrappedUrl, isSkippedUrl } from '../importers.js';
import { hash32 } from '../store/schema.js';
import { DEFAULT_ROUTING, DEFAULT_STACKS_ROUTING } from '../router.js';
import { parseWatchDigest } from '../affinity.js';
import { showMenu } from './menu.js';
import { showPalette } from './palette.js';
import { renderMarkdown } from './markdown.js';
import { extractArticle } from '../extract.js';
import { checkForUpdateNow, setAutoCheck } from '../pwa.js';
import { recoverFeed } from '../wayback.js';
import { parseFeed } from '../adapters/feed.js';
import { monogram } from '../favicon.js';
import { assessFeed } from '../health.js';
import { Store } from '../store/store.js';
import { pickDirectory, folderHasStore, handlePermission, handleName, saveHandle, clearHandle } from '../fsmount.js';
import { facetsOf, FACETS } from '../glass.js';
import { WORLD_PATH, WORLD_VIEWBOX } from '../../../vendor/worldmap.js';
import { getKey, hasKey, saveKey } from '../llmkeys.js';
import { fetchUsageGauge, listModels } from '../llm.js';
import { catalogStoreItem } from '../cataloger.js';
import { hasBridge, bridgeVersion } from '../../../vendor/bridge-client.js';

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
    this.catalog = null;        // glass catalog mode: { filters: { facet: Set<term> } } or null
    this.facetFilter = '';      // facet-browser search box (filters terms within each facet group)
    this._facetDialog = null;   // facet whose full-term dialog is open (the long-tail browser), or null
    this._facetDialogFilter = '';
    this._facetDialogSort = 'count';   // dialog-only sort (seeded from the rail's, then independent)
    this._fdTerms = [];                // the dialog's current (filtered+sorted) term list, for the virtual scroller
    this.layout = 'list';       // stream layout: 'list' | 'gallery'
    this.collapsedCats = new Set();
    this.sourceFilter = '';          // rail source-filter query (narrows the Sources list by name/folder)
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
    this.stacks = null;          // StacksStore (set in boot); the notes/files vault
    this.stackFilter = null;     // stacks-mode flag (the Stacks tree view is active)
    this.stackPath = null;       // active stacks folder scope ('' / 'inbox' / 'papers/x'), or null = all
    this.collapsedStackFolders = new Set();
  }

  mount() {
    this._initWorkspace();                              // rails: creates the stream pane (#stream) before we cache it
    this.stream = document.getElementById('stream');
    this.sources = document.getElementById('sources');
    this.searchEl = document.getElementById('search-input');

    // Counts update live (cheap, no flicker); the rail+stream rebuild is debounced
    // so a burst of poll inserts doesn't tear the rows out from under the cursor.
    for (const ev of ['items', 'prune']) this.store.on(ev, () => { this.renderCounts(); this._scheduleRender(); });
    this.store.on('item', () => this.renderCounts());   // single state changes refresh their row in-place via doAct
    this.store.on('feed', () => this._scheduleRender());
    this.poller.on('polled', (e) => {
      this.renderPollStatus();
      if (e && e.error) { this._fetchFails = (this._fetchFails || 0) + 1; if (this._fetchFails >= 3) this.checkBridge(); }
      else if (e && e.result) { if (this._fetchFails) { this._fetchFails = 0; this._bridgeDismissed = false; this._setBridgeBanner(false); } }
    });
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
      this.catFilter = null; this.route = null; this.smartView = null; this.catalog = null; this.stackFilter = null; this.stackPath = null;
      this.feedFilter = this.feedFilter === s.dataset.feed ? null : s.dataset.feed;
      this.renderAll();
    });
    this.stream.addEventListener('click', (e) => this.onStreamClick(e));
    this.stream.addEventListener('auxclick', (e) => { if (e.button !== 1) return; const row = e.target.closest('.item'); if (!row) return; const it = this.store.getItem(row.dataset.id); if (it?.url) { e.preventDefault(); window.open(it.url, '_blank', 'noopener'); } });
    this.stream.addEventListener('contextmenu', (e) => { const row = e.target.closest('.item'); if (!row) return; e.preventDefault(); this.select(row.dataset.id); const it = this.store.getItem(row.dataset.id); if (it && it.feed_id === 'stacks') this.stacksEntryMenu(row.dataset.id, e.clientX, e.clientY); else this.itemMenu(row.dataset.id, e.clientX, e.clientY); });
    this.sources.addEventListener('contextmenu', (e) => {
      const s = e.target.closest('.source'); const h = e.target.closest('.cat-head');
      if (s) { e.preventDefault(); this.feedMenu(s.dataset.feed, e.clientX, e.clientY); }
      else if (h) { e.preventDefault(); this.catMenu(h.dataset.cat, e.clientX, e.clientY); }
      else { e.preventDefault(); this.railMenu(e.clientX, e.clientY); }
    });

    const form = document.getElementById('addfeed');
    form.addEventListener('submit', (e) => { e.preventDefault(); const v = form.querySelector('input').value.trim(); if (v) this.addFeed(v); });
    this.searchEl.addEventListener('input', () => { this.searchText = this.searchEl.value.trim(); this.renderStream(); this.renderTopbar(); });

    const fileEl = document.getElementById('opml-file');
    document.getElementById('btn-import')?.addEventListener('click', () => fileEl.click());
    fileEl?.addEventListener('change', async () => {
      const files = [...fileEl.files];
      fileEl.value = '';
      const opmlTexts = [];
      for (const f of files) {
        const text = await f.text();
        const d = detectImport(text);
        if (!d || d.format === 'opml') { opmlTexts.push(text); continue; }   // feeds → existing flow
        if (d.format === 'librarything') { await this.importBooks(d.books, d.format); continue; }   // books → holdings
        await this.importLinks(d.links, d.format);                            // saved links → new flow
      }
      if (opmlTexts.length) this.importOpmlFiles(opmlTexts);
    });
    document.getElementById('btn-export')?.addEventListener('click', () => this.exportOpml());

    // Sources header: collapse/expand-all buttons, a name/folder filter, and a
    // right-click menu on the header itself.
    document.getElementById('src-collapse-all')?.addEventListener('click', () => this.collapseAllCats());
    document.getElementById('src-expand-all')?.addEventListener('click', () => this.expandAllCats());
    const srcFilter = document.getElementById('source-filter');
    srcFilter?.addEventListener('input', () => { this.sourceFilter = srcFilter.value; this.renderRail(); });

    // Rail sections: chevron click → collapse; header right-click → move/collapse menu.
    // Both in the CAPTURE phase so they beat the section's own handlers (e.g. the
    // Stacks header's enterStacks, the Sources list's feed railMenu).
    const railEl = document.querySelector('.rail');
    railEl?.addEventListener('click', (e) => {
      const tog = e.target.closest('.sec-tog'); if (!tog) return;
      const sec = tog.closest('.rail-section[data-rail-section]'); if (!sec) return;
      e.stopPropagation(); this.toggleRailSection(sec.dataset.railSection);
    }, true);
    railEl?.addEventListener('contextmenu', (e) => {
      const label = e.target.closest('.rail-label'); if (!label) return;
      const sec = label.closest('.rail-section[data-rail-section]'); if (!sec) return;
      e.preventDefault(); e.stopPropagation(); this.railSectionMenu(sec.dataset.railSection, e.clientX, e.clientY);
    }, true);

    document.getElementById('routes')?.addEventListener('click', (e) => { const r = e.target.closest('[data-route]'); if (r) this.setRoute(r.dataset.route); });
    document.getElementById('facets')?.addEventListener('click', (e) => {
      const sortBtn = e.target.closest('.facet-sort');
      if (sortBtn) { this.cycleFacetSort(sortBtn.dataset.facet); return; }
      const tog = e.target.closest('.fh-tog');
      if (tog) { this.toggleFacetCollapse(tog.dataset.facet); return; }
      const more = e.target.closest('.facet-more');
      if (more && more.dataset.facet) { this.openFacetDialog(more.dataset.facet); return; }
      const t = e.target.closest('.facet-term');
      if (t) this.toggleFacet(t.dataset.facet, t.dataset.term);
    });
    {
      const fdb = document.getElementById('facet-dialog-body');
      fdb?.addEventListener('click', (e) => { const t = e.target.closest('.facet-term'); if (t) { this.toggleFacet(t.dataset.facet, t.dataset.term); this._renderFacetWindow(false); } });
      fdb?.addEventListener('contextmenu', (e) => { const t = e.target.closest('.facet-term'); if (t) { e.preventDefault(); this.facetTermMenu(t.dataset.facet, t.dataset.term, e.clientX, e.clientY); } });
      let fdRaf = 0;
      fdb?.addEventListener('scroll', () => { if (fdRaf) return; fdRaf = requestAnimationFrame(() => { fdRaf = 0; this._renderFacetWindow(false); }); });
      const fds = document.getElementById('facet-dialog-search'); fds?.addEventListener('input', () => { this._facetDialogFilter = fds.value; this.renderFacetDialog(true); });
      document.getElementById('facet-dialog-sort')?.addEventListener('click', () => this.cycleFacetDialogSort());
      document.getElementById('facet-dialog-close')?.addEventListener('click', () => this.closeFacetDialog());
    }
    { const fs = document.getElementById('facet-search'); fs?.addEventListener('input', () => { this.facetFilter = fs.value; this.renderCatalogFacets(); }); }
    document.getElementById('facets')?.addEventListener('change', (e) => { if (e.target.closest('.fr-from, .fr-to')) this.applyTemporalRange(); });
    document.getElementById('facets')?.addEventListener('contextmenu', (e) => {
      const term = e.target.closest('.facet-term');
      if (term) { e.preventDefault(); this.facetTermMenu(term.dataset.facet, term.dataset.term, e.clientX, e.clientY); return; }
      const head = e.target.closest('.facet-head');
      const fc = head && head.querySelector('.fh-tog')?.dataset.facet;
      if (fc) { e.preventDefault(); this.facetGroupMenu(fc, e.clientX, e.clientY); return; }
      e.preventDefault(); this.facetsHeaderMenu(e.clientX, e.clientY);   // empty space → panel-wide menu
    });
    document.getElementById('cat-run')?.addEventListener('click', () => this.catalogVisible());
    document.getElementById('cat-shelf')?.addEventListener('click', () => this.toggleShelfOrder());
    document.getElementById('facet-guided')?.addEventListener('click', () => this.toggleFacetGuided());
    document.getElementById('facet-clear')?.addEventListener('click', () => this.clearFacetFilters());
    document.getElementById('view-sub')?.addEventListener('click', (e) => { const chip = e.target.closest('.fchip'); if (!chip || !this.catalog) return; if (chip.dataset.range === '1') { this.clearFacet(chip.dataset.facet); return; } if (chip.dataset.ex === '1') this.toggleFacetExclude(chip.dataset.facet, chip.dataset.term); else this.toggleFacet(chip.dataset.facet, chip.dataset.term); });
    document.getElementById('facets-head')?.addEventListener('contextmenu', (e) => { if (e.target.closest('button')) return; e.preventDefault(); this.facetsHeaderMenu(e.clientX, e.clientY); });
    document.getElementById('set-cat-clear')?.addEventListener('click', () => this.clearCatalog());
    document.getElementById('set-webmcp-toggle')?.addEventListener('click', () => this.toggleWebmcp());
    const sv = document.getElementById('smart-views');
    sv?.addEventListener('click', (e) => { const r = e.target.closest('[data-view-id]'); if (r) this.setSmartView(r.dataset.viewId); });
    sv?.addEventListener('contextmenu', (e) => { const r = e.target.closest('[data-view-id]'); if (r) { e.preventDefault(); this.smartViewMenu(r.dataset.viewId, e.clientX, e.clientY); } });
    document.getElementById('btn-saveview')?.addEventListener('click', () => this.saveSearchAsView());
    this.store.on('views', () => this.renderViews());

    // Stacks rail tree + note editor
    document.getElementById('stacks-head')?.addEventListener('click', (e) => { if (e.target.closest('#stacks-newnote')) return; this.enterStacks(); });
    document.getElementById('stacks-newnote')?.addEventListener('click', (e) => { e.stopPropagation(); this.openNoteEditor(); });
    document.getElementById('stacks-tree')?.addEventListener('click', (e) => {
      if (e.target.closest('[data-stack-forget]')) { this._forgetStackGhosts(); return; }
      const f = e.target.closest('.stack-folder');
      if (f) { if (e.target.closest('.sf-tog')) this.toggleStackFolder(f.dataset.stackFolder); else this.setStackFolder(f.dataset.stackFolder); return; }
      const en = e.target.closest('.stack-entry'); if (en) this.selectStackEntry(en.dataset.stackId);
    });
    document.getElementById('stacks-tree')?.addEventListener('contextmenu', (e) => {
      const en = e.target.closest('.stack-entry'); if (!en) return;
      e.preventDefault(); e.stopPropagation(); this.stacksEntryMenu(en.dataset.stackId, e.clientX, e.clientY);
    });
    document.getElementById('se-save')?.addEventListener('click', () => this.saveNoteEditor());
    document.getElementById('se-close')?.addEventListener('click', () => this.closeNoteEditor());
    document.querySelectorAll('.se-mode').forEach((b) => b.addEventListener('click', () => this._seSetMode(b.dataset.semode)));
    // (the editor's change→preview sync is wired inside _seEnsureEditor — CM6's
    // updateListener, or the fallback textarea's input event)
    document.getElementById('btn-recover')?.addEventListener('click', () => { if (this.feedFilter) this.recoverHistory(this.feedFilter); });
    document.getElementById('open-rules')?.addEventListener('click', () => this.openRules());
    document.getElementById('open-settings')?.addEventListener('click', () => this.openSettings());
    document.getElementById('settings-save')?.addEventListener('click', () => this.saveSettings());
    document.getElementById('settings-close')?.addEventListener('click', () => this.closeSettings());
    document.getElementById('set-request-persist')?.addEventListener('click', () => this.requestPersist());
    document.getElementById('set-export-backup')?.addEventListener('click', () => this.exportBackup());
    document.getElementById('set-breakdown-btn')?.addEventListener('click', () => this.computeBreakdown());
    const backupFile = document.getElementById('backup-file');
    document.getElementById('set-restore-backup')?.addEventListener('click', () => backupFile?.click());
    backupFile?.addEventListener('change', async () => { const f = backupFile.files[0]; if (f) await this.restoreBackup(await f.text()); backupFile.value = ''; });
    document.getElementById('set-storage-actions')?.addEventListener('click', (e) => this.onMountAction(e));
    document.getElementById('mount-reconnect')?.addEventListener('click', () => this.reconnectFolder());
    document.getElementById('mount-dismiss')?.addEventListener('click', () => document.getElementById('mount-toast')?.classList.remove('on'));
    document.getElementById('bridge-recheck')?.addEventListener('click', () => this.checkBridge());
    document.getElementById('bridge-dismiss')?.addEventListener('click', () => { this._bridgeDismissed = true; this._setBridgeBanner(false); });
    document.getElementById('set-check-update')?.addEventListener('click', () => this.checkUpdates());
    document.getElementById('set-cat-gauge')?.addEventListener('click', () => this.checkCatGauge());
    document.getElementById('set-tg-verify')?.addEventListener('click', () => this._verifyTelegram());
    document.getElementById('set-cat-models')?.addEventListener('click', () => this.loadCatModels());
    document.getElementById('set-cat-model')?.addEventListener('change', () => this._reflectCatCustom());
    document.getElementById('set-cat-provider')?.addEventListener('change', () => { const k = document.getElementById('set-cat-key'); if (k) { k.value = ''; hasKey(document.getElementById('set-cat-provider').value).then((h) => { k.placeholder = h ? 'set ✓ (leave blank to keep)' : '(none)'; }); } this._renderCatModelSelect([], ''); });
    document.getElementById('open-help')?.addEventListener('click', () => this.openHelp());
    document.getElementById('help-close')?.addEventListener('click', () => this.closeHelp());
    document.getElementById('health-status')?.addEventListener('click', () => this.openHealth());
    document.getElementById('resolver-status')?.addEventListener('click', () => { this.catFilter = null; this.route = null; this.smartView = null; this.catalog = null; this.stackFilter = null; this.stackPath = null; this.feedFilter = 'saved'; this.renderAll(); });
    document.getElementById('review-status')?.addEventListener('click', () => this.openReview());
    document.getElementById('telegram-status')?.addEventListener('click', () => this.openSettings());
    document.getElementById('review-close')?.addEventListener('click', () => this._reviewClose());
    document.getElementById('review-body')?.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-rvact]');
      const row = e.target.closest('.rv-row'); if (!row) return;
      const id = row.dataset.id; if (!id) return;
      if (!btn) { const i = this._reviewRows().indexOf(row); if (i >= 0) this._reviewSelect(i); return; }   // click a row → select it
      const act = btn.dataset.rvact;
      if (act === 'ok') this.markReviewed(id);
      else if (act === 'recat') this.catalogItem(id).then(() => this.markReviewed(id));
      else if (act === 'edit') this.reviewEdit(id);
      else if (act === 'save') this.reviewSaveEdit(id);
      else if (act === 'cancel') this._reviewCancelEdit();
      else if (act === 'discard') this.discardCard(id);
      else if (act === 'open') { const it = this.store.getItem(id); if (it && it.url) window.open(it.url, '_blank', 'noopener'); }
    });
    document.getElementById('health-close')?.addEventListener('click', () => this.closeHealth());
    document.getElementById('tags-close')?.addEventListener('click', () => { document.getElementById('tags-overlay').hidden = true; });
    document.getElementById('tags-body')?.addEventListener('click', (e) => this._onTagManagerClick(e));
    document.getElementById('tags-list')?.addEventListener('click', (e) => { const r = e.target.closest('.tagrow'); if (r) this.filterByTag(r.dataset.tag); });
    document.getElementById('tags-manage')?.addEventListener('click', () => this.openTagManager());
    document.getElementById('tags-head')?.addEventListener('contextmenu', (e) => { e.preventDefault(); this.openTagManager(); });
    document.getElementById('health-retry')?.addEventListener('click', () => this.retryFlaggedFeeds());
    document.getElementById('health-body')?.addEventListener('click', (e) => this.onHealthClick(e));
    document.getElementById('reorder-list')?.addEventListener('click', (e) => this.onReorderClick(e));
    document.getElementById('reorder-save')?.addEventListener('click', () => this.saveReorder());
    document.getElementById('reorder-close')?.addEventListener('click', () => this.closeReorder());
    const affFile = document.getElementById('affinity-file');
    document.getElementById('set-import-affinity')?.addEventListener('click', () => affFile.click());
    affFile?.addEventListener('change', async () => { const f = affFile.files[0]; if (f) await this.importWatchData(await f.text()); affFile.value = ''; });
    document.getElementById('feededit-save')?.addEventListener('click', () => this.saveFeedEdit());
    document.getElementById('feededit-close')?.addEventListener('click', () => this.closeFeedEdit());
    document.getElementById('rules-save')?.addEventListener('click', () => this.saveRules());
    document.getElementById('rules-rerun')?.addEventListener('click', () => this.uiRerunRules());
    document.getElementById('rules-close')?.addEventListener('click', () => this.closeRules());
    document.querySelectorAll('[data-rulestab]').forEach((b) => b.addEventListener('click', () => this._loadRulesTab(b.dataset.rulestab)));
    this.store.on('notify', () => this.renderNotify());

    document.getElementById('set-density')?.addEventListener('change', (e) => this._setDensity(e.target.value));

    this._initRailResize();
    this._setDensity(this.store.getSettings().density);
    this.layout = this.store.getSettings().stream_layout === 'gallery' ? 'gallery' : 'list';
    { const b = document.getElementById('btn-layout'); if (b) { b.textContent = this.layout === 'gallery' ? '☰' : '▦'; b.title = this.layout === 'gallery' ? 'List view' : 'Gallery view'; } }
    document.getElementById('btn-layout')?.addEventListener('click', () => this.setLayout(this.layout === 'gallery' ? 'list' : 'gallery'));
    this.unreadOnly = !!this.store.getSettings().stream_unread_only;
    document.getElementById('btn-unread')?.addEventListener('click', () => this.toggleUnread());
    document.getElementById('btn-mark-read')?.addEventListener('click', () => this.markAllHere());
    document.getElementById('btn-tag-all')?.addEventListener('click', () => this.openBulkTagEditor());
    { const fd = document.getElementById('btn-flightdeck'); if (fd) { if ('documentPictureInPicture' in window) fd.addEventListener('click', () => this.openFlightDeck()); else fd.hidden = true; } }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && this._cataloging) this._acquireWakeLock(); });   // wake lock auto-releases when hidden; re-take on return
    document.addEventListener('keydown', (e) => this.onKey(e));
    setInterval(() => this.renderPollStatus(), 30_000);

    this.renderAll();
    this.applyRailLayout();   // restore the user's section order + collapsed-set
    if (this.store.getFeed('books')) this._ensureBooksView();   // back-fill the Books view for an existing books library
    this.renderNotify();
    this.renderPollStatus();
    this.checkBridge();
    if (this.fsMount && this.fsMount.pending) setTimeout(() => document.getElementById('mount-toast')?.classList.add('on'), 600);
  }

  query() {
    if (this.catalog) return this.catalogQuery();
    // Stacks mode: the entries of the synthetic 'stacks' feed, scoped to the active
    // folder, newest-first. (Entries are items, so search/tags work; we just filter
    // by path here rather than through store.query.)
    if (this.stackFilter) {
      let list = this.stacks ? this.stacks.entries() : this.store.query({ feed_id: 'stacks' });
      if (this.stackPath != null) {   // scope to a folder, recursively
        const pre = this.stackPath;
        list = list.filter((e) => { const f = this._stackFolderOf(e.path); return f === pre || f.startsWith(pre + '/'); });
      }
      const q = (this.searchText || '').toLowerCase();
      if (q) list = list.filter((e) => (e.search_text || '').includes(q));
      return list.sort((a, b) => (b.published_at || 0) - (a.published_at || 0));
    }
    // Current view's filter (no text) + the effective search text (live box, or a
    // saved smart-view's text).
    let opts, text;
    if (this.smartView) { const { text: t, ...rest } = this.smartView.query; opts = rest; text = this.searchText || t || ''; }
    else if (this.route) { opts = { route: this.route }; text = this.searchText || ''; }
    else if (this.catFilter != null) { opts = { category: this.catFilter }; text = this.searchText || ''; }   // '' = ungrouped
    else { opts = { view: this.view, feed_id: this.feedFilter || undefined }; text = this.searchText || ''; }
    if (this.unreadOnly) opts.read = false;   // unread-only toggle (topbar)

    // Ranked full-text (librarian) when we have text + a ready index — scoped to
    // the current view by filtering on its allowed id set; relevance order.
    if (text && this.searchIndex && this.searchIndex.ready) {
      const allowed = new Set(this.store.query(opts).map((r) => r.id));
      const hits = this.searchIndex.search(text, { limit: RENDER_CAP, filter: (id) => allowed.has(id) });
      return hits.map((h) => this.store.getItem(h.id)).filter(Boolean);
    }
    return this.store.query({ ...opts, text: text || undefined });   // cursor-scan fallback
  }

  renderAll() { this.renderCounts(); this.renderRail(); this.renderRoutes(); this.renderViews(); this.renderTags(); this.renderStacks(); this.renderTopbar(); this.renderStream(); this.renderReviewStatus(); }

  // The rail's Tags section — every tag in use, with its color + item count,
  // click to filter (a transient tag view). The discoverable home for tags; the
  // ⚙ opens the manager. Hidden when there are no tags.
  renderTags() {
    const el = document.getElementById('tags-list'); const sec = document.getElementById('tags-section');
    if (!el || !sec) return;
    const counts = this.store.tagCounts(); const reg = this.store.getTags();
    const names = Object.keys(counts).filter((t) => counts[t] > 0).sort((a, b) => (counts[b] - counts[a]) || a.localeCompare(b));
    sec.style.display = names.length ? '' : 'none';
    const activeTag = this.smartView?.transient && this.smartView.query?.tag;
    el.innerHTML = names.slice(0, 40).map((t) => {
      const raw = (reg[t] || {}).color; const col = /^#[0-9a-f]{3,8}$/i.test(raw || '') ? raw : null;
      return `<div class="navrow tagrow${activeTag === t ? ' active' : ''}" data-tag="${escapeHtml(t)}">`
        + `<span class="lbl"><span class="tagdot" style="background:${col || 'var(--au-fg-soft)'}"></span> ${escapeHtml(t)}</span>`
        + `<span class="count">${counts[t]}</span></div>`;
    }).join('') + (names.length > 40 ? `<div class="rail-empty">+ ${names.length - 40} more</div>` : '');
  }

  // Debounced rail+stream rebuild for store-driven changes (polling), so rows
  // aren't recreated under the cursor on every insert.
  _scheduleRender() {
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => { this._renderTimer = null; this.renderRail(); this.renderRoutes(); this.renderViews(); this.renderTags(); this.renderStacks(); this.renderStream(); }, 250);
  }

  // Replace a single row in place — instant feedback for a click action, no
  // full-stream rebuild (so no flicker).
  _refreshRow(id) {
    const row = this.rowEl(id); const it = this.store.getItem(id);
    if (!row || !it) return;
    const wrap = document.createElement('div'); wrap.innerHTML = this.itemHtml(it);
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
    document.getElementById('view-title').textContent = this.catalog ? 'Catalog' : this.stackFilter ? (this.stackPath ? `Stacks / ${this.stackPath}` : 'Stacks') : this.smartView ? this.smartView.name : this.catFilter != null ? (this.catFilter || 'ungrouped') : this.route ? `#${this.route}` : feed ? feed.name : (VIEW_LABELS[this.view] || this.view);
    const n = this.items.length;
    const feeds = this.store.listFeeds().length;
    const subEl = document.getElementById('view-sub');
    if (this.catalog) {
      this._renderCatalogSub(n);
    } else {
      let sub;
      if (this.stackFilter && !this.searchText) sub = n ? `${n} entr${n === 1 ? 'y' : 'ies'}` : 'empty — ＋ note to start';
      else if (this.searchText) sub = `${n} match${n === 1 ? '' : 'es'} for “${this.searchText}”`;
      else if (!feeds) sub = 'no feeds yet';
      else sub = `${n} item${n === 1 ? '' : 's'}${feed ? '' : ` · ${feeds} source${feeds === 1 ? '' : 's'}`}`;
      subEl.classList.remove('chips');
      subEl.textContent = sub;
    }
    const ub = document.getElementById('btn-unread');
    if (ub) {
      const unread = this.items.reduce((a, i) => a + (i.read ? 0 : 1), 0);
      ub.classList.toggle('active', this.unreadOnly);
      ub.textContent = `● ${unread} unread`;
      ub.title = this.unreadOnly ? 'Showing only unread — click to show all (u)' : 'Show only unread (u)';
    }
    this._reflectSearch();
  }

  // Catalog subtitle = the active drill-down as removable chips (include + the
  // struck-through excludes). Click a chip to drop that one constraint.
  _renderCatalogSub(n) {
    const el = document.getElementById('view-sub'); if (!el) return;
    const chips = [];
    for (const [fc, s] of Object.entries(this.catalog.filters)) {
      // Collapse a multi-year temporal selection into one range chip (2018–2022).
      if (fc === 'temporal') {
        const ys = [...s].filter((t) => /^\d{3,4}$/.test(t)).map(Number).sort((a, b) => a - b);
        if (ys.length >= 3) {
          chips.push(['temporal', `${ys[0]}–${ys[ys.length - 1]}`, false, true]);
          for (const t of s) if (!/^\d{3,4}$/.test(t)) chips.push(['temporal', t, false, false]);
          continue;
        }
      }
      for (const t of s) chips.push([fc, t, false, false]);
    }
    for (const [fc, s] of Object.entries(this.catalog.excludes || {})) for (const t of s) chips.push([fc, t, true, false]);
    const head = `${n} item${n === 1 ? '' : 's'}`;
    if (!chips.length) { el.classList.remove('chips'); el.textContent = `${head} · pick a facet →`; return; }
    el.classList.add('chips');
    el.innerHTML = `<span class="vs-count">${head}</span>` + chips.map(([fc, t, ex, range]) =>
      `<span class="fchip${ex ? ' ex' : ''}" data-facet="${escapeHtml(fc)}" data-term="${escapeHtml(t)}" data-ex="${ex ? 1 : 0}" data-range="${range ? 1 : 0}" title="${range ? 'Year range' : ex ? 'Excluded' : 'Filtering'} ${escapeHtml(fc)} — click to remove">${ex ? '−' : ''}${escapeHtml(fc)}:${escapeHtml(t)}<span class="x">✕</span></span>`).join('');
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
    let feeds = this.store.listFeeds().filter((f) => f.id !== 'stacks');   // the stacks have their own tree section, not a Sources row
    this.faviconFetcher?.enqueue(feeds);   // lazily backfill site icons (polite, once each)
    this.recomputeHealth();
    this.renderHealthStatus();
    document.querySelectorAll('.navrow[data-view]').forEach((r) =>
      r.classList.toggle('active', r.dataset.view === 'catalog'
        ? !!this.catalog
        : r.dataset.view === 'stacks'
          ? !!this.stackFilter
          : (!this.feedFilter && !this.route && !this.smartView && !this.catalog && !this.stackFilter && this.catFilter == null && r.dataset.view === this.view)));
    { const cs = document.getElementById('count-stacks'); if (cs) { const n = this.stacks ? this.stacks.entries().filter((e) => !e.missing).length : 0; cs.textContent = n || ''; } }

    // Catalog mode swaps the Sources rail for the facet browser.
    const srcSec = document.getElementById('sources')?.closest('.rail-section');
    const facSec = document.getElementById('facets-section');
    if (this.catalog) {
      if (srcSec) srcSec.style.display = 'none';
      if (facSec) facSec.style.display = '';
      this.renderCatalogFacets();
      return;
    }
    if (srcSec) srcSec.style.display = '';
    if (facSec) facSec.style.display = 'none';

    // Source filter narrows the list by feed name or folder; while filtering,
    // matching folders force-expand so hits are always visible.
    const srcQ = (this.sourceFilter || '').trim().toLowerCase();
    if (srcQ) feeds = feeds.filter((f) => (f.name || '').toLowerCase().includes(srcQ) || (f.category || '').toLowerCase().includes(srcQ));
    if (!feeds.length) { this.sources.innerHTML = `<div class="rail-empty">${srcQ ? 'no sources match' : 'No sources yet'}</div>`; return; }

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
      // Manual order pins feeds first (by order index); the rest fall back to
      // watch-affinity then name.
      const ord = (f) => (f.order == null ? Infinity : f.order);
      const list = groups.get(c).sort((x, y) => ord(x) - ord(y) || (y.affinity || 0) - (x.affinity || 0) || x.name.localeCompare(y.name));
      const collapsed = !srcQ && this.collapsedCats.has(c);
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

  setCategory(cat) { this.catFilter = cat == null ? null : cat; this.view = null; this.feedFilter = null; this.route = null; this.smartView = null; this.catalog = null; this.stackFilter = null; this.stackPath = null; this.selectedId = null; this.expandedId = null; this.renderAll(); }
  toggleCat(c) { if (this.collapsedCats.has(c)) this.collapsedCats.delete(c); else this.collapsedCats.add(c); this.renderRail(); }

  setSmartView(id) {
    const v = this.store.getViews().find((x) => x.id === id);
    if (!v) return;
    if (v.query && v.query.catalog) return this.applyFacetView(v);   // a saved facet drill-down
    this.smartView = v;
    this.view = null; this.feedFilter = null; this.route = null; this.catFilter = null; this.catalog = null; this.stackFilter = null; this.stackPath = null;
    this.selectedId = null; this.expandedId = null;
    this.renderAll();
  }

  // Does the live catalog selection equal this saved facet view? Derived (not
  // tracked) so the rail highlight follows the selection automatically — change a
  // term and it stops matching.
  _sameFacetView(v) {
    if (!this.catalog || !v.query || !v.query.catalog) return false;
    const norm = (filters, excludes) => JSON.stringify({
      f: Object.fromEntries(Object.entries(filters || {}).filter(([, a]) => a && (a.size || a.length)).map(([k, a]) => [k, [...a].sort()]).sort()),
      e: Object.fromEntries(Object.entries(excludes || {}).filter(([, a]) => a && (a.size || a.length)).map(([k, a]) => [k, [...a].sort()]).sort()),
    });
    return norm(this.catalog.filters, this.catalog.excludes) === norm(v.query.catalog.filters, v.query.catalog.excludes);
  }

  // Apply a saved facet view: re-enter catalog mode with its filters/excludes.
  applyFacetView(v) {
    this.setCatalog();
    const c = (v.query && v.query.catalog) || {};
    this.catalog.filters = {}; this.catalog.excludes = {};
    for (const [f, arr] of Object.entries(c.filters || {})) this.catalog.filters[f] = new Set(arr);
    for (const [f, arr] of Object.entries(c.excludes || {})) this.catalog.excludes[f] = new Set(arr);
    this.renderAll();
  }

  // Save the current facet drill-down (includes + excludes) as a reusable smart
  // view. Stored as { query: { catalog: { filters, excludes } } } — Sets → arrays.
  async saveFacetView() {
    if (!this.catalog || !this._activeFacets().length) return;
    const ser = (m) => { const o = {}; for (const [f, s] of Object.entries(m || {})) if (s && s.size) o[f] = [...s]; return o; };
    const terms = []; for (const s of Object.values(this.catalog.filters)) for (const t of s) terms.push(t);
    const name = prompt('Save this drill-down as a view named:', terms.slice(0, 3).join(' · ') || 'facet view');
    if (name === null || !name.trim()) return;
    const query = { catalog: { filters: ser(this.catalog.filters), excludes: ser(this.catalog.excludes) } };
    const views = this.store.getViews();
    const base = 'fv-' + (name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'view');
    let id = base, i = 2; while (views.some((v) => v.id === id)) id = `${base}-${i++}`;
    views.push({ id, name: name.trim(), query });
    await this.store.saveViews(views);
    this.renderViews();
  }

  // ── glass catalog: faceted browse (GLASS.md §8 facet intersection) ──
  setCatalog() {
    this.catalog = this.catalog || { filters: {}, excludes: {} };
    if (!this.catalog.excludes) this.catalog.excludes = {};
    this.view = null; this.feedFilter = null; this.route = null; this.catFilter = null; this.smartView = null;
    this.selectedId = null; this.expandedId = null;
    this.renderAll();
    // Enrich the browser with cataloged cards' LLM facets once they load.
    this.loadCardFacets().then(() => { if (this.catalog) this.renderAll(); });
  }

  // Cache item_id → enriched card facets for cataloged items, so the facet
  // browser shows the LLM-assigned facets (not just the Stage-0 deterministic
  // ones). Un-cataloged items fall back to facetsOf() live.
  async loadCardFacets() {
    const map = new Map();
    const review = new Map();
    for (const item of this.store.items.values()) {
      if (!item.glass_id) continue;
      try {
        const c = await this.store.getCard(item.glass_id);
        if (c) { if (c.facets) map.set(item.id, c.facets); review.set(item.id, { needs_review: !!(c.glass && c.glass.needs_review), confidence: c.glass && c.glass.confidence }); }
      } catch { /* skip */ }
    }
    this._cardFacets = map;
    this._cardReview = review;
    this.renderReviewStatus();
  }

  // ── glass cataloger (Stage 1): per-item + gentle batch ──
  _catStatus(text) { const el = document.getElementById('catalog-status'); if (el) el.textContent = text || ''; }

  async _catalogOpts() {
    const s = this.store.getSettings();
    const provider = s.catalog_provider || 'ollama';
    return { provider, model: s.catalog_model, baseUrl: s.catalog_base_url, key: await getKey(provider), fetch: this.poller.fetch, mailto: s.catalog_mailto || '', maxBodyChars: s.catalog_max_body_chars || 6000 };
  }

  async catalogItem(id) {
    const it = this.store.getItem(id); if (!it) return null;
    this._catStatus(`cataloging “${(it.title || '').slice(0, 40)}”…`);
    try {
      const r = await catalogStoreItem(this.store, id, await this._catalogOpts());
      if (this._cardFacets) this._cardFacets.set(id, r.card.facets);
      const dom = (r.card.facets.domain || []).join(', ');
      // During a batch the caller throttles the (O(N)) re-render; don't redo it
      // per item or the whole-corpus run gets quadratic + janky.
      if (!this._batch) { this._catStatus(`cataloged${dom ? ' · ' + dom : ''}${r.ok ? '' : ' (needs review)'}`); if (this.catalog) this.renderAll(); this.renderCatUsage(); }
      return r;
    } catch (e) { this._catStatus(`catalog failed: ${e.message}`); this._fetchFails = (this._fetchFails || 0) + 1; this.checkBridge(); return null; }
  }

  // Catalog the currently-shown items that aren't cataloged yet — one at a time,
  // paced (gentle on the NPU + the machine), cancelable, resumable (skips already-
  // cataloged), and self-stopping if the LLM/bridge goes down mid-run.
  // A saved link isn't worth cataloging until the resolver has fetched it (resolved
  // the share.google wrapper + pulled a real title/excerpt) — otherwise it catalogs
  // a "share.google" placeholder into facets that then STICK (a glass_id is set, so
  // it won't auto-recatalog when it later resolves). Defer un-enriched saved links;
  // a later batch run sweeps them up as the drip marks them enriched. (The per-item
  // "Catalog with AI" is unaffected — an explicit choice.)
  _catReady(i) { return !(i.feed_id === 'saved' && !i.enriched); }

  async catalogVisible() {
    if (this._cataloging) { this._cataloging.cancel = true; return; }
    const cand = this.items.filter((i) => !i.glass_id);
    const todo = cand.filter((i) => this._catReady(i));
    const deferred = cand.length - todo.length;
    if (!todo.length) { this._catStatus(deferred ? `${deferred} saved link${deferred === 1 ? '' : 's'} still resolving — catalog after they finish` : 'nothing to catalog here'); return; }
    // "Let it rip" can be the whole corpus (catalog mode, no filter) — one LLM
    // call per item. Confirm before a long unattended run.
    if (todo.length > 30 && !confirm(`Catalog ${todo.length} items?${deferred ? ` (${deferred} unresolved saved links deferred)` : ''} That's one LLM call each — it can run for a while. It resumes where it left off if interrupted, and you can click the button again to stop.`)) return;
    return this._runCatalog(todo);
  }

  // Catalog ALL un-cataloged, non-archived items in the corpus (no scope, no
  // confirm) — used by the WebMCP catalog-start tool. Fire-and-forget; paced.
  catalogAll() { return this.catalogScope({}); }

  // Scoped sibling of catalogAll: catalog the un-cataloged, non-archived items in a
  // feed / folder / type. Same defer rule (_catReady), pacing, and resume. Backs the
  // WebMCP catalog-start `scope` and the "Catalog this feed/folder" affordances, so
  // a run can target one source instead of the whole corpus. {} = everything.
  catalogScope({ feed_id, category, type } = {}) {
    if (this._cataloging) return { running: true, already: true };
    const inCat = category != null ? new Set(this.store.listFeeds().filter((f) => (f.category || '') === category).map((f) => f.id)) : null;
    const cand = [...this.store.items.values()].filter((i) =>
      !i.glass_id && !i.archived
      && (feed_id == null || i.feed_id === feed_id)
      && (inCat == null || inCat.has(i.feed_id))
      && (type == null || i.type === type));
    const todo = cand.filter((i) => this._catReady(i));
    const deferred = cand.length - todo.length;
    if (!todo.length) { this._catStatus(deferred ? `${deferred} saved link${deferred === 1 ? '' : 's'} still resolving — catalog after they finish` : 'nothing to catalog here'); return { running: false, todo: 0, deferred }; }
    this._runCatalog(todo);   // not awaited — runs in the background, paced
    return { running: true, todo: todo.length, deferred };
  }

  // Scoped RE-catalog: discard the scope's cards (so they re-queue), then catalog
  // it. For correcting a batch cataloged under an old rule (e.g. the books that got
  // form:article before the book-form fix). The biblio enricher re-runs, so cards
  // get fresh facets + descriptions. (Item excerpts are separate — a re-import
  // clears those.)
  async recatalogScope(scope = {}) {
    if (this._cataloging) { this._catStatus('a catalog run is already going — stop it first'); return { running: true, already: true }; }
    const cleared = await this.store.uncatalogScope(scope);
    if (this._cardFacets) for (const id of [...this._cardFacets.keys()]) if (!this.store.getItem(id)?.glass_id) this._cardFacets.delete(id);
    await this.store.flush();
    const r = this.catalogScope(scope);
    this._catStatus(`re-cataloging ${r.todo || 0} item${(r.todo || 0) === 1 ? '' : 's'} (discarded ${cleared} card${cleared === 1 ? '' : 's'})…`);
    if (this.catalog) this.renderAll();
    return { cleared, ...r };
  }

  stopCatalog() { if (this._cataloging) { this._cataloging.cancel = true; return true; } return false; }
  catalogStatus() { return { running: !!this._cataloging, progress: this._catalogProgress || null }; }

  // The paced batch loop, shared by catalogVisible / catalogAll. Cancelable,
  // resumable (only un-cataloged items are queued), self-stopping on a failure run.
  // Catalog priority tier (lower = sooner). Value-first: an interrupted run should
  // leave the LIBRARY core cataloged first. saved/tagged (explicit interest) →
  // books/papers (durable holdings) → articles/releases → videos & the ephemeral rest.
  _catalogPriority(it) {
    if (it.saved || (it.tags && it.tags.length)) return 0;
    if (it.type === 'book' || it.type === 'paper') return 1;
    if (it.type === 'article' || it.type === 'release') return 2;
    return 3;
  }

  async _runCatalog(todo) {
    // Order value-first (tier, then newest within tier), so a partial run is still a
    // useful catalog — the books/papers/saved shelf fills before the video bulk.
    todo = todo.slice().sort((a, b) => this._catalogPriority(a) - this._catalogPriority(b) || (b.published_at || 0) - (a.published_at || 0));
    const pace = Math.max(0, Number(this.store.getSettings().catalog_pace_ms) ?? 400);   // 0 = as fast as the LLM answers (cloud)
    const job = this._cataloging = { cancel: false };
    this._batch = true;
    this._catalogProgress = { total: todo.length, done: 0, failed: 0 };
    this._renderCatRun();
    if (this._pipWin) this._renderFlightDeck();   // flip the deck to "cataloging…" immediately, not after item #1
    this._acquireWakeLock();                 // keep the display awake for the run
    let n = 0, ok = 0, fails = 0, streak = 0, bailed = false, i = 0;
    try {
      while (i < todo.length) {
        if (job.cancel) break;
        const it = todo[i];
        this._catStatus(`cataloging ${ok + 1}/${todo.length}…  ${ok} done${fails ? `, ${fails} failed` : ''} · click to stop`);
        const r = await this.catalogItem(it.id);
        if (r) { ok++; streak = 0; i++; }
        else if (!navigator.onLine) {
          // Offline — the machine likely slept (lid close / power pull) or the
          // network dropped. Park the run and wait for it to come back, then retry
          // the SAME item. Not the LLM's fault, so it doesn't count toward the bail.
          if (!await this._pauseAndAwaitResume(job, ok, todo.length)) { bailed = true; break; }
          streak = 0;   // i not advanced → re-attempt this item
        } else {
          fails++; streak++; i++;
          if (streak >= 8) {
            // 8 ONLINE failures in a row → the provider/bridge is erroring. Pause +
            // backoff-retry instead of dying, so a blip doesn't end an overnight run.
            if (!await this._pauseAndAwaitResume(job, ok, todo.length)) { bailed = true; break; }
            streak = 0;
          }
        }
        n = ok + fails;
        this._catalogProgress = { total: todo.length, done: ok, failed: fails };
        if (this._pipWin) this._renderFlightDeck();                  // live progress on the pop-out
        if (n % 25 === 0 && this.catalog) this.renderAll();          // throttled refresh
        // Pace via the flight-deck window's timer when it's open: its timers stay
        // un-throttled (always-visible), so a buried main tab no longer crawls.
        if (pace && r && !job.cancel) await new Promise((res) => (this._pipWin || window).setTimeout(res, pace));
      }
    } finally {
      this._batch = false;
      this._cataloging = null;
      this._catalogProgress = { total: todo.length, done: ok, failed: fails, finished: true };   // before the render so the deck shows "done N/N", not idle
      this._releaseWakeLock();
      this._renderCatRun();
      if (this._pipWin) this._renderFlightDeck();
      if (this.catalog) this.renderAll();
      this.renderCatUsage();
    }
    if (!bailed) this._catStatus(`cataloged ${ok}/${todo.length}${fails ? `, ${fails} failed` : ''}${job.cancel ? ' (stopped)' : ''}`);
  }

  // Catalog ▸ ⇄ ⏸ — the rail button reflects whether a batch is running.
  _renderCatRun() {
    const btn = document.getElementById('cat-run'); if (!btn) return;
    const running = !!this._cataloging;
    btn.textContent = running ? 'catalog ⏸' : 'catalog ▸';
    btn.classList.toggle('running', running);
    btn.title = running ? 'Cataloging… click to stop' : 'Catalog the shown items with AI (click again to stop)';
  }

  // ── unattended-run survival: Screen Wake Lock (keep the display awake during a
  // batch so the machine doesn't sleep/throttle mid-run; no mouse-jiggler needed).
  async _acquireWakeLock() {
    try {
      if (navigator.wakeLock && !this._wakeLock && document.visibilityState === 'visible') {
        this._wakeLock = await navigator.wakeLock.request('screen');
        this._wakeLock.addEventListener('release', () => { this._wakeLock = null; });
      }
    } catch { /* unsupported / denied / not visible — best effort */ }
  }
  _releaseWakeLock() { if (this._wakeLock) { try { this._wakeLock.release(); } catch { /* ignore */ } this._wakeLock = null; } }

  // Pause-and-auto-resume — instead of dying on a failure run (usually the machine
  // sleeping on a lid-close, or a transient provider blip), park the batch and
  // resume when conditions recover: an `online`/visible wake signal (both fire when
  // a slept machine wakes), or a growing backoff for provider errors. Reports the
  // cause in catalogStatus ({paused, reason}). Cancelable — the stop button still
  // works while paused. Returns false only if the user stopped it mid-pause.
  async _pauseAndAwaitResume(job, done, total) {
    let backoff = 15_000;
    while (!job.cancel) {
      const offline = !navigator.onLine;
      this._catalogProgress = { total, done, failed: this._catalogProgress?.failed || 0, paused: true, reason: offline ? 'offline' : 'provider' };
      this._catStatus(offline
        ? `paused — offline (machine asleep?). ${done}/${total} cataloged · resumes automatically when you’re back online · click to stop`
        : `paused — provider not responding. ${done}/${total} cataloged · retrying in ${Math.round(backoff / 1000)}s · click to stop`);
      if (this._pipWin) this._renderFlightDeck();
      await this._awaitWakeSignal(job, backoff);
      if (job.cancel) return false;
      if (navigator.onLine) { await this._acquireWakeLock(); return true; }   // back online → resume
      backoff = Math.min(backoff * 2, 120_000);
    }
    return false;
  }

  // Resolve on the FIRST of: an `online` event, the tab becoming visible, `ms`
  // elapsed (backoff), or the job being canceled. Both online + visible fire when a
  // slept machine wakes, so resume is near-immediate on lid-open.
  _awaitWakeSignal(job, ms) {
    return new Promise((resolve) => {
      let settled = false;
      const fin = () => { if (settled) return; settled = true; cleanup(); resolve(); };
      const onVis = () => { if (document.visibilityState === 'visible') fin(); };
      const poll = setInterval(() => { if (job.cancel) fin(); }, 1000);
      const timer = setTimeout(fin, ms);
      function cleanup() { clearTimeout(timer); clearInterval(poll); window.removeEventListener('online', fin); document.removeEventListener('visibilitychange', onVis); }
      window.addEventListener('online', fin);
      document.addEventListener('visibilitychange', onVis);
    });
  }

  // ── flight-deck: a Document Picture-in-Picture pop-out (always-on-top) showing
  // catalog progress + the latest items. Its timers aren't background-throttled,
  // so while it's open the batch's pacing runs through it (see _runCatalog) and a
  // buried main tab no longer crawls. Chromium-only; needs a user gesture to open.
  async openFlightDeck() {
    if (!('documentPictureInPicture' in window)) { this._catStatus('Picture-in-Picture isn’t supported in this browser'); return; }
    if (this._pipWin) { try { this._pipWin.focus(); } catch { /* ignore */ } return; }
    let pip;
    try { pip = await window.documentPictureInPicture.requestWindow({ width: 400, height: 560 }); }
    catch (e) { this._catStatus(`couldn’t open flight-deck: ${e.message}`); return; }
    this._pipWin = pip;
    for (const ss of document.querySelectorAll('style')) { const s = pip.document.createElement('style'); s.textContent = ss.textContent; pip.document.head.appendChild(s); }
    pip.document.documentElement.dataset.density = document.documentElement.dataset.density || 'comfortable';
    pip.document.body.innerHTML = '<div id="flightdeck"></div>';
    // Keep polling alive through the deck's (un-throttled, always-visible) timer
    // while it's open — so a backgrounded tab keeps ingesting, not just cataloging.
    if (this.store.getSettings().poll_in_flightdeck !== false) {
      this.poller.setKeepAlive(pip);
      // Refresh the deck after each background poll cycle, so new items show even
      // when only polling (no catalog running) — un-throttled (it's a microtask
      // off the PiP-timer tick), unlike the main hidden-tab render.
      this._deckPollOff = this.poller.on('cycle', () => { if (this._pipWin) this._renderFlightDeck(); });
    }
    // Keep the saved-link resolver dripping through the deck's (un-throttled,
    // always-visible) timer too, so a backgrounded tab keeps resolving/enriching.
    this.runner?.setDriver(pip);   // one switch drives the resolver, telegram, + any future loop
    pip.addEventListener('pagehide', () => { this._pipWin = null; this.poller.setKeepAlive(null); this.runner?.setDriver(null); if (this._deckPollOff) { this._deckPollOff(); this._deckPollOff = null; } });
    pip.document.getElementById('flightdeck').addEventListener('click', (e) => {
      if (e.target.closest('[data-fd-pin]')) { this._pinDeck(); return; }
      if (e.target.closest('[data-fd-reset]')) { this.store.setSettings({ flightdeck_scope: null }); this._fdSig = null; this._renderFlightDeck(); return; }
      const el = e.target.closest('[data-fd-open]'); if (el && el.dataset.fdOpen) { try { window.open(el.dataset.fdOpen, '_blank', 'noopener'); } catch { /* ignore */ } }
    });
    this._fdSig = null;
    this._renderFlightDeck();
  }

  // Query-opts snapshot for the current main view (what "pin to deck" captures).
  _currentScope() {
    if (this.smartView) return { ...this.smartView.query };
    if (this.route) return { route: this.route };
    if (this.catFilter != null) return { category: this.catFilter };
    if (this.feedFilter) return { feed_id: this.feedFilter };
    if (this.view && this.view !== 'inbox') return { view: this.view };
    return null;   // inbox / default / catalog → everything
  }
  _scopeLabel(scope) {
    if (!scope) return 'all';
    if (scope.category != null) return scope.category || 'ungrouped';
    if (scope.feed_id) return this.store.getFeed(scope.feed_id)?.name || scope.feed_id;
    if (scope.route) return `→ ${scope.route}`;
    if (scope.saved) return 'saved';
    if (scope.view) return scope.view;
    if (scope.type) return scope.type;
    return 'filtered';
  }
  _pinDeck() {
    this.store.setSettings({ flightdeck_scope: this._currentScope() });
    this._fdSig = null;
    this._renderFlightDeck();
  }

  _renderFlightDeck() {
    const pip = this._pipWin; if (!pip || !pip.document) return;
    const root = pip.document.getElementById('flightdeck'); if (!root) return;
    if (!root.querySelector('.fd-list')) root.innerHTML = '<div class="fd-head"></div><div class="fd-list"></div>';
    const headEl = root.querySelector('.fd-head'); const listEl = root.querySelector('.fd-list');
    const scope = this.store.getSettings().flightdeck_scope || null;
    const p = this._catalogProgress;
    const prog = this._cataloging
      ? `<span class="fd-prog running">${p ? p.done : 0}/${p ? p.total : '?'}${p && p.failed ? ` · ${p.failed}✗` : ''}</span>`
      : (p && p.finished ? `<span class="fd-prog">done ${p.done}/${p.total}</span>` : '<span class="fd-prog idle"></span>');
    headEl.innerHTML = `<b>weir</b> <span class="fd-scope" title="flight-deck scope">${escapeHtml(this._scopeLabel(scope))}</span>`
      + `<button class="fd-btn" data-fd-pin title="Pin the deck to the current view">pin</button>`
      + (scope ? `<button class="fd-btn" data-fd-reset title="Show all items">all</button>` : '')
      + `<span class="fd-spacer"></span>${prog}`;
    const recent = this.store.query({ ...(scope || {}), limit: 16 });
    const sig = recent.map((it) => it.id + (it.read ? '1' : '0')).join('|');
    if (sig === this._fdSig) return;   // list unchanged — skip rebuild (preserves scroll)
    this._fdSig = sig;
    const top = listEl.scrollTop;
    listEl.innerHTML = recent.map((it) => {
      const feed = this.store.getFeed(it.feed_id);
      const thumb = it.media && it.media.thumbnail
        ? `<img class="fd-thumb" loading="lazy" src="${escapeHtml(it.media.thumbnail)}" alt="">`
        : `<span class="fd-thumb ph">${escapeHtml(((it.type || '?')[0] || '?').toUpperCase())}</span>`;
      return `<div class="fd-item${it.read ? ' read' : ''}" data-fd-open="${escapeHtml(it.url || '')}">${thumb}`
        + `<div class="fd-body"><div class="fd-title">${escapeHtml(it.title || '(untitled)')}</div>`
        + `<div class="fd-meta">${escapeHtml(feed ? feed.name : it.feed_id)} · ${relativeTime(it.published_at)}</div></div></div>`;
    }).join('') || '<div class="hint" style="padding:12px">No items in this scope yet.</div>';
    listEl.scrollTop = top;
  }

  // Wipe every catalog card and un-stamp items, then refresh the view. Cleanup
  // for a corrupted catalog (e.g. the old seq-001 collision) before a fresh pass.
  async clearCatalog() {
    if (this._cataloging) { this._catStatus('stop the running catalog first'); return; }
    const n = await this.store.catalogCount();
    if (!confirm(`Clear the catalog? This deletes ${n} card${n === 1 ? '' : 's'} and un-files every item. Items, content and reading state are untouched. You can re-catalog after.`)) return;
    const r = await this.store.clearCatalog();
    this._cardFacets = new Map();
    if (this.catalog) this.renderAll();
    this.renderCatUsage();
    this._catStatus(`catalog cleared (${r.cleared} card${r.cleared === 1 ? '' : 's'})`);
  }

  // In-memory inverted index over the live (Stage-0, deterministic) facets:
  // facet → term → Set<item id>. Recomputed per render (cheap; same scale as the
  // rail). Stage 1 will source enriched facets from the persisted card index.
  buildCatalogIndex() {
    const idx = {}; for (const f of FACETS) idx[f] = new Map();
    for (const item of this.store.items.values()) {
      if (item.archived) continue;
      const f = (this._cardFacets && this._cardFacets.get(item.id)) || facetsOf(item, this.store.getFeed(item.feed_id));
      for (const facet of FACETS) for (const term of (f[facet] || [])) {
        let s = idx[facet].get(term); if (!s) idx[facet].set(term, s = new Set());
        s.add(item.id);
      }
    }
    this._catalogIndex = idx;
  }

  catalogQuery() {
    const idx = this._catalogIndex || (this.buildCatalogIndex(), this._catalogIndex);
    const unions = [];   // one Set per active facet (OR within facet, AND across)
    for (const [facet, terms] of Object.entries(this.catalog.filters)) {
      if (!terms.size) continue;
      const u = new Set();
      for (const t of terms) for (const id of (idx[facet].get(t) || [])) u.add(id);
      unions.push(u);
    }
    let ids;
    if (!unions.length) ids = new Set([...this.store.items.values()].filter((i) => !i.archived).map((i) => i.id));
    else { ids = unions[0]; for (let k = 1; k < unions.length; k++) ids = new Set([...ids].filter((id) => unions[k].has(id))); }
    // Exclusions (NOT): drop any item carrying an excluded term.
    for (const [facet, terms] of Object.entries(this.catalog.excludes || {})) {
      for (const t of terms) for (const id of (idx[facet].get(t) || [])) ids.delete(id);
    }
    const needle = this.searchText ? this.searchText.toLowerCase() : null;
    const out = [];
    for (const id of ids) { const it = this.store.items.get(id); if (it && (!needle || it.search_text.includes(needle))) out.push(it); }
    if (this.catalogShelf) {
      // Shelf order — wander the corpus by glass call number (subject → form → author).
      // Uncataloged items have no address, so they sink to the end (after '~').
      const key = (it) => { const cn = this._callNumber(it); return cn ? sortKey(cn) : '~~~'; };
      out.sort((a, b) => { const ka = key(a), kb = key(b); return ka < kb ? -1 : ka > kb ? 1 : (b.published_at || 0) - (a.published_at || 0); });
    } else {
      out.sort((a, b) => (b.published_at || 0) - (a.published_at || 0));
    }
    return out;
  }

  // The glass call number for an item, from its (in-memory) catalog card. Null if
  // not yet cataloged — only holdings have a shelf address.
  _callNumber(it) {
    const card = it.glass_id && this.store.cards.get(it.glass_id);
    return card ? callNumber(card) : null;
  }

  // Wander the shelf — toggle the catalog stream between recency and glass call-
  // number order. The linear browse that gives the by-subject serendipity.
  toggleShelfOrder() {
    this.catalogShelf = !this.catalogShelf;
    const b = document.getElementById('cat-shelf'); if (b) b.classList.toggle('active', this.catalogShelf);
    this._catStatus(this.catalogShelf ? 'shelf order — wandering by call number' : 'newest-first');
    this.renderStream();
  }

  toggleFacet(facet, term) {
    const f = this.catalog.filters;
    if (!f[facet]) f[facet] = new Set();
    if (f[facet].has(term)) { f[facet].delete(term); if (!f[facet].size) delete f[facet]; }
    else { f[facet].add(term); this._unexclude(facet, term); }   // include + exclude are mutually exclusive
    this.renderAll();
  }
  // Exclude (NOT) a term: items carrying it drop out of the result entirely.
  toggleFacetExclude(facet, term) {
    const ex = this.catalog.excludes || (this.catalog.excludes = {});
    if (!ex[facet]) ex[facet] = new Set();
    if (ex[facet].has(term)) { ex[facet].delete(term); if (!ex[facet].size) delete ex[facet]; }
    else {
      ex[facet].add(term);
      const inc = this.catalog.filters[facet]; if (inc) { inc.delete(term); if (!inc.size) delete this.catalog.filters[facet]; }
    }
    this.renderAll();
  }
  _unexclude(facet, term) { const ex = this.catalog.excludes && this.catalog.excludes[facet]; if (ex) { ex.delete(term); if (!ex.size) delete this.catalog.excludes[facet]; } }
  toggleFacetGuided() {
    this.store.setSettings({ facet_guided: this.store.getSettings().facet_guided === false });
    this.renderCatalogFacets();
  }
  _activeFacets() {
    if (!this.catalog) return [];
    const f = this.catalog.filters, e = this.catalog.excludes || {};
    return [...new Set([...Object.keys(f), ...Object.keys(e)])].filter((k) => (f[k] && f[k].size) || (e[k] && e[k].size));
  }
  _facetSelN(facet) { const f = this.catalog?.filters[facet], e = this.catalog?.excludes?.[facet]; return (f ? f.size : 0) + (e ? e.size : 0); }
  clearFacetFilters() { if (!this.catalog) return; this.catalog.filters = {}; this.catalog.excludes = {}; this.renderAll(); }
  // Set the temporal include-set to every existing year in [from, to].
  applyTemporalRange() {
    const fromEl = document.querySelector('#facets .fr-from'), toEl = document.querySelector('#facets .fr-to');
    if (!fromEl || !toEl || !this.catalog) return;
    let from = Number(fromEl.value), to = Number(toEl.value);
    if (from > to) [from, to] = [to, from];
    const years = [...((this._catalogIndex && this._catalogIndex.temporal) || new Map()).keys()].filter((t) => /^\d{3,4}$/.test(t) && Number(t) >= from && Number(t) <= to);
    if (years.length) this.catalog.filters.temporal = new Set(years); else delete this.catalog.filters.temporal;
    if (this.catalog.excludes) delete this.catalog.excludes.temporal;   // a range replaces any temporal selection
    this.renderAll();
  }
  clearFacet(facet) { if (!this.catalog) return; let n = 0; if (this.catalog.filters[facet]) { delete this.catalog.filters[facet]; n++; } if (this.catalog.excludes && this.catalog.excludes[facet]) { delete this.catalog.excludes[facet]; n++; } if (n) this.renderAll(); }

  // Right-click the FACETS header (or empty space in the panel) → panel-wide
  // controls: clear the selection, the narrow toggle, collapse/expand all, and a
  // reset of the sort/collapse customization.
  facetsHeaderMenu(x, y) {
    const active = this._activeFacets();
    const guided = this.store.getSettings().facet_guided !== false;
    showMenu(x, y, [
      active.length && { label: `⊕ Save as view…`, onClick: () => this.saveFacetView() },
      active.length && { label: `✕ Clear selection (${active.length} facet${active.length === 1 ? '' : 's'})`, onClick: () => this.clearFacetFilters() },
      active.length && { sep: true },
      { label: `${guided ? '● ' : '○ '}Narrow to selection`, onClick: () => this.toggleFacetGuided() },
      { sep: true },
      { label: 'Collapse all', onClick: () => this._setAllFacetsCollapsed(true) },
      { label: 'Expand all', onClick: () => this._setAllFacetsCollapsed(false) },
      { sep: true },
      { label: '↺ Reset sort & layout', onClick: () => { this.store.setSettings({ facet_sort: {}, facet_collapsed: [] }); this.renderCatalogFacets(); } },
    ].filter(Boolean));
  }

  // Scoped term counts for guided faceting. For each facet F, a term's count =
  // items matching every OTHER active facet (F itself excluded, so OR-within-a-
  // facet still broadens) AND carrying the term — the conjunctive-across,
  // disjunctive-within counting rule. One pass over the live (card/Stage-0)
  // facets. Returns facet → Map(term → count); only called when a selection exists.
  _facetCounts(filters) {
    const out = {}; for (const f of FACETS) out[f] = new Map();
    const active = Object.keys(filters).filter((f) => filters[f] && filters[f].size);
    const excludes = this.catalog.excludes || {};
    const exActive = Object.keys(excludes).filter((f) => excludes[f] && excludes[f].size);
    const total = active.length;
    for (const item of this.store.items.values()) {
      if (item.archived) continue;
      const ff = (this._cardFacets && this._cardFacets.get(item.id)) || facetsOf(item, this.store.getFeed(item.feed_id));
      // excluded items are out of the result entirely (NOT)
      let dropped = false;
      for (const xf of exActive) { for (const t of (ff[xf] || [])) if (excludes[xf].has(t)) { dropped = true; break; } if (dropped) break; }
      if (dropped) continue;
      let matched = 0, missFacet = null;
      for (const af of active) {
        const sel = filters[af]; let hit = false;
        for (const t of (ff[af] || [])) if (sel.has(t)) { hit = true; break; }
        if (hit) matched++; else missFacet = af;
      }
      for (const F of FACETS) {
        // an item counts toward F if it matches every active facet except (at most) F itself
        if (!(matched === total || (matched === total - 1 && missFacet === F))) continue;
        const m = out[F];
        for (const t of (ff[F] || [])) m.set(t, (m.get(t) || 0) + 1);
      }
    }
    return out;
  }

  // Per-facet sort mode (persisted). Default: count, EXCEPT temporal → 'za' so
  // years read newest-first (count-sorting put 2021 above 2022 — looked broken).
  _facetSortMode(facet) {
    const m = (this.store.getSettings().facet_sort || {})[facet];
    return m || (facet === 'temporal' ? 'za' : 'count');
  }
  cycleFacetSort(facet) {
    const next = { count: 'az', az: 'za', za: 'count' }[this._facetSortMode(facet)];
    this.store.setSettings({ facet_sort: { ...(this.store.getSettings().facet_sort || {}), [facet]: next } });
    this.renderCatalogFacets();
  }
  toggleFacetCollapse(facet) {
    const set = new Set(this.store.getSettings().facet_collapsed || []);
    set.has(facet) ? set.delete(facet) : set.add(facet);
    this.store.setSettings({ facet_collapsed: [...set] });
    this.renderCatalogFacets();
  }
  _setAllFacetsCollapsed(collapse) {
    this.store.setSettings({ facet_collapsed: collapse ? [...FACETS] : [] });
    this.renderCatalogFacets();
  }

  // Apply a vocabulary edit (the thesaurus primitive) from the UI: rewrite a term
  // across every card in a facet — merge into another term, rename, or drop
  // (to===''). Persists + re-renders. Mirrors weir_mergeFacetTerm.
  async _facetMerge(facet, from, to) {
    const n = this.store.mergeFacetTerm(facet, from, to);
    if (n) { await this.store.flush(); this.renderAll(); if (this._facetDialog) this.renderFacetDialog(); }
    const sub = document.getElementById('view-sub');
    if (sub) sub.textContent = to ? `merged “${from}” → “${to}” · ${n} card${n === 1 ? '' : 's'}` : `dropped “${from}” · ${n} card${n === 1 ? '' : 's'}`;
  }

  // The long-tail browser: a dialog with the FULL term list for one facet (entity
  // alone has 15k+), its own search + sort, each term clickable to filter and
  // right-clickable to curate. Opened from a facet's "+ N more" footer or its
  // header menu — the rail caps at 40, this is "see all".
  openFacetDialog(facet) {
    this._facetDialog = facet; this._facetDialogFilter = '';
    this._facetDialogSort = this._facetSortMode(facet);   // seed from the rail, then independent
    const s = document.getElementById('facet-dialog-search'); if (s) s.value = '';
    document.getElementById('facet-overlay').hidden = false;
    this.renderFacetDialog(true);
    if (s) setTimeout(() => s.focus(), 0);
  }
  closeFacetDialog() { document.getElementById('facet-overlay').hidden = true; this._facetDialog = null; }
  cycleFacetDialogSort() {
    this._facetDialogSort = { count: 'az', az: 'za', za: 'count' }[this._facetDialogSort] || 'count';
    this.renderFacetDialog(true);
  }

  // Recompute the dialog's term list (filter + the dialog-only sort), then paint
  // the virtual window. `resetScroll` jumps to the top (new filter/sort/open).
  renderFacetDialog(resetScroll) {
    const facet = this._facetDialog; if (!facet) return;
    this.buildCatalogIndex();
    const map = this._catalogIndex[facet] || new Map();
    const filter = (this._facetDialogFilter || '').trim().toLowerCase();
    let terms = [...map.entries()];
    if (filter) terms = terms.filter(([t]) => t.toLowerCase().includes(filter));
    const mode = this._facetDialogSort;
    if (mode === 'az') terms.sort((a, b) => a[0].localeCompare(b[0]));
    else if (mode === 'za') terms.sort((a, b) => b[0].localeCompare(a[0]));
    else terms.sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));
    this._fdTerms = terms;
    const title = document.getElementById('facet-dialog-title');
    if (title) title.textContent = `${facet} — ${map.size} term${map.size === 1 ? '' : 's'}${filter ? ` · ${terms.length} matching` : ''}`;
    const sb = document.getElementById('facet-dialog-sort'); if (sb) sb.textContent = mode === 'count' ? '#' : mode === 'az' ? 'a–z' : 'z–a';
    this._renderFacetWindow(resetScroll);
  }

  // Fixed-height grid virtualization: only the visible rows (+ a buffer) are in
  // the DOM, a full-height sizer gives the scrollbar its real extent, and the
  // window is translated into place — so a 15k-term facet scrolls smoothly with
  // ~30 rows mounted. Rows are a fixed 24px (ROW_H), columns fit the panel width.
  _renderFacetWindow(resetScroll) {
    const body = document.getElementById('facet-dialog-body'); if (!body || !this._facetDialog) return;
    const terms = this._fdTerms || [];
    if (!terms.length) { body.innerHTML = '<div class="hint">No terms match.</div>'; return; }
    const facet = this._facetDialog;
    const sel = this.catalog?.filters[facet] || new Set();
    const exSet = this.catalog?.excludes?.[facet] || new Set();
    const ROW_H = 24, COL_W = 230, BUF = 6;
    if (resetScroll) body.scrollTop = 0;
    const perRow = Math.max(1, Math.floor((body.clientWidth || 720) / COL_W));
    const nRows = Math.ceil(terms.length / perRow);
    const viewH = body.clientHeight || 420;
    const firstRow = Math.max(0, Math.floor(body.scrollTop / ROW_H) - BUF);
    const lastRow = Math.min(nRows, Math.ceil((body.scrollTop + viewH) / ROW_H) + BUF);
    let rows = '';
    for (let i = firstRow * perRow; i < Math.min(terms.length, lastRow * perRow); i++) {
      const [term, set] = terms[i];
      const cls = sel.has(term) ? ' active' : exSet.has(term) ? ' excluded' : '';
      rows += `<div class="facet-term${cls}" data-facet="${escapeHtml(facet)}" data-term="${escapeHtml(term)}"><span class="ft-name">${escapeHtml(term)}</span><span class="ft-count">${set.size}</span></div>`;
    }
    body.innerHTML = `<div class="fd-sizer" style="height:${nRows * ROW_H}px"><div class="fd-rows" style="transform:translateY(${firstRow * ROW_H}px);grid-template-columns:repeat(${perRow},minmax(0,1fr))">${rows}</div></div>`;
  }

  // Right-click a facet term → curate it: filter, or the thesaurus actions
  // (merge / rename / drop) that keep the controlled vocabulary clean.
  facetTermMenu(facet, term, x, y) {
    const active = (this.catalog?.filters[facet] || new Set()).has(term);
    const excluded = (this.catalog?.excludes?.[facet] || new Set()).has(term);
    showMenu(x, y, [
      { label: active ? '✓ Filtering by this' : 'Filter by this', onClick: () => this.toggleFacet(facet, term) },
      { label: excluded ? '⊘ Excluded — click to un-exclude' : '⊘ Exclude this', onClick: () => this.toggleFacetExclude(facet, term) },
      { sep: true },
      { label: '⤳ Merge into…', onClick: () => { const to = window.prompt(`Merge “${term}” into which ${facet} term?`, ''); if (to && to.trim() && to.trim().toLowerCase() !== term) this._facetMerge(facet, term, to.trim()); } },
      { label: '✎ Rename…', onClick: () => { const to = window.prompt(`Rename ${facet} term “${term}” to:`, term); if (to != null && to.trim() && to.trim().toLowerCase() !== term) this._facetMerge(facet, term, to.trim()); } },
      { label: '⎘ Copy term', onClick: () => { navigator.clipboard?.writeText(term).catch(() => {}); } },
      { sep: true },
      { label: '⌦ Drop from catalog', onClick: () => { if (confirm(`Drop “${term}” from the ${facet} facet across all cards? Reversible by re-tagging.`)) this._facetMerge(facet, term, ''); } },
    ]);
  }

  // Right-click a facet header → sort + collapse controls for that group.
  facetGroupMenu(facet, x, y) {
    const mode = this._facetSortMode(facet);
    const collapsed = new Set(this.store.getSettings().facet_collapsed || []).has(facet);
    const setSort = (m) => { this.store.setSettings({ facet_sort: { ...(this.store.getSettings().facet_sort || {}), [facet]: m } }); this.renderCatalogFacets(); };
    const count = (this._catalogIndex && this._catalogIndex[facet] && this._catalogIndex[facet].size) || 0;
    const selN = this._facetSelN(facet);
    showMenu(x, y, [
      selN && { label: `✕ Clear ${facet} (${selN})`, onClick: () => this.clearFacet(facet) },
      selN && { sep: true },
      { label: `⋯ Browse all ${count} terms…`, onClick: () => this.openFacetDialog(facet) },
      { sep: true },
      { label: `${mode === 'count' ? '● ' : '○ '}Sort by count`, onClick: () => setSort('count') },
      { label: `${mode === 'az' ? '● ' : '○ '}Sort A→Z`, onClick: () => setSort('az') },
      { label: `${mode === 'za' ? '● ' : '○ '}Sort Z→A`, onClick: () => setSort('za') },
      { sep: true },
      { label: collapsed ? 'Expand' : 'Collapse', onClick: () => this.toggleFacetCollapse(facet) },
      { label: 'Collapse all', onClick: () => this._setAllFacetsCollapsed(true) },
      { label: 'Expand all', onClick: () => this._setAllFacetsCollapsed(false) },
    ].filter(Boolean));
  }

  renderCatalogFacets() {
    const el = document.getElementById('facets'); if (!el) return;
    if (!this.catalog) { el.innerHTML = ''; return; }
    { const b = document.getElementById('cat-shelf'); if (b) b.classList.toggle('active', !!this.catalogShelf); }
    this.buildCatalogIndex();
    const order = ['form', 'provenance', 'temporal', 'entity', 'domain', 'method', 'process', 'scale', 'spatial', 'stance'];
    const ICONS = { form: '⬡', provenance: '✦', temporal: '◷', entity: '◆', domain: '▤', method: '⚙', process: '↻', scale: '⤢', spatial: '⌖', stance: '⚖' };
    const SORT = { count: '#', az: 'a–z', za: 'z–a' };
    const filter = (this.facetFilter || '').trim().toLowerCase();
    const collapsed = new Set(this.store.getSettings().facet_collapsed || []);
    // Guided faceting: once term(s) are selected, scope every facet's counts to
    // the current selection and hide dead-ends (zero co-occurrence) so a click
    // can never reach an empty set. Default on; the toggle clears it. (The
    // browse-all dialog stays global — curation wants the whole vocabulary.)
    const guided = this.store.getSettings().facet_guided !== false;
    const active = Object.keys(this.catalog.filters).filter((f) => this.catalog.filters[f] && this.catalog.filters[f].size);
    const exAny = Object.keys(this.catalog.excludes || {}).some((f) => this.catalog.excludes[f] && this.catalog.excludes[f].size);
    const scoped = (guided && (active.length || exAny)) ? this._facetCounts(this.catalog.filters) : null;
    { const gb = document.getElementById('facet-guided'); if (gb) gb.classList.toggle('active', guided); }
    { const cb = document.getElementById('facet-clear'); if (cb) cb.hidden = !(active.length || exAny); }
    let html = '';
    for (const facet of order) {
      const map = this._catalogIndex[facet];
      if (!map || !map.size) continue;   // empty facets (un-enriched in Stage 0) stay hidden
      const sel = this.catalog.filters[facet] || new Set();
      const exSet = (this.catalog.excludes && this.catalog.excludes[facet]) || new Set();
      // term → count: scoped to the selection (guided) or global
      let entries;
      if (scoped) {
        const sc = scoped[facet] || new Map();
        entries = [];
        for (const [t, c] of sc) if (c > 0 || sel.has(t) || exSet.has(t)) entries.push([t, c]);
        for (const t of sel) if (!sc.has(t)) entries.push([t, 0]);    // keep selected terms visible
        for (const t of exSet) if (!sc.has(t)) entries.push([t, 0]);  // keep excluded terms visible (to un-exclude)
      } else {
        entries = [...map.entries()].map(([t, s]) => [t, s.size]);
      }
      if (filter) entries = entries.filter(([t]) => t.toLowerCase().includes(filter));
      if (!entries.length) continue;     // hide groups with nothing (no search match / all dead-ends)
      const mode = this._facetSortMode(facet);
      if (mode === 'az') entries.sort((a, b) => a[0].localeCompare(b[0]));
      else if (mode === 'za') entries.sort((a, b) => b[0].localeCompare(a[0]));
      else entries.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
      const isCollapsed = !filter && collapsed.has(facet);   // an active search overrides collapse
      // A collapsed group hides its terms — so surface any selection inside it as
      // a badge (count + the terms in the tooltip), and tint the header, so you can
      // fold facets without losing track of what's still filtering.
      const hidN = isCollapsed ? sel.size + exSet.size : 0;
      const selBadge = hidN ? `<span class="facet-selbadge" title="${escapeHtml([...sel, ...[...exSet].map((t) => '−' + t)].join(', '))}">${hidN}</span>` : '';
      html += `<div class="facet-group${isCollapsed ? ' collapsed' : ''}${hidN ? ' has-sel' : ''}">`
        + `<div class="facet-head">`
        + `<span class="fh-tog" data-facet="${escapeHtml(facet)}"><span class="fchev">${isCollapsed ? '▸' : '▾'}</span><span class="ico">${ICONS[facet] || '·'}</span>${escapeHtml(facet)}${selBadge}</span>`
        + `<button class="facet-sort" type="button" data-facet="${escapeHtml(facet)}" title="Sort: ${mode === 'count' ? 'by count' : mode === 'az' ? 'A→Z' : 'Z→A'} — click to cycle">${SORT[mode]}</button>`
        + `</div>`;
      if (!isCollapsed) {
        // Temporal is ordered (PMEST's Time): offer a from–to year range, not just
        // discrete year-chips. Applying it sets the include-set to the in-range
        // years that exist — reusing the normal facet machinery.
        if (facet === 'temporal') {
          const years = [...map.keys()].filter((t) => /^\d{3,4}$/.test(t)).sort((a, b) => Number(a) - Number(b));
          if (years.length > 2) {
            const selY = [...sel].filter((t) => /^\d{3,4}$/.test(t)).sort((a, b) => Number(a) - Number(b));
            const lo = selY[0] || years[0], hi = selY[selY.length - 1] || years[years.length - 1];
            const opts = (cur) => years.map((y) => `<option${y === cur ? ' selected' : ''}>${y}</option>`).join('');
            html += `<div class="facet-range"><select class="fr-from" title="From year">${opts(lo)}</select><span class="fr-dash">–</span><select class="fr-to" title="To year">${opts(hi)}</select></div>`;
          }
        }
        for (const [term, count] of entries.slice(0, 40)) {
          const cls = sel.has(term) ? ' active' : exSet.has(term) ? ' excluded' : '';
          html += `<div class="facet-term${cls}" data-facet="${escapeHtml(facet)}" data-term="${escapeHtml(term)}">`
            + `<span class="ft-name">${escapeHtml(term)}</span><span class="ft-count">${count}</span></div>`;
        }
        if (entries.length > 40) html += `<div class="facet-more" data-facet="${escapeHtml(facet)}">+ ${entries.length - 40} more</div>`;
      }
      html += '</div>';
    }
    el.innerHTML = html || `<div class="rail-empty">${filter ? 'No facets match' : (active.length ? 'No matches — clear a filter' : 'No catalog facets yet')}</div>`;
  }

  renderStream() {
    if (this.pendingImport) { this.stream.innerHTML = this.importReviewHtml(); return; }
    const scrollTop = this.stream.scrollTop;   // preserve scroll across rebuild
    this.items = this.query();
    this._buildWorkCounts();   // work_id → manifestation count, for the "⧉ N sources" badge
    if (this.selectedId && !this.items.some((x) => x.id === this.selectedId)) this.selectedId = null;
    if (!this.selectedId && this.items.length) this.selectedId = this.items[0].id;

    this.stream.classList.toggle('gallery', this.layout === 'gallery');
    if (!this.items.length) { this.stream.innerHTML = this.emptyHtml(); return; }
    const shown = this.items.slice(0, RENDER_CAP);
    let html = shown.map((it) => this.itemHtml(it)).join('');
    if (this.items.length > RENDER_CAP) html += `<div class="more">+ ${this.items.length - RENDER_CAP} more not shown</div>`;
    this.stream.innerHTML = html;
    this.stream.scrollTop = scrollTop;
    this.renderTopbar();
    if (this._pipWin) this._renderFlightDeck();   // keep the pop-out's latest list fresh
  }

  _buildWorkCounts() {
    const m = new Map();
    for (const it of this.store.items.values()) if (it.work_id) m.set(it.work_id, (m.get(it.work_id) || 0) + 1);
    this._workCounts = m;
  }

  // The "⧉ N sources" badge → the OTHER manifestations of this Work (FRBR). Click one
  // to open its source (or, lacking a URL, jump to it in weir).
  workMenu(workId, curId, x, y) {
    const others = [...this.store.items.values()].filter((i) => i.work_id === workId && i.id !== curId);
    if (!others.length) return;
    showMenu(x, y, others.map((m) => {
      const feed = (this.store.getFeed(m.feed_id) || {}).name || m.feed_id;
      return { label: `${feed}: ${m.title || m.url || m.id}`.slice(0, 90), onClick: () => { if (m.url) window.open(m.url, '_blank', 'noopener'); else { this.selectFeed(m.feed_id); this.select(m.id); } } };
    }));
  }

  emptyHtml() {
    if (this.stackFilter) {
      const where = this.stackPath ? ` in <code>${escapeHtml(this.stackPath)}/</code>` : '';
      return `<section class="onboard">
        <div class="onboard-glyph">❏</div>
        <h2>The stacks${where} are empty</h2>
        <p>Notes you write and files you drop live here as real files under <code>/stacks/</code> — filed, tagged, searchable, and (later) catalogued alongside your feeds. They're <em>yours</em> to author, not a stream to clear.</p>
        <div class="onboard-actions">
          <button class="btn btn-primary" data-stack-new="1">＋ New note</button>
        </div>
        <p class="onboard-or">also: drop a file on the window, send your weir Telegram bot a note or file (→ <code>inbox/</code>), or jot from anywhere with <kbd>n</kbd>.</p>
      </section>`;
    }
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

  itemHtml(it) { return this.layout === 'gallery' ? this.tileHtml(it) : this.rowHtml(it); }

  setLayout(mode) {
    this.layout = mode === 'gallery' ? 'gallery' : 'list';
    this.store.setSettings({ stream_layout: this.layout });
    const b = document.getElementById('btn-layout');
    if (b) { b.textContent = this.layout === 'gallery' ? '☰' : '▦'; b.title = this.layout === 'gallery' ? 'List view' : 'Gallery view'; }
    this.renderStream();
  }

  // The current view's scope as a store-query filter — what "mark all read here"
  // and other view-scoped actions act on. Mirrors what query() is showing.
  _readScope() {
    if (this.feedFilter) return { feed_id: this.feedFilter };
    if (this.catFilter != null) return { category: this.catFilter };
    if (this.route) return { route: this.route };
    if (this.smartView) return { ...this.smartView.query };
    return { view: this.view || 'inbox' };
  }

  // Unread-only filter (topbar ● button / `u`). Folds read:false into the current
  // view's query; persisted so it sticks across sessions.
  toggleUnread() {
    this.unreadOnly = !this.unreadOnly;
    this.store.setSettings({ stream_unread_only: this.unreadOnly });
    this.selectedId = null; this.expandedId = null;
    this.renderStream(); this.renderTopbar();
  }

  // Mark everything the current view/feed/folder shows as read (topbar ✓ button).
  markAllHere() {
    this.store.markAllRead(this._readScope());
    this.renderAll();
  }

  // Apply tags to every item currently shown (the whole query result — a search,
  // folder, feed, unread filter, …), stamped 'human'. The bulk sibling of the
  // per-item `t` editor. Returns the count changed.
  tagAllShown(tags) {
    const ids = (this.items || []).map((i) => i.id);
    const n = this.store.addTagBulk(ids, tags, 'human');
    this.store.flush();
    this.renderStream();
    return n;
  }

  // A one-input editor that tags the whole shown set at once ("tag all N…").
  openBulkTagEditor() {
    const items = this.items || [];
    if (!items.length) { this._catStatus('nothing shown to tag'); return; }
    document.getElementById('tag-editor')?.remove();
    const datalist = Object.keys(this.store.getTags() || {}).sort().map((t) => `<option value="${escapeHtml(t)}">`).join('');
    const scope = this.searchText ? `“${this.searchText}”` : (document.getElementById('view-title')?.textContent || 'this view');
    const overlay = document.createElement('div');
    overlay.id = 'tag-editor'; overlay.className = 'palette-overlay';
    overlay.innerHTML = `<div class="tag-editor" role="dialog" aria-label="Tag all shown">`
      + `<div class="te-title">Tag all ${items.length} item${items.length === 1 ? '' : 's'} in ${escapeHtml(scope)}</div>`
      + `<input class="te-input" list="te-sugg" placeholder="tags, comma-separated, then Enter…" autocomplete="off" autocapitalize="off" spellcheck="false">`
      + `<datalist id="te-sugg">${datalist}</datalist>`
      + `<div class="te-hint">Enter tags all ${items.length} · Esc cancels</div></div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.te-input');
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const tags = input.value.split(',').map((s) => s.trim()).filter(Boolean);
      close();
      if (!tags.length) return;
      const n = this.tagAllShown(tags);
      this._catStatus(`tagged ${n} item${n === 1 ? '' : 's'} with ${tags.map((t) => '#' + t).join(' ')}`);
    });
    input.focus();
  }

  // ── tag manager: rename / merge / delete / recolor (vocabulary control) ──
  static get TAG_COLORS() { return ['#e06c75', '#d19a66', '#e5c07b', '#98c379', '#56b6c2', '#61afef', '#c678dd', '#9aa0aa']; }

  openTagManager() { this._renderTagManager(); document.getElementById('tags-overlay').hidden = false; }

  _renderTagManager() {
    const counts = this.store.tagCounts(); const reg = this.store.getTags();
    const names = Object.keys(counts).sort((a, b) => (counts[b] - counts[a]) || a.localeCompare(b));
    const body = names.length ? names.map((t) => {
      const col = (reg[t] || {}).color || '';
      return `<div class="tm-row" data-tag="${escapeHtml(t)}">`
        + `<span class="tm-swatch" data-tmact="swatch" style="background:${col || 'transparent'};border-color:${col || 'var(--au-border)'}"></span>`
        + `<span class="tm-name">${escapeHtml(t)}</span><span class="tm-count">${counts[t]}</span>`
        + `<span class="tm-acts"><button data-tmact="rename">rename</button><button data-tmact="delete">delete</button></span></div>`;
    }).join('') : '<div class="hint">No tags yet — press <kbd>t</kbd> on an item, or use “⊕ tag all”.</div>';
    document.getElementById('tags-body').innerHTML = body;
  }

  _onTagManagerClick(e) {
    const row = e.target.closest('.tm-row'); if (!row) return;
    const tag = row.dataset.tag; const btn = e.target.closest('[data-tmact]'); if (!btn) return;
    const act = btn.dataset.tmact;
    if (act === 'rename') {
      const next = prompt(`Rename “${tag}” to… (an existing tag name merges the two):`, tag);
      if (next == null) return;
      const v = next.trim(); if (!v || v === tag) return;
      const n = this.store.renameTag(tag, v); this.store.flush();
      this._renderTagManager(); this.renderStream(); this.renderViews();
      this._catStatus(`renamed “${tag}” → “${v}” on ${n} item${n === 1 ? '' : 's'}`);
    } else if (act === 'delete') {
      if (!confirm(`Remove the tag “${tag}” from all items? (the items themselves stay)`)) return;
      const n = this.store.deleteTag(tag); this.store.flush();
      this._renderTagManager(); this.renderStream(); this.renderViews();
      this._catStatus(`deleted “${tag}” from ${n} item${n === 1 ? '' : 's'}`);
    } else if (act === 'swatch') {
      this._openTagColorPicker(row, tag);
    }
  }

  _openTagColorPicker(row, tag) {
    document.querySelectorAll('#tags-body .tm-palette').forEach((p) => p.remove());
    const pal = document.createElement('span'); pal.className = 'tm-palette';
    pal.innerHTML = ['', ...App.TAG_COLORS].map((c) =>
      `<span class="tm-pick" data-color="${c}" style="background:${c || 'transparent'};border-color:${c || 'var(--au-fg-soft)'}" title="${c || 'none'}">${c ? '' : '∅'}</span>`).join('');
    pal.addEventListener('click', async (e) => {
      const p = e.target.closest('.tm-pick'); if (!p) return;
      await this.store.setTag(tag, { color: p.dataset.color || undefined });
      this._renderTagManager(); this.renderStream();
    });
    row.querySelector('.tm-swatch').after(pal);
  }

  // Gallery tile — kept as `.item` (plus `.tile`) so the click/select/reflect
  // plumbing is shared with rows. Thumbnail where the item carries one (videos
  // always do); otherwise a colored type-tile. Expanding spans the full row.
  tileHtml(it) {
    const feed = this.store.getFeed(it.feed_id);
    const expanded = it.id === this.expandedId;
    const cls = `item tile${it.id === this.selectedId ? ' sel' : ''}${it.read ? ' read' : ''}${expanded ? ' expanded' : ''}`;
    const thumb = it.media && it.media.thumbnail;
    const dur = it.media?.duration_seconds ? `<span class="dur">${fmtDuration(it.media.duration_seconds)}</span>` : '';
    const cover = thumb
      ? `<img class="tcover" loading="lazy" src="${escapeHtml(thumb)}" alt="">`
      : `<span class="tcover ph" style="--mh:${monogram(feed || { name: it.title }).hue}">${escapeHtml((it.type || '?')[0].toUpperCase())}</span>`;
    const play = it.type === 'video' ? '<span class="playover">▶</span>' : '';
    const flag = it.saved ? '<span class="tflag">★</span>' : '';
    const actions = `<div class="iactions">`
      + `<button data-act="save" title="${it.saved ? 'Unsave' : 'Save'} (s)">${it.saved ? '★' : '☆'}</button>`
      + `<button data-act="read" title="Mark ${it.read ? 'unread' : 'read'} (r)">${it.read ? '○' : '●'}</button>`
      + `<button data-act="archive" title="Archive (e)">⌫</button>`
      + (it.url ? `<button data-act="open" title="Open original (o)">↗</button>` : '')
      + `</div>`;
    return `<article class="${cls}" data-id="${escapeHtml(it.id)}">`
      + `<div class="tthumb">${cover}${play}${dur}${flag}${actions}</div>`
      + `<div class="tinfo"><span class="pill ${escapeHtml(it.type)}">${escapeHtml(it.type)}</span>`
      + `<div class="ttitle">${escapeHtml(it.title)}</div>`
      + `<div class="tsub">${feed ? escapeHtml(feed.name) : ''}<span class="dot-sep">·</span>${relativeTime(it.published_at)}</div></div>`
      + `<div class="iexpand">${expanded ? this.expandedHtml(it) : ''}</div></article>`;
  }

  rowHtml(it) {
    const feed = this.store.getFeed(it.feed_id);
    const cls = `item${it.id === this.selectedId ? ' sel' : ''}${it.read ? ' read' : ''}${it.id === this.expandedId ? ' expanded' : ''}`;
    const meta = [feed ? escapeHtml(feed.name) : escapeHtml(it.feed_id), it.author && escapeHtml(it.author),
      `<span title="${escapeHtml(isoTitle(it.published_at))}">${relativeTime(it.published_at)}</span>`].filter(Boolean).join('<span class="dot-sep">·</span>');
    const tsrc = it.tag_src || {};
    const treg = this.store.getTags();
    const tagGlyph = { human: '<span class="tag-src h" title="your tag">●</span>', llm: '<span class="tag-src l" title="tagged by Claude">◆</span>', rule: '<span class="tag-src r" title="rule-applied">⋔</span>' };
    const tags = (it.tags || []).map((t) => {
      const raw = (treg[t] || {}).color; const col = /^#[0-9a-f]{3,8}$/i.test(raw || '') ? raw : null;   // only our preset hexes → no style injection
      const sty = col ? ` style="color:${col};border-color:${col}"` : '';
      return `<span class="tag" data-tag="${escapeHtml(t)}"${sty} title="filter by ${escapeHtml(t)}">${tagGlyph[tsrc[t]] || ''}${escapeHtml(t)}</span>`;
    }).join('')
      + (isWrappedUrl(it.url) ? '<span class="tag unresolved" title="Shortened/share link — resolving to its real URL in the background">⧉ unresolved</span>' : '');
    const saved = it.saved ? '<span class="flag">★</span>' : '';
    const cn = this.catalog ? this._callNumber(it) : null;
    const callno = cn ? `<span class="callno" data-callno="${escapeHtml(renderCoded(cn))}" title="${escapeHtml(renderReadable(cn))} — click to copy the call number">${escapeHtml(renderCoded(cn))}</span>` : '';
    const ddc = (this.catalog && it.structured && it.structured.ddc) ? `<span class="ddc" title="Dewey — display metadata from your record (not the organizing system)">DDC ${escapeHtml(it.structured.ddc)}</span>` : '';
    // FRBR: this item is one manifestation of a Work that appears in N sources.
    const wn = it.work_id && this._workCounts ? (this._workCounts.get(it.work_id) || 0) : 0;
    const wbadge = wn > 1 ? `<span class="wbadge" data-work="${escapeHtml(it.work_id)}" title="Same content in ${wn} sources — click to see the others">⧉ ${wn}</span>` : '';

    let body;
    const isVideo = it.type === 'video';
    const hasThumb = !!(it.media && it.media.thumbnail);
    if (isVideo || hasThumb) {
      // Thumbnail row — videos always, and any item carrying a thumbnail (e.g. an
      // article's og:image), matching gallery. Play overlay only for video;
      // articles keep their excerpt. Images are lazy + browser-cached (same URLs
      // gallery uses), so the thumbnail is free once it's been seen in either view.
      const dur = it.media?.duration_seconds ? `<span class="dur">${fmtDuration(it.media.duration_seconds)}</span>` : '';
      const thumb = hasThumb ? `<img class="thumbimg" loading="lazy" src="${escapeHtml(it.media.thumbnail)}" alt="">` : '';
      const play = isVideo ? '<span class="playover">▶</span>' : '';
      const views = it.structured?.views ? `<span class="dot-sep">·</span><span>${fmtCount(it.structured.views)} views</span>` : '';
      const excerpt = (!isVideo && it.excerpt && !it.title_synth) ? `<div class="iexcerpt">${escapeHtml(it.excerpt)}</div>` : '';
      body = `<div class="ivideo"><div class="thumb">${thumb}${play}${dur}</div><div class="vbody"><div class="ititle">${saved}${escapeHtml(it.title)}</div>${excerpt}<div class="imeta">${callno}${ddc}${meta}${views} ${tags}${wbadge}</div></div></div>`;
    } else {
      body = `<div class="ititle">${saved}${escapeHtml(it.title)}</div>${(it.excerpt && !it.title_synth) ? `<div class="iexcerpt">${escapeHtml(it.excerpt)}</div>` : ''}<div class="imeta">${callno}${ddc}${meta} ${tags}${wbadge}</div>`;
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
    if (it.feed_id === 'stacks') return this._stacksExpandedHtml(it);
    let inner = '';
    if (it.type === 'podcast' && it.media?.audio_url) inner += `<audio class="player" controls preload="none" src="${escapeHtml(it.media.audio_url)}"></audio>`;
    if (it.structured && Array.isArray(it.structured.coords) && it.structured.coords.length >= 2) inner += this._miniMapHtml(it);

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
    inner += this._backlinksHtml(it);   // notes that reference this item
    return inner;
  }

  // Offline pin-on-world for any item carrying `structured.coords` ([lon, lat]) — the
  // gauge's events, today; gazetteer-resolved items later. Vendored equirectangular
  // world (no tiles, no network); the heavier interactive GIS is the lazy spinifex
  // layer (ROADMAP).
  _miniMapHtml(it) {
    const [lon, lat] = it.structured.coords;
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return '';
    const x = (lon + 180).toFixed(1), y = (90 - lat).toFixed(1);
    const place = it.structured.place ? escapeHtml(it.structured.place) : '';
    return `<div class="minimap"${place ? ` title="${place}"` : ''}>`
      + `<svg viewBox="${WORLD_VIEWBOX}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Location map${place ? `: ${place}` : ''}">`
      + `<path class="mm-land" d="${WORLD_PATH}"/>`
      + `<circle class="mm-ping" cx="${x}" cy="${y}" r="3"/><circle class="mm-pin" cx="${x}" cy="${y}" r="3"/>`
      + `</svg><span class="mm-coord">${lat.toFixed(2)}°, ${lon.toFixed(2)}°</span></div>`;
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
    if (e.target.closest('[data-stack-new]')) { this.openNoteEditor(); return; }
    const link = e.target.closest('.wikilink, .backlink');
    if (link) { e.preventDefault(); e.stopPropagation(); if (link.dataset.target) this._openRef(link.dataset.target); return; }
    const imp = e.target.closest('[data-import]');
    if (imp) { this.runImport(imp.dataset.import); return; }
    const sample = e.target.closest('[data-sample]');
    if (sample) { document.getElementById('addfeed-input').value = sample.dataset.sample; this.addFeed(sample.dataset.sample); return; }
    const btn = e.target.closest('[data-act]');
    const row = e.target.closest('.item');
    if (!row) return;
    const id = row.dataset.id;
    const tagEl = e.target.closest('.tag[data-tag]');
    if (tagEl) { e.stopPropagation(); this.filterByTag(tagEl.dataset.tag); return; }
    const cnEl = e.target.closest('.callno');
    if (cnEl) { e.stopPropagation(); navigator.clipboard?.writeText(cnEl.dataset.callno).catch(() => {}); this._catStatus(`copied call number ${cnEl.dataset.callno}`); return; }
    const wbEl = e.target.closest('.wbadge');
    if (wbEl) { e.stopPropagation(); this.workMenu(wbEl.dataset.work, id, e.clientX, e.clientY); return; }
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
    if (act === 'editnote') { this.openNoteEditor(id); return; }
    if (act === 'dlfile') { this.downloadStacksFile(id); return; }
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
      { label: 'Tag…', onClick: () => this.openTagEditor(id) },
      { label: it.archived ? 'Unarchive' : 'Archive', onClick: () => { if (it.archived) { this.store.setState(id, { archived: false }); this.reflectItem(id); } else this.doAct('archive', id); } },
      { sep: true },
      { label: it.glass_id ? 'Re-catalog with AI' : 'Catalog with AI', onClick: () => this.catalogItem(id) },
      (it.glass_id && this._cardReview && this._cardReview.get(id)?.needs_review) && { label: '✓ Mark reviewed', onClick: () => this.markReviewed(id) },
      it.feed_id === 'saved' && { label: '⧉ Fetch link metadata', onClick: () => this.enrichSavedItem(id) },
      it.url && { label: 'Copy link', onClick: () => navigator.clipboard?.writeText(it.url).catch(() => {}) },
    ].filter(Boolean));
  }

  // Context menu for a stacks entry (rail tree row + stream row). Notes get Edit;
  // files get Download. Delete routes to trash (never-delete; recoverable + undo).
  stacksEntryMenu(id, x, y) {
    const it = this.store.getItem(id); if (!it) return;
    const isNote = it.type === 'note';
    showMenu(x, y, [
      { label: 'Open', onClick: () => this.selectStackEntry(id) },
      isNote && { label: '✎ Edit', onClick: () => this.openNoteEditor(id) },
      !isNote && { label: '⬇ Download', onClick: () => this.downloadStacksFile(id) },
      (!isNote && (/^text\//.test(it.mime || '') || /\.(md|markdown|mdown|txt|csv|json|log|ya?ml)$/i.test(it.path || ''))) && { label: '✎ Convert to note', onClick: () => this.convertStackToNote(id) },
      it.url && { label: 'Open original ↗', onClick: () => window.open(it.url, '_blank', 'noopener') },
      { sep: true },
      { label: 'Tag…', onClick: () => this.openTagEditor(id) },
      { label: 'Move to folder…', onClick: () => this.moveStackPrompt(id) },
      it.uid && { label: 'Copy [[link]]', onClick: () => { navigator.clipboard?.writeText(`[[${it.uid}]]`).catch(() => {}); const sub = document.getElementById('view-sub'); if (sub) sub.textContent = `copied [[${it.uid}]]`; } },
      { label: it.glass_id ? 'Re-catalog with AI' : 'Catalog with AI', onClick: () => this.catalogItem(id) },
      { sep: true },
      { label: '⌦ Delete', onClick: () => this.trashStack(id) },
    ].filter(Boolean));
  }
  async convertStackToNote(id) {
    const it = this.store.getItem(id); if (!it || !this.stacks) return;
    const rec = await this.stacks.convertToNote(it);
    await this.store.flush(); this.renderStacks();
    if (this.stackFilter) { this.selectStackEntry(rec.id); } else { this.renderStream(); }   // open it as a note
  }
  async moveStackPrompt(id) {
    const it = this.store.getItem(id); if (!it || !this.stacks) return;
    const to = window.prompt('Move to folder (e.g. notes, papers/kriging):', this._stackFolderOf(it.path));
    if (to == null) return;
    await this.stacks.move(it, to.trim());
    await this.store.flush(); this.renderStacks(); if (this.stackFilter) this.renderStream();
  }
  async trashStack(id) {
    const it = this.store.getItem(id); if (!it || !this.stacks) return;
    const title = it.title || it.path;
    if (this.expandedId === id) this.expandedId = null;
    const r = await this.stacks.trash(it);
    await this.store.flush(); this.renderStacks(); this.renderStream();
    this.showUndo(`Deleted “${title}” (in /stacks/.trash)`, async () => {
      await this.stacks.restoreFromTrash(r.dest, r.trashed);
      await this.store.flush(); this.renderStacks(); if (this.stackFilter) this.renderStream();
    });
  }

  feedMenu(feedId, x, y) {
    const feed = this.store.getFeed(feedId); if (!feed) return;
    showMenu(x, y, [
      { label: 'Show only this feed', onClick: () => this.selectFeed(feedId) },
      feedId === 'saved' && { label: '⧉ Resolve links now', onClick: () => this.resolveLinksNow() },
      feedId === 'saved' && { label: '⌦ Remove non-content links', onClick: () => this.cleanSavedLinks() },
      feedId === 'saved' && { label: '⧉ Re-fetch weak-title links', onClick: () => this.reEnrichWeak() },
      (feed.site_url || feed.url) && { label: 'Open site ↗', onClick: () => window.open(feed.site_url || feed.url, '_blank', 'noopener') },
      { sep: true },
      { label: 'Mark all read', onClick: () => this.store.markAllRead({ feed_id: feedId }) },
      { label: '✦ Catalog this feed', onClick: () => this.catalogScope({ feed_id: feedId }) },
      { label: '↻ Re-catalog this feed', onClick: () => { if (confirm('Discard this feed’s catalog cards and re-catalog from scratch? (items + reading state kept)')) this.recatalogScope({ feed_id: feedId }); } },
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

  // ── needs_review queue: cards the cataloger flagged low-confidence (bad JSON
  // parse), surfaced for human confirm/correct. Counts come from _cardReview
  // (built in loadCardFacets); the overlay mirrors the feed-health one.
  _reviewIds() {
    const out = [];
    if (this._cardReview) for (const [id, r] of this._cardReview) if (r && r.needs_review) out.push(id);
    return out;
  }
  renderReviewStatus() {
    const el = document.getElementById('review-status'); if (!el) return;
    const n = this._reviewIds().length;
    el.textContent = n ? `⚑ ${n} to review` : '';
    el.classList.toggle('clickable', n > 0);
  }
  // Editable (LLM-language) facet axes — the ones worth correcting by hand;
  // temporal/form/provenance are deterministic so they're shown, not edited.
  static get RV_EDIT() { return ['domain', 'entity', 'process', 'method', 'scale', 'spatial', 'stance']; }

  _reviewRows() { return [...document.querySelectorAll('#review-body .rv-row')]; }

  _reviewRowHtml(id) {
    const it = this.store.getItem(id); if (!it) return '';
    const feed = this.store.getFeed(it.feed_id);
    const f = (this._cardFacets && this._cardFacets.get(id)) || {};
    const chips = FACETS.flatMap((k) => (f[k] || []).map((t) => `<span class="rv-chip">${escapeHtml(k[0])}:${escapeHtml(t)}</span>`)).slice(0, 16).join('');
    return `<div class="rv-row" data-id="${escapeHtml(id)}"><div class="rv-head"><span class="pill ${escapeHtml(it.type)}">${escapeHtml(it.type)}</span>`
      + `<span class="rv-name">${escapeHtml(it.title || '(untitled)')}</span><span class="rv-feed">${escapeHtml(feed ? feed.name : it.feed_id)}</span></div>`
      + `<div class="rv-facets">${chips || '<span class="dim">no facets</span>'}</div>`
      + `<div class="rv-actions"><button data-rvact="ok">✓ Approve</button><button data-rvact="edit">✎ Edit</button>`
      + `<button data-rvact="recat">⟳ Re-catalog</button><button data-rvact="discard">✕ Discard</button>`
      + (it.url ? `<button data-rvact="open">Open ↗</button>` : '') + `</div></div>`;
  }

  // Keyboard-first triage queue: j/k move · a/Enter approve · e edit facets ·
  // r re-catalog · x discard · o open · Esc close. Pairs the LLM's draft cards
  // with a fast human confirm/correct pass — the other half of co-curation.
  openReview() {
    const ensure = (this._cardReview && this._cardReview.size) ? Promise.resolve() : this.loadCardFacets();
    ensure.then(() => {
      const ids = this._reviewIds().slice(0, 150);
      document.getElementById('review-body').innerHTML = ids.map((id) => this._reviewRowHtml(id)).filter(Boolean).join('')
        || '<div class="hint">Nothing flagged for review — the cataloger was confident on everything loaded.</div>';
      document.getElementById('review-overlay').hidden = false;
      this._reviewSel = 0;
      if (this._reviewRows().length) this._reviewSelect(0);
      if (!this._reviewKeyFn) { this._reviewKeyFn = (e) => this._reviewKey(e); document.addEventListener('keydown', this._reviewKeyFn, true); }
    });
  }

  _reviewClose() {
    document.getElementById('review-overlay').hidden = true;
    if (this._reviewKeyFn) { document.removeEventListener('keydown', this._reviewKeyFn, true); this._reviewKeyFn = null; }
  }

  _reviewSelect(i) {
    const rows = this._reviewRows(); if (!rows.length) return;
    const n = Math.max(0, Math.min(i, rows.length - 1));
    this._reviewSel = n;
    rows.forEach((r, j) => r.classList.toggle('sel', j === n));
    rows[n].scrollIntoView({ block: 'nearest' });
  }

  // After a row leaves the queue (approved/discarded), keep a valid selection;
  // close + report when the queue empties.
  _reviewReselect() {
    const ov = document.getElementById('review-overlay'); if (!ov || ov.hidden) return;
    const rows = this._reviewRows();
    if (!rows.length) { this._reviewClose(); this._catStatus('review queue clear ✓'); return; }
    this._reviewSelect(Math.min(this._reviewSel || 0, rows.length - 1));
  }

  _reviewKey(e) {
    const ov = document.getElementById('review-overlay'); if (!ov || ov.hidden) return;
    const typing = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (typing) this._reviewCancelEdit(); else this._reviewClose(); return; }
    if (typing) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); const row = e.target.closest('.rv-row'); if (row) this.reviewSaveEdit(row.dataset.id); }
      return;   // let other keys type into the facet inputs
    }
    e.stopPropagation();   // modal: don't leak keys to the main stream handler
    const rows = this._reviewRows(); if (!rows.length) return;
    const cur = this._reviewSel || 0;
    const sel = rows[Math.max(0, Math.min(cur, rows.length - 1))];
    const idOf = () => sel && sel.dataset.id;
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); this._reviewSelect(cur + 1); }
    else if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); this._reviewSelect(cur - 1); }
    else if (e.key === 'a' || e.key === 'Enter') { e.preventDefault(); const id = idOf(); if (id) this.markReviewed(id); }
    else if (e.key === 'e') { e.preventDefault(); const id = idOf(); if (id) this.reviewEdit(id); }
    else if (e.key === 'r') { e.preventDefault(); const id = idOf(); if (id) this.catalogItem(id).then(() => this.markReviewed(id)); }
    else if (e.key === 'x') { e.preventDefault(); const id = idOf(); if (id) this.discardCard(id); }
    else if (e.key === 'o') { e.preventDefault(); const it = idOf() && this.store.getItem(idOf()); if (it && it.url) window.open(it.url, '_blank', 'noopener'); }
  }

  // Swap the selected row's facet chips for an inline editor (one input per
  // editable axis). Save → markCardReviewed({facets}) approves AND corrects.
  reviewEdit(id) {
    const row = this._reviewRows().find((r) => r.dataset.id === id); if (!row) return;
    const f = (this._cardFacets && this._cardFacets.get(id)) || {};
    const fields = App.RV_EDIT.map((k) => `<label class="rv-field"><span>${k}</span>`
      + `<input data-facet="${k}" value="${escapeHtml((f[k] || []).join(', '))}"></label>`).join('');
    row.querySelector('.rv-facets').innerHTML = `<div class="rv-editor">${fields}`
      + `<div class="rv-edit-actions"><button data-rvact="save">Save ✓</button><button data-rvact="cancel">Cancel</button></div></div>`;
    const first = row.querySelector('.rv-editor input'); if (first) { first.focus(); first.select(); }
  }

  _reviewCancelEdit() {
    const editing = this._reviewRows().find((r) => r.querySelector('.rv-editor')); if (!editing) return;
    const f = (this._cardFacets && this._cardFacets.get(editing.dataset.id)) || {};
    const chips = FACETS.flatMap((k) => (f[k] || []).map((t) => `<span class="rv-chip">${escapeHtml(k[0])}:${escapeHtml(t)}</span>`)).slice(0, 16).join('');
    editing.querySelector('.rv-facets').innerHTML = chips || '<span class="dim">no facets</span>';
  }

  async reviewSaveEdit(id) {
    const row = this._reviewRows().find((r) => r.dataset.id === id); if (!row) return;
    const it = this.store.getItem(id); if (!it || !it.glass_id) return;
    const facets = {};
    for (const inp of row.querySelectorAll('.rv-editor input[data-facet]')) facets[inp.dataset.facet] = inp.value.split(',').map((s) => s.trim()).filter(Boolean);
    try { await this.store.markCardReviewed(it.glass_id, { facets }); } catch (e) { this._catStatus(`save failed: ${e.message}`); return; }
    if (this._cardFacets) this._cardFacets.set(id, { ...(this._cardFacets.get(id) || {}), ...facets });
    if (this._cardReview && this._cardReview.get(id)) this._cardReview.get(id).needs_review = false;
    this.renderReviewStatus(); row.remove(); this._reviewReselect();
  }

  async discardCard(id) {
    const it = this.store.getItem(id); if (!it || !it.glass_id) return;
    try { await this.store.uncatalogItem(id); } catch (e) { this._catStatus(`discard failed: ${e.message}`); return; }
    if (this._cardFacets) this._cardFacets.delete(id);
    if (this._cardReview) this._cardReview.delete(id);
    this.renderReviewStatus();
    const row = this._reviewRows().find((r) => r.dataset.id === id); if (row) row.remove();
    this._reviewReselect();
  }

  async markReviewed(id) {
    const it = this.store.getItem(id); if (!it || !it.glass_id) return;
    try { await this.store.markCardReviewed(it.glass_id); } catch (e) { this._catStatus(`review failed: ${e.message}`); return; }
    if (this._cardReview && this._cardReview.get(id)) this._cardReview.get(id).needs_review = false;
    this.renderReviewStatus();
    const row = this._reviewRows().find((r) => r.dataset.id === id); if (row) row.remove();
    this._reviewReselect();
  }

  closeHealth() { document.getElementById('health-overlay').hidden = true; }

  // Re-poll every flagged feed right now — for recovering after a transient
  // outage (e.g. the bridge was down) without waiting out the adaptive backoff.
  // A successful poll resets the feed to healthy; the panel re-renders to show it.
  async retryFlaggedFeeds() {
    const flagged = this.store.listFeeds().filter((f) => this._health.get(f.id));
    const btn = document.getElementById('health-retry');
    if (!flagged.length) { if (btn) btn.textContent = 'nothing flagged'; return; }
    const t = Date.now();
    for (const f of flagged) f.next_poll_at = t - 1;   // mark due so pollDue picks them
    if (btn) { btn.disabled = true; btn.textContent = `re-polling ${flagged.length}…`; }
    try { await this.poller.pollDue(); } catch { /* poller is per-feed safe */ }
    this.recomputeHealth();
    this.renderHealthStatus();
    this.renderRail();
    if (btn) { btn.disabled = false; btn.textContent = '↻ Retry flagged'; }
    if (!document.getElementById('health-overlay').hidden) this.openHealth();   // reflect recovery
  }

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
      { label: '✦ Catalog this folder', onClick: () => this.catalogScope({ category: cat }) },
      { label: this.collapsedCats.has(cat) ? 'Expand' : 'Collapse', onClick: () => this.toggleCat(cat) },
      { sep: true },
      { label: 'Collapse all folders', onClick: () => this.collapseAllCats() },
      { label: 'Expand all folders', onClick: () => this.expandAllCats() },
      { sep: true },
      { label: 'Reorder feeds…', onClick: () => this.openReorder(cat) },
    ]);
  }

  // Collapse / expand every folder at once (folder menu + the rail-background
  // menu). collapseAll seeds collapsedCats from the live category set (incl. ''
  // = ungrouped); expandAll just clears it.
  collapseAllCats() { this.collapsedCats = new Set(this.store.listFeeds().map((f) => f.category || '')); this.renderRail(); }
  expandAllCats() { this.collapsedCats.clear(); this.renderRail(); }

  // Right-click on empty rail space (not a feed or folder header).
  railMenu(x, y) {
    showMenu(x, y, [
      { label: 'Collapse all folders', onClick: () => this.collapseAllCats() },
      { label: 'Expand all folders', onClick: () => this.expandAllCats() },
      { sep: true },
      { label: 'Manage tags…', onClick: () => this.openTagManager() },
    ]);
  }

  // ── rail sections: collapse + reorder (persisted) ──
  // The rail is an ordered list of collapsible sections. Order + collapsed-set live
  // in settings so a user can pin Stacks up top, fold Sources away, etc.
  _railSectionKeys() { return ['views', 'sources', 'routed', 'tags', 'stacks']; }
  _railOrder() {
    const all = this._railSectionKeys();
    const saved = Array.isArray(this.store.getSettings().rail_order) ? this.store.getSettings().rail_order : [];
    const order = saved.filter((k) => all.includes(k));
    for (const k of all) if (!order.includes(k)) order.push(k);   // append any section new since the order was saved
    return order;
  }
  // Reflect the saved order + collapsed-set onto the DOM. Only touches section
  // wrappers (not their contents), so it's safe to run once at mount — renderRail/
  // renderTags/etc. set inner HTML + the wrapper's display, never the order/collapse.
  applyRailLayout() {
    const aside = document.querySelector('.rail'); if (!aside) return;
    const collapsed = new Set(this.store.getSettings().rail_collapsed || []);
    const brand = aside.querySelector('.brand');
    let anchor = brand;
    for (const key of this._railOrder()) {
      const sec = aside.querySelector(`.rail-section[data-rail-section="${key}"]`);
      if (!sec) continue;
      if (anchor) aside.insertBefore(sec, anchor.nextSibling); else aside.appendChild(sec);
      anchor = sec;
      sec.classList.toggle('collapsed', collapsed.has(key));
      const tog = sec.querySelector('.sec-tog'); if (tog) tog.textContent = collapsed.has(key) ? '▸' : '▾';
    }
    // Keep the catalog facet browser glued to the Sources slot (it replaces Sources
    // in catalog mode), so it lands wherever Sources sits.
    const fac = document.getElementById('facets-section'); const src = aside.querySelector('.rail-section[data-rail-section="sources"]');
    if (fac && src) aside.insertBefore(fac, src);
  }
  toggleRailSection(key) {
    const c = new Set(this.store.getSettings().rail_collapsed || []);
    c.has(key) ? c.delete(key) : c.add(key);
    this.store.setSettings({ rail_collapsed: [...c] });
    this.applyRailLayout();
  }
  moveRailSection(key, where) {
    const order = this._railOrder(); const i = order.indexOf(key);
    if (i < 0) return;
    order.splice(i, 1);
    const at = where === 'top' ? 0 : where === 'bottom' ? order.length : where === 'up' ? Math.max(0, i - 1) : Math.min(order.length, i + 1);
    order.splice(at, 0, key);
    this.store.setSettings({ rail_order: order });
    this.applyRailLayout();
  }
  railSectionMenu(key, x, y) {
    const collapsed = new Set(this.store.getSettings().rail_collapsed || []);
    const order = this._railOrder(); const i = order.indexOf(key);
    showMenu(x, y, [
      { label: collapsed.has(key) ? 'Expand section' : 'Collapse section', onClick: () => this.toggleRailSection(key) },
      { sep: true },
      i > 0 && { label: 'Move up', onClick: () => this.moveRailSection(key, 'up') },
      i >= 0 && i < order.length - 1 && { label: 'Move down', onClick: () => this.moveRailSection(key, 'down') },
      i > 0 && { label: 'Move to top', onClick: () => this.moveRailSection(key, 'top') },
      i >= 0 && i < order.length - 1 && { label: 'Move to bottom', onClick: () => this.moveRailSection(key, 'bottom') },
    ].filter(Boolean));
  }

  // Reorder the feeds within a folder — a move up/down list that writes a manual
  // feed.order (overriding the affinity/name sort). _reorder holds the working
  // id list so the dialog can shuffle without touching the store until Save.
  openReorder(cat) {
    const ord = (f) => (f.order == null ? Infinity : f.order);
    const feeds = this.store.listFeeds().filter((f) => (f.category || '') === cat)
      .sort((x, y) => ord(x) - ord(y) || (y.affinity || 0) - (x.affinity || 0) || x.name.localeCompare(y.name));
    if (!feeds.length) return;
    this._reorder = { cat, ids: feeds.map((f) => f.id) };
    document.getElementById('reorder-title').textContent = `Reorder “${cat || 'ungrouped'}”`;
    this.renderReorderList();
    document.getElementById('reorder-overlay').hidden = false;
  }

  renderReorderList() {
    const el = document.getElementById('reorder-list'); if (!el || !this._reorder) return;
    el.innerHTML = this._reorder.ids.map((id, i) => {
      const f = this.store.getFeed(id); if (!f) return '';
      return `<div class="reorder-row" data-id="${escapeHtml(id)}">`
        + `<span class="ro-name">${escapeHtml(f.name)}</span>`
        + `<span class="ro-btns"><button data-ro="up" ${i === 0 ? 'disabled' : ''} title="Move up">▲</button>`
        + `<button data-ro="down" ${i === this._reorder.ids.length - 1 ? 'disabled' : ''} title="Move down">▼</button></span></div>`;
    }).join('');
  }

  onReorderClick(e) {
    const btn = e.target.closest('[data-ro]'); if (!btn || !this._reorder) return;
    const row = e.target.closest('.reorder-row'); const id = row?.dataset.id; if (!id) return;
    const ids = this._reorder.ids; const i = ids.indexOf(id);
    const j = btn.dataset.ro === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    this.renderReorderList();
  }

  async saveReorder() {
    if (!this._reorder) return this.closeReorder();
    const { ids } = this._reorder;
    for (let i = 0; i < ids.length; i++) {
      const f = this.store.getFeed(ids[i]);
      if (f && f.order !== i) await this.store.updateFeed(ids[i], { order: i });
    }
    this.closeReorder();
    this.renderRail();
  }

  closeReorder() { document.getElementById('reorder-overlay').hidden = true; this._reorder = null; }

  // Dev/handoff: dump the search corpus (one doc per stored item, librarian's
  // field shape: title + author + body) and download it as JSON. Used to hand
  // a real-world corpus to @gcu/librarian v2 development. Run from the console:
  //   await __weir.exportCorpus()           // includes full bodies
  //   await __weir.exportCorpus({ bodies:false })
  async exportCorpus({ bodies = true, download = true } = {}) {
    const strip = (html) => String(html || '')
      .replace(/<[^>]+>/g, ' ').replace(/&[a-z]+;|&#\d+;/gi, ' ').replace(/\s+/g, ' ').trim();
    const docs = [];
    const types = {};
    let withBody = 0, bodyChars = 0;
    for (const it of this.store.items.values()) {
      let body = it.excerpt || '';
      if (bodies && it.has_content) {
        try { const html = await this.store.getContent(it.id); if (html) { body = strip(html); withBody++; } } catch { /* skip */ }
      }
      bodyChars += body.length;
      types[it.type] = (types[it.type] || 0) + 1;
      docs.push({ id: it.id, type: it.type, title: it.title || '', author: it.author || '', body });
    }
    const corpus = {
      meta: {
        generator: 'weir.exportCorpus', generated: new Date().toISOString(),
        fields: { title: { boost: 4 }, author: { boost: 2 }, body: { boost: 1 } },
        count: docs.length, withFullBody: withBody, avgBodyChars: docs.length ? Math.round(bodyChars / docs.length) : 0, types,
      },
      docs,
    };
    if (download && typeof document !== 'undefined') {
      const blob = new Blob([JSON.stringify(corpus)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `weir-search-corpus-${docs.length}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }
    return corpus.meta;
  }

  viewMenu(view, x, y) {
    showMenu(x, y, [{ label: 'Mark all read', onClick: () => this.store.markAllRead({ view }) }]);
  }

  _reflectSearch() { const b = document.getElementById('btn-saveview'); if (b) b.hidden = !this.searchText || !!this.smartView; }

  setView(view) { if (view === 'catalog') return this.setCatalog(); if (view === 'stacks') return this.enterStacks(); this.view = view; this.feedFilter = null; this.route = null; this.catFilter = null; this.smartView = null; this.catalog = null; this.stackFilter = null; this.stackPath = null; this.selectedId = null; this.expandedId = null; this.renderAll(); }
  setRoute(name) { this.route = name; this.view = null; this.feedFilter = null; this.catFilter = null; this.smartView = null; this.catalog = null; this.stackFilter = null; this.stackPath = null; this.selectedId = null; this.expandedId = null; this.renderAll(); }
  selectFeed(id) { this.feedFilter = id; this.view = null; this.route = null; this.catFilter = null; this.smartView = null; this.catalog = null; this.stackFilter = null; this.stackPath = null; this.selectedId = null; this.expandedId = null; this.renderAll(); }

  // Filter the stream to one tag — a transient (unsaved) smart view, so it reuses
  // the existing smartView query plumbing + active-state handling. "Save view" in
  // the search box turns an ad-hoc tag filter into a permanent one.
  filterByTag(tag) {
    this.smartView = { id: `__tag:${tag}`, name: `#${tag}`, query: { tag }, transient: true };
    this.view = null; this.feedFilter = null; this.route = null; this.catFilter = null; this.catalog = null; this.stackFilter = null; this.stackPath = null;
    this.selectedId = null; this.expandedId = null; this.renderAll();
  }

  // The human side of the tagging loop: a small editor over the selected item's
  // tags. Add (Enter, autocompleting against tags we already use) or remove (×).
  // Tags are stamped source:'human'; the WebMCP weir_tagItem path stamps 'llm'.
  openTagEditor(id) {
    const it = this.store.getItem(id); if (!it) return;
    document.getElementById('tag-editor')?.remove();
    const datalist = Object.keys(this.store.getTags() || {}).sort()
      .map((t) => `<option value="${escapeHtml(t)}">`).join('');
    const overlay = document.createElement('div');
    overlay.id = 'tag-editor'; overlay.className = 'palette-overlay';
    overlay.innerHTML = `<div class="tag-editor" role="dialog" aria-label="Edit tags">`
      + `<div class="te-title">${escapeHtml((it.title || '(untitled)').slice(0, 90))}</div>`
      + `<div class="te-chips"></div>`
      + `<input class="te-input" list="te-sugg" placeholder="add a tag, then Enter…" autocomplete="off" autocapitalize="off" spellcheck="false">`
      + `<datalist id="te-sugg">${datalist}</datalist>`
      + `<div class="te-hint">Enter adds · click × to remove · Esc closes</div></div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('.te-input');
    const chipsEl = overlay.querySelector('.te-chips');
    const render = () => {
      const cur = this.store.getItem(id) || it;
      chipsEl.innerHTML = (cur.tags || []).length
        ? (cur.tags).map((t) => `<span class="te-chip" data-rm="${escapeHtml(t)}">${escapeHtml(t)} <b>×</b></span>`).join('')
        : '<span class="te-empty">no tags yet</span>';
    };
    const close = () => { overlay.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close(); });
    chipsEl.addEventListener('click', (e) => { const c = e.target.closest('[data-rm]'); if (!c) return; this.store.removeTag(id, c.dataset.rm); this.store.flush(); render(); this._refreshRow(id); });
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const v = input.value.trim();
      if (v) { this.store.addTag(id, v, 'human'); this.store.flush(); input.value = ''; render(); this._refreshRow(id); }
    });
    render();
    input.focus();
  }

  // ── command palette (Cmd/Ctrl-K) ── A flat, fuzzy launcher over every
  // navigation target (views, folders, sources, routes, smart views) and the
  // actions otherwise buried in context menus. Built fresh on each open so it
  // always reflects the current rail.
  openPalette() {
    const feeds = this.store.listFeeds().filter((f) => f.id !== 'stacks');
    const views = [
      { label: 'Inbox', kind: 'View', run: () => this.setView('inbox') },
      { label: 'Saved', kind: 'View', run: () => this.setView('saved') },
      { label: 'Archived', kind: 'View', run: () => this.setView('archived') },
      { label: 'Catalog', kind: 'View', run: () => this.setCatalog() },
      { label: 'Stacks', kind: 'View', hint: 'notes + files', run: () => this.enterStacks() },
    ];
    const cmds = [
      { label: this.unreadOnly ? 'Show all (not just unread)' : 'Show only unread', kind: 'Command', run: () => this.toggleUnread() },
      { label: 'Add source / paste…', kind: 'Command', hint: 'feed URL, OPML, links', run: () => document.getElementById('addfeed-input')?.focus() },
      { label: 'Search items', kind: 'Command', run: () => this.searchEl?.focus() },
      this.searchText && this.searchText.trim() && { label: 'Save current search as view', kind: 'Command', run: () => this.saveSearchAsView() },
      { label: 'Catalog visible items with AI', kind: 'Command', run: () => this.catalogVisible() },
      this.catalog && { label: this.catalogShelf ? 'Shelf order: off (newest-first)' : 'Shelf order — wander by call number', kind: 'Command', run: () => this.toggleShelfOrder() },
      { label: 'Catalog all items with AI', kind: 'Command', run: () => this.catalogAll() },
      { label: 'Review queue', kind: 'Command', run: () => this.openReview() },
      this.selectedId && { label: 'Tag selected item…', kind: 'Command', run: () => this.openTagEditor(this.selectedId) },
      { label: 'Tag all shown items…', kind: 'Command', run: () => this.openBulkTagEditor() },
      { label: 'Manage tags…', kind: 'Command', run: () => this.openTagManager() },
      { label: 'New note / jot…', kind: 'Command', hint: 'stacks', run: () => this.openNoteEditor() },
      { label: 'Rescan stacks folder', kind: 'Command', run: () => this.rescanStacks() },
      { label: 'Stacks filing rules…', kind: 'Command', run: () => this.openRules('stacks') },
      { label: 'Resolve saved links now', kind: 'Command', run: () => this.resolveLinksNow() },
      { label: 'Re-fetch weak-title links', kind: 'Command', run: () => this.reEnrichWeak() },
      { label: 'Remove non-content links', kind: 'Command', run: () => this.cleanSavedLinks() },
      { label: 'Retry flagged feeds', kind: 'Command', run: () => this.retryFlaggedFeeds() },
      { label: `Switch to ${this.layout === 'gallery' ? 'list' : 'gallery'} view`, kind: 'Command', run: () => this.setLayout(this.layout === 'gallery' ? 'list' : 'gallery') },
      { label: 'Mark all read here', kind: 'Command', run: () => this.markAllHere() },
      { label: 'Collapse all folders', kind: 'Command', run: () => this.collapseAllCats() },
      { label: 'Expand all folders', kind: 'Command', run: () => this.expandAllCats() },
      { label: 'Flight deck', kind: 'Command', run: () => this.openFlightDeck() },
      { label: 'Routing rules', kind: 'Command', run: () => this.openRules() },
      { label: 'Feed health', kind: 'Command', run: () => this.openHealth() },
      { label: 'Settings', kind: 'Command', run: () => this.openSettings() },
      { label: 'Toggle WebMCP', kind: 'Command', run: () => this.toggleWebmcp() },
      { label: 'Check for updates', kind: 'Command', run: () => this.checkUpdates() },
      { label: 'Keyboard shortcuts', kind: 'Command', run: () => this.openHelp() },
    ];
    const smartViews = this.store.getViews().map((v) => ({ label: v.name, kind: 'View', hint: this.viewSummary(v), run: () => this.setSmartView(v.id) }));
    const routes = Object.keys(this.store.counts().routes).sort().map((n) => ({ label: n, kind: 'Route', run: () => this.setRoute(n) }));
    const folders = [...new Set(feeds.map((f) => f.category).filter(Boolean))].sort()
      .map((c) => ({ label: c, kind: 'Folder', run: () => this.setCategory(c) }));
    const sources = feeds.map((f) => ({ label: f.name, kind: 'Source', hint: f.category || undefined, run: () => this.selectFeed(f.id) }));
    showPalette([...views, ...cmds, ...smartViews, ...routes, ...folders, ...sources].filter(Boolean));
  }

  onKey(e) {
    // Command palette (Cmd/Ctrl-K) — works everywhere, even from the search box.
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); this.openPalette(); return; }
    // Cmd/Ctrl-S saves the open note editor, from anywhere within it.
    const seOpen = !document.getElementById('stacks-editor-overlay')?.hidden;
    if (seOpen && (e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); this.saveNoteEditor(); return; }
    if ((e.metaKey || e.ctrlKey) && (e.key === 's' || e.key === 'S') && !document.getElementById('rules-overlay')?.hidden) { e.preventDefault(); this.saveRules(); return; }
    // Esc closes any open overlay first, from anywhere (incl. from a field in it).
    if (e.key === 'Escape') {
      if (seOpen) { e.preventDefault(); this.closeNoteEditor(); if (e.target.blur) e.target.blur(); return; }
      for (const id of ['help-overlay', 'settings-overlay', 'rules-overlay', 'feededit-overlay', 'health-overlay', 'reorder-overlay', 'tags-overlay', 'facet-overlay']) {
        const ov = document.getElementById(id);
        if (ov && !ov.hidden) { ov.hidden = true; if (id === 'facet-overlay') this._facetDialog = null; return; }
      }
    }
    // The note editor is a MODAL: once it's open, swallow every remaining key here so
    // nav/single-key shortcuts (j/k/r/s/n…) can't leak to the background stream. CM6
    // and the title/tags fields handle their own input natively; we just stay out of
    // the way. (Cmd-K / Cmd-S / Esc were already handled above.)
    if (seOpen) return;
    const tag = e.target.tagName;
    // "Are they typing?" — INPUT/TEXTAREA *and* any contenteditable (CM6's .cm-content
    // is a contenteditable div, not a textarea — single-key shortcuts must not fire).
    if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable || (e.target.closest && e.target.closest('.cm-editor'))) {
      if (e.key === 'Escape') {
        if (e.target === this.searchEl) { e.target.value = ''; this.searchText = ''; this.renderStream(); }
        else if (e.target.id === 'rules-text') { this.closeRules(); }
        else if (e.target.closest('#settings-overlay')) { this.closeSettings(); }
        else if (e.target.closest('#feededit-overlay')) { this.closeFeedEdit(); }
        else if (e.target.closest('#facet-overlay')) { this.closeFacetDialog(); }
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
      case 't': if (this.selectedId) { e.preventDefault(); this.openTagEditor(this.selectedId); } break;
      case 'n': e.preventDefault(); this.openNoteEditor(); break;
      case 'u': e.preventDefault(); this.toggleUnread(); break;
      case 'g': this._g = true; setTimeout(() => { this._g = false; }, 800); break;
      case '/': e.preventDefault(); this.searchEl.focus(); break;
      default: break;
    }
  }

  async addFeed(url) {
    let host = url; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* keep raw */ }
    const matched = this.adapters.find((a) => { try { return a.match(url); } catch { return false; } });
    const adapter = matched?.name || 'feed';
    // Some adapters resolve a friendly URL (a github repo) to its real feed URL
    // up front, without a fetch, and offer a nicer default name.
    const resolved = (matched?.resolveUrl && matched.resolveUrl(url)) || url;
    const name = (matched?.titleFor && matched.titleFor(url)) || host;
    try {
      const feed = await this.store.putFeed({ url: resolved, name, adapter });
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

  // ── saved-link import (Telegram export / URL list / JSON) ──
  // Imports into the non-pollable 'saved' source. Items are stored IMMEDIATELY
  // with whatever url we have (a wrapper like share.google is fine) and flushed,
  // so nothing is lost on a refresh — the gentle background LinkResolver follows
  // the redirects to the real destination over time (a one-shot burst just gets
  // throttled by the shortener). The item id is hashed from the ORIGINAL url, so
  // resolution updates the url IN PLACE without changing identity → re-import is
  // idempotent. Imported links catalog like any item.
  async importLinks(links, format = 'import') {
    const sub = document.getElementById('view-sub');
    if (!links || !links.length) { if (sub) sub.textContent = `no links found in that ${format} file`; return { inserted: 0, updated: 0 }; }
    await this._ensureSavedSource();

    const raws = links.map((l) => {
      const id = `saved:h${hash32(String(l.url).toLowerCase())}`;
      const ex = this.store.getItem(id);
      const url = (ex && ex.url && !isWrappedUrl(ex.url)) ? ex.url : l.url;   // keep a previously-resolved url
      return {
        id, feed_id: 'saved', url,
        title: l.title || (() => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } })(),
        type: /(?:youtube\.com|youtu\.be)\//i.test(url) ? 'video' : 'article',
        published_at: l.date || undefined,
        tags: [],
      };
    });
    const res = await this.store.upsertItems(raws);
    await this.store.flush();          // persist now — never lose an import to a refresh
    this.linkResolver?.kick();         // resolve any wrapped links gently, in the background
    this.renderRail();
    this.renderStream();
    const wrapped = raws.filter((r) => isWrappedUrl(r.url)).length;
    // set the summary AFTER re-rendering (renderStream rewrites view-sub).
    if (sub) sub.textContent = `imported ${res.inserted} new${res.updated ? `, updated ${res.updated}` : ''} from ${format} → Saved Links`
      + (wrapped ? ` · resolving ${wrapped} shortened link${wrapped === 1 ? '' : 's'} in the background…` : '');
    return res;
  }

  // The 'saved' source holds imported links + (later) Telegram captures. It is
  // never polled (no feed url → a far-future next_poll_at keeps the poller's
  // due-check from ever selecting it) and never expires (retention 'forever') — a
  // deliberately-saved link must NOT get auto-archived just because its original
  // publish date is old. Re-applied each import so an older 'saved' feed is fixed.
  async _ensureSavedSource() {
    const cur = this.store.getFeed('saved');
    if (cur && cur.retention && cur.retention.unread_days === 'forever') return;
    await this.store.putFeed({ id: 'saved', name: 'Saved Links', adapter: 'saved', url: '', next_poll_at: 8.64e15, retention: { unread_days: 'forever', read_days: 'forever' } });
  }

  // Decode HTML entities (LibraryThing titles ship them, e.g. "M&atilde;os" → "Mãos")
  // via a textarea — full named-entity support, browser-native.
  _decodeHtml(s) { if (!s) return s; const t = (this._teDecode = this._teDecode || document.createElement('textarea')); t.innerHTML = String(s); return t.value; }

  // Telegram capture status — the settings-panel line AND a tiny footer indicator.
  renderTelegramStatus(st) {
    st = st || (this.telegram && this.telegram.status) || {};
    const el = document.getElementById('tg-status');
    if (el) {
      if (st.error) el.textContent = `error: ${st.error}`;
      else {
        const parts = [];
        if (st.bot) parts.push(`@${st.bot}`);
        parts.push(st.enabled ? 'polling' : 'idle');
        if (st.bound) parts.push(`bound to ${st.bound}`);
        if (st.captured) parts.push(`${st.captured} captured`);
        if (st.notes) parts.push(`${st.notes} note${st.notes === 1 ? '' : 's'} stashed`);
        if (st.ignored) parts.push(`${st.ignored} ignored`);
        el.textContent = parts.join(' · ') || 'not connected';
      }
    }
    const bar = document.getElementById('telegram-status');
    if (bar) {
      if (!st.enabled) { bar.textContent = ''; bar.title = 'Telegram capture bot'; }
      else if (st.error) { bar.textContent = '✈ ⚠'; bar.title = `Telegram capture — ${st.error}`; }
      else {
        bar.textContent = `✈${st.captured ? ' ' + st.captured : ''}`;
        bar.title = `Telegram capture${st.bot ? ' @' + st.bot : ''} — polling`
          + `${st.bound ? `, bound to ${st.bound}` : ''}${st.captured ? `, ${st.captured} captured` : ''}${st.notes ? `, ${st.notes} notes stashed` : ''}`;
      }
    }
  }
  async _verifyTelegram() {
    const el = document.getElementById('tg-status');
    const token = (document.getElementById('set-tg-token')?.value.trim()) || (await getKey('telegram'));
    if (!token) { if (el) el.textContent = 'enter a bot token first'; return; }
    if (el) el.textContent = 'checking…';
    const r = this.telegram ? await this.telegram.verify(token) : { ok: false, error: 'not ready' };
    if (el) el.textContent = r.ok ? `connected: @${r.username || '?'}` : `failed: ${r.error}`;
  }

  async _ensureBooksSource() {
    const cur = this.store.getFeed('books');
    if (cur && cur.retention && cur.retention.unread_days === 'forever') return;
    await this.store.putFeed({ id: 'books', name: 'Books', adapter: 'books', url: '', next_poll_at: 8.64e15, retention: { unread_days: 'forever', read_days: 'forever' } });
  }

  // Make sure the built-in "Books" smart view exists (it appears in VIEWS like
  // Links). DEFAULT_VIEWS covers fresh installs; this back-fills an existing user
  // who imported before the view existed. Slotted right after Links.
  async _ensureBooksView() {
    const views = this.store.getViews();
    if (views.some((v) => v.id === 'v-books')) return;
    const at = (views.findIndex((v) => v.id === 'v-links') + 1) || views.length;
    const next = [...views]; next.splice(at, 0, { id: 'v-books', name: 'Books', builtin: true, query: { feed_id: 'books' } });
    await this.store.saveViews(next);
    this.renderViews();
  }

  // Import a LibraryThing export → book holdings. Idempotent: the id is the stable
  // LibraryThing book id (or an ISBN/title hash), so re-importing a fuller export
  // UPDATES rather than dupes, and never clobbers reading state or weir tags. ISBN
  // rides in the url (→ the biblio enricher fills gaps from Open Library), and
  // DDC/LCC/ISBN ride in `structured` as display metadata. Your LibraryThing tags
  // come in stamped as yours.
  async importBooks(books, format = 'librarything') {
    const sub = document.getElementById('view-sub');
    if (!books || !books.length) { if (sub) sub.textContent = `no books found in that ${format} file`; return { inserted: 0, updated: 0 }; }
    await this._ensureBooksSource();
    await this._ensureBooksView();
    const raws = books.map((b) => {
      const id = `book:${b.lt_id || `h${hash32(String(b.isbn || b.title || '').toLowerCase())}`}`;
      const url = b.isbn ? `https://openlibrary.org/isbn/${b.isbn}` : (b.lt_id ? `https://www.librarything.com/work/${b.lt_id}` : '');
      const structured = (b.ddc || b.lcc || b.isbn) ? { ddc: b.ddc || undefined, lcc: b.lcc || undefined, isbn: b.isbn || undefined } : undefined;
      const tags = b.tags || [];
      return {
        id, feed_id: 'books', type: 'book', url,
        title: this._decodeHtml(b.title), author: this._decodeHtml(b.author) || undefined,
        published_at: b.date || undefined, excerpt: this._decodeHtml(b.excerpt) || '',   // '' (not undefined) so a re-import CLEARS a stale first-import excerpt
        tags, tag_src: tags.reduce((o, t) => { o[t] = 'human'; return o; }, {}), structured,
      };
    });
    const res = await this.store.upsertItems(raws);
    await this.store.flush();
    this.renderRail(); this.renderStream();
    if (sub) sub.textContent = `imported ${res.inserted} new${res.updated ? `, updated ${res.updated}` : ''} book${res.inserted === 1 ? '' : 's'} from ${format} → Books`;
    return res;
  }

  // Kick the background resolver to process pending wrapped/unenriched links now
  // (the "Resolve links now" source-menu command — something to click on demand).
  resolveLinksNow() {
    if (!this.linkResolver) return;
    this.linkResolver.kick();
    const n = this.linkResolver.status().pending;
    const sub = document.getElementById('view-sub');
    if (sub) sub.textContent = n ? `resolving ${n} link${n === 1 ? '' : 's'} in the background…` : 'no links pending resolution';
  }

  // Purge saved links that point at a skipped host (archive.org / telegram /
  // holo.stdgeo.com — Holocene-internal pointers, not real content) that slipped
  // in before the host was on the skip list. prune() tombstones them so they can't
  // resurface on a re-import. Saved (starred) items are exempt.
  async cleanSavedLinks() {
    const sub = document.getElementById('view-sub');
    // Junk that slipped in: skipped hosts (holo.stdgeo.com / archive / telegram),
    // and bot "Link Added" confirmations imported before the bot was filtered out
    // (these carry a real url but the bot's confirmation text as the title — a dup
    // of your own saved link, which keeps its proper version + resolves normally).
    const botConfirm = (t) => /Link ID:\s*\d/.test(t || '') || /^[\s✅]*Link Added\b/.test(t || '');
    const ids = this.store.query({ feed_id: 'saved' })
      .filter((it) => isSkippedUrl(it.url) || botConfirm(it.title))
      .map((it) => it.id);
    if (!ids.length) { if (sub) sub.textContent = 'no non-content / bot links to remove'; return; }
    const { pruned } = await this.store.prune(ids, 'non-content-link');
    this.renderAll();
    if (sub) sub.textContent = `removed ${pruned} non-content / bot link${pruned === 1 ? '' : 's'}`;
  }

  // Rework: re-fetch metadata for saved links whose title is weak (e.g. a Google
  // Discover "Source: X" attribution) → the drip re-applies a real og:title.
  async reEnrichWeak() {
    const n = await (this.linkResolver ? this.linkResolver.reEnrichWeakTitles() : 0);
    const sub = document.getElementById('view-sub');
    if (sub) sub.textContent = n ? `re-fetching ${n} weak-title link${n === 1 ? '' : 's'} in the background…` : 'no weak-title links to re-fetch';
  }

  // Resolve + fetch metadata (thumbnail/title/excerpt) for one saved link right
  // now — the per-item "Fetch link metadata" command. Works on any saved link,
  // wrapped or not (gives a direct link its thumbnail too).
  async enrichSavedItem(id) {
    const it = this.store.getItem(id);
    if (!it || !this.linkResolver) return;
    const sub = document.getElementById('view-sub');
    if (sub) sub.textContent = 'fetching link metadata…';
    let res = null;
    try { res = await this.linkResolver.enrichOne(it); await this.store.flush(); } catch { /* surfaced below */ }
    this.reflectItem(id);
    this.renderStream();
    if (sub) sub.textContent = (res && res.ok) ? 'link metadata updated' : `couldn’t fetch${res && res.reason ? ` (${res.reason})` : ''} — try again later`;
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

  // ── workspace shell (@gcu/rails) ──────────────────────────────────────────
  // The stream is the single default pane; notes (and later catalog/map/graph)
  // open as additional panes. The stream panel keeps id="stream", so the whole
  // stream/reader render path is untouched — rails only relocates where it lives.
  _initWorkspace() {
    const host = document.getElementById('workspace');
    if (!host) return;
    if (typeof createRails !== 'function') {            // graceful fallback: no rails → a plain stream div
      const s = document.createElement('div'); s.className = 'stream'; s.id = 'stream'; host.appendChild(s);
      return;
    }
    host.classList.add('ws-solo');   // single-pane default from the FIRST measure → no phantom strip band
    this.rails = createRails(host, {
      initialState: { rails: [ { id: 'r-main', flex: 1, stacks: [ { id: 's-main', flex: 1,
        active: 'stream', tabs: [ { id: 'stream', kind: 'stream', title: 'stream', closeable: false, draggable: false } ] } ] } ], floats: [] },
      renderPanel: (tab) => this._renderPanel(tab),
      renderEmpty: () => { const d = document.createElement('div'); d.className = 'rails-empty'; return d; },
    });
    // "solo" = just the stream, nothing else open → hide the tab strip so the
    // single-pane default reads exactly like before. The strip returns the moment
    // a second pane/tab exists.
    const reflectSolo = () => {
      const rs = this.rails.state.rails;
      const solo = rs.length === 1 && rs[0].stacks.length === 1 && rs[0].stacks[0].tabs.length === 1
        && (rs[0].stacks[0].tabs[0].kind === 'stream');
      host.classList.toggle('ws-solo', solo);
    };
    this.rails.on('layout:change', reflectSolo);
    reflectSolo();
  }
  // rails calls this once per tab; the returned element is cached and never
  // reparented (that's how a focused CM6 editor survives a drag).
  _renderPanel(tab) {
    if (tab.kind === 'stream') {
      let s = document.getElementById('stream');
      if (!s) { s = document.createElement('div'); s.className = 'stream'; s.id = 'stream'; }
      return s;
    }
    // note panes arrive in Move 2.
    const d = document.createElement('div'); d.className = 'rails-empty'; d.textContent = '—'; return d;
  }

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

  // ── STACKS (STACKS.md): a folder-tree of authored notes + dropped files ──
  _stackFolderOf(p) { const i = String(p || '').lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }

  // Build a nested folder tree from the flat stacks entries.
  _stackTree() {
    const root = { name: '', path: '', folders: new Map(), entries: [] };
    if (!this.stacks) return root;
    for (const e of this.stacks.entries()) {
      const parts = String(e.path || '').split('/');
      parts.pop();   // drop the filename
      let node = root, acc = '';
      for (const p of parts) { acc = acc ? `${acc}/${p}` : p; if (!node.folders.has(p)) node.folders.set(p, { name: p, path: acc, folders: new Map(), entries: [] }); node = node.folders.get(p); }
      node.entries.push(e);
    }
    return root;
  }
  _stackFolderCount(f) { let n = f.entries.length; for (const c of f.folders.values()) n += this._stackFolderCount(c); return n; }

  renderStacks() {
    const sec = document.getElementById('stacks-section'); const el = document.getElementById('stacks-tree');
    if (!sec || !el) return;
    const entries = this.stacks ? this.stacks.entries() : [];
    sec.style.display = entries.length ? '' : 'none';
    if (!entries.length) { el.innerHTML = ''; return; }
    const head = document.getElementById('stacks-head'); if (head) head.classList.toggle('active', !!this.stackFilter && this.stackPath == null);
    let html = this._renderStackNode(this._stackTree(), 0);
    const missing = entries.filter((e) => e.missing).length;
    if (missing) html += `<div class="stack-missing"><span>${missing} missing on disk</span><button data-stack-forget="1" title="Forget the vanished entries (their files are already gone)">forget</button></div>`;
    el.innerHTML = html;
  }
  _renderStackNode(node, depth) {
    let html = '';
    for (const f of [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      const collapsed = this.collapsedStackFolders.has(f.path);
      const active = this.stackFilter && this.stackPath === f.path ? ' active' : '';
      html += `<div class="stack-folder${active}" data-stack-folder="${escapeHtml(f.path)}" style="padding-left:${6 + depth * 12}px">`
        + `<span class="sf-tog">${collapsed ? '▸' : '▾'}</span><span class="sf-name">${escapeHtml(f.name)}</span><span class="sf-count">${this._stackFolderCount(f)}</span></div>`;
      if (!collapsed) html += this._renderStackNode(f, depth + 1);
    }
    for (const e of node.entries.slice().sort((a, b) => (a.title || '').localeCompare(b.title || ''))) {
      const active = this.stackFilter && this.selectedId === e.id ? ' active' : '';
      const ico = e.type === 'note' ? '✎' : '📄';
      html += `<div class="stack-entry${active}${e.missing ? ' missing' : ''}" data-stack-id="${escapeHtml(e.id)}" style="padding-left:${6 + depth * 12}px" title="${escapeHtml(e.path)}">`
        + `<span class="se-ico">${ico}</span><span class="se-name">${escapeHtml(e.title || e.path)}</span></div>`;
    }
    return html;
  }

  enterStacks() {
    this.stackFilter = true; this.stackPath = null;
    this.view = null; this.feedFilter = null; this.route = null; this.catFilter = null; this.smartView = null; this.catalog = null;
    this.selectedId = null; this.expandedId = null; this.renderAll();
  }
  setStackFolder(path) {
    this.stackFilter = true; this.stackPath = path;
    this.view = null; this.feedFilter = null; this.route = null; this.catFilter = null; this.smartView = null; this.catalog = null;
    this.selectedId = null; this.expandedId = null; this.renderAll();
  }
  toggleStackFolder(path) { if (this.collapsedStackFolders.has(path)) this.collapsedStackFolders.delete(path); else this.collapsedStackFolders.add(path); this.renderStacks(); }
  selectStackEntry(id) {
    const it = this.store.getItem(id); if (!it) return;
    this.stackFilter = true; this.stackPath = this._stackFolderOf(it.path);
    this.view = null; this.feedFilter = null; this.route = null; this.catFilter = null; this.smartView = null; this.catalog = null;
    this.selectedId = id; this.expandedId = id; this.renderAll();
  }

  async rescanStacks() {
    if (!this.stacks) return;
    const sub = document.getElementById('view-sub'); if (sub) sub.textContent = 'rescanning stacks…';
    const r = await this.stacks.scan(); await this.store.flush();
    this.renderStacks(); if (this.stackFilter) this.renderStream();
    if (sub) sub.textContent = `stacks: ${r.notes} note${r.notes === 1 ? '' : 's'}, ${r.files} file${r.files === 1 ? '' : 's'}${r.stamped ? `, ${r.stamped} newly indexed` : ''}${r.missing ? `, ${r.missing} missing` : ''}`;
  }
  _forgetStackGhosts() {
    if (!this.stacks) return;
    const n = this.stacks.forgetMissing(); this.store.flush();
    this.renderStacks(); if (this.stackFilter) this.renderStream();
    const sub = document.getElementById('view-sub'); if (sub && n) sub.textContent = `forgot ${n} missing stack entr${n === 1 ? 'y' : 'ies'}`;
  }

  // Mount a CodeMirror 6 editor into `host` (or a styled textarea fallback if the
  // CM6 bundle didn't load). `language` is a CM6 language extension (markdown()/
  // javascript()) or null; `onChange()` fires on every doc change. Returns a
  // widget-agnostic { get, set, focus, measure } shim. Shared by the note editor +
  // the routing-rules editor — cm6 is already bundled, so reusing it is free.
  _mountCm(host, language, onChange, extraExts = []) {
    const CM = window.CM6;
    if (!CM || !CM.EditorView) {   // fallback: a textarea, styled to fill the host
      const ta = document.createElement('textarea');
      ta.style.cssText = 'width:100%;height:100%;resize:none;border:none;outline:none;background:transparent;color:var(--au-fg);font-family:var(--au-font-mono);font-size:13px;line-height:1.6;padding:14px 16px;box-sizing:border-box;';
      ta.spellcheck = false; ta.autocapitalize = 'off'; if (onChange) ta.addEventListener('input', onChange); host.appendChild(ta);
      return { get: () => ta.value, set: (t) => { ta.value = t; }, focus: () => ta.focus(), measure: () => {} };
    }
    // NB: no Mod-s binding here — the document-level onKey handles Cmd/Ctrl-S (the
    // keydown bubbles up from CM6); binding it here too would double-fire the save.
    // extraExts go FIRST so their keymaps (e.g. completion Enter/Tab) out-rank the
    // base ones — acceptCompletion returns false when no popup is open, falling through.
    const exts = [
      ...extraExts,
      CM.minimalSetup,
      language || [],
      CM.EditorView.lineWrapping,
      CM.indentWithTab ? CM.keymap.of([CM.indentWithTab]) : [],
      CM.EditorView.theme({
        '&': { color: 'var(--au-fg)', backgroundColor: 'transparent', height: '100%', fontSize: '13px' },
        '.cm-content': { fontFamily: 'var(--au-font-mono)', padding: '14px 16px', caretColor: 'var(--au-fg)' },
        '.cm-scroller': { lineHeight: '1.6' },
        '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--au-fg)' },
        '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection': { backgroundColor: 'var(--sw-bg-bright)' },
        '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--au-fg-soft)' },
        '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'transparent' },
      }, { dark: true }),
    ];
    if (onChange) exts.push(CM.EditorView.updateListener.of((u) => { if (u.docChanged) onChange(); }));
    const view = new CM.EditorView({ parent: host, state: CM.EditorState.create({ doc: '', extensions: exts }) });
    return { get: () => view.state.doc.toString(), set: (t) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(t || '') } }), focus: () => view.focus(), measure: () => view.requestMeasure() };
  }

  // ── note editor (CodeMirror 6; edit / split / preview toggle) ──
  _seEnsureEditor() {
    if (this._seEditor) return this._seEditor;
    const host = document.getElementById('se-edit'); if (!host) return null;
    const sync = () => { clearTimeout(this._sePvTimer); this._sePvTimer = setTimeout(() => this._seSyncPreview(), 150); };
    const CM = window.CM6;
    const extra = [];
    if (CM && CM.autocompletion) {   // [[ autocomplete: pick a holding by title → inserts [[uid|Title]]
      extra.push(CM.autocompletion({ override: [(ctx) => this._wikiCompletions(ctx)], activateOnTyping: true, icons: false }));
      if (CM.acceptCompletion && CM.keymap) extra.push(CM.keymap.of([{ key: 'Enter', run: CM.acceptCompletion }, { key: 'Tab', run: CM.acceptCompletion }]));
    }
    this._seEditor = this._mountCm(host, (CM && CM.markdown) ? CM.markdown() : null, sync, extra);
    return this._seEditor;
  }
  // CM6 completion source: when the cursor is just after "[[…", suggest holdings by
  // title (stacks first), applying "<uid>|<title>]]" → a resolvable [[ref|label]] link.
  _wikiCompletions(context) {
    const before = context.matchBefore(/\[\[[^\]\n]*/);
    if (!before || before.from === before.to) return null;
    const query = before.text.slice(2).toLowerCase();
    const stacksFirst = [], rest = [];
    for (const it of this.store.items.values()) {
      if (it.missing) continue;
      const title = it.title || it.path || it.id;
      if (query && !title.toLowerCase().includes(query)) continue;
      const ref = it.uid || it.glass_id || it.id;
      const clean = String(title).replace(/[[\]|\n]/g, ' ').trim() || ref;
      (it.feed_id === 'stacks' ? stacksFirst : rest).push({
        label: title.length > 60 ? title.slice(0, 60) + '…' : title,
        detail: it.feed_id === 'stacks' ? it.path : (this.store.getFeed(it.feed_id)?.name || it.feed_id),
        apply: `${ref}|${clean}]]`,
      });
      if (stacksFirst.length + rest.length >= 80) break;
    }
    const options = stacksFirst.concat(rest).slice(0, 60);
    if (!options.length) return null;
    return { from: before.from + 2, options, filter: false };
  }
  _seGetValue() { return this._seEditor ? this._seEditor.get() : ''; }
  _seSetValue(text) { const ed = this._seEnsureEditor(); if (ed) ed.set(text); }

  async openNoteEditor(id) {
    const ov = document.getElementById('stacks-editor-overlay'); if (!ov || !this.stacks) return;
    this._seEditing = id || null;
    const titleEl = document.getElementById('se-title'), pathEl = document.getElementById('se-path');
    const tagsEl = document.getElementById('se-tags'), statusEl = document.getElementById('se-status');
    if (statusEl) statusEl.textContent = '';
    let body = '';
    if (id) {
      const it = this.store.getItem(id);
      titleEl.value = it.title || ''; pathEl.textContent = it.path || ''; tagsEl.value = (it.tags || []).join(', ');
      body = it.type === 'note' ? await this.stacks.readNote(it) : '';
    } else { titleEl.value = ''; pathEl.textContent = 'inbox/ · new note'; tagsEl.value = ''; }
    ov.hidden = false;   // show BEFORE mounting CM6 so it measures a laid-out container
    this._seEnsureEditor();
    this._seSetValue(body);
    this._seSetMode(this._seMode || 'split');
    this._seSyncPreview();
    const ed = this._seEditor; if (id && ed) ed.focus(); else titleEl.focus();
  }
  _seSetMode(mode) {
    this._seMode = mode;
    const body = document.getElementById('se-body'); if (body) body.className = `se-body mode-${mode}`;
    document.querySelectorAll('.se-mode').forEach((b) => b.classList.toggle('active', b.dataset.semode === mode));
    if (mode !== 'edit') this._seSyncPreview();
    if (mode !== 'preview' && this._seEditor) this._seEditor.measure();   // CM6 needs a re-measure after being un-hidden
  }
  _seSyncPreview() {
    const pv = document.getElementById('se-preview');
    if (pv) pv.innerHTML = renderMarkdown(this._seGetValue()) || '<p class="se-empty">nothing to preview</p>';
  }
  async saveNoteEditor() {
    if (!this.stacks) return;
    const titleEl = document.getElementById('se-title'), tagsEl = document.getElementById('se-tags'), statusEl = document.getElementById('se-status');
    const md = this._seGetValue(); const title = titleEl.value.trim() || undefined;
    const tags = tagsEl.value.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean);
    try {
      let rec;
      if (this._seEditing) { const it = this.store.getItem(this._seEditing); rec = await this.stacks.saveNote(it, md, { title, tags }); }
      else { rec = await this.stacks.writeNote({ title, markdown: md, tags }); }   // folder via stacks rules → inbox
      await this.store.flush();
      this._seEditing = rec.id; this._content.delete(rec.id);
      document.getElementById('se-path').textContent = rec.path;
      if (statusEl) statusEl.textContent = 'saved ✓';
      this.renderStacks(); if (this.stackFilter) this.renderStream();
    } catch (e) { if (statusEl) statusEl.textContent = `save failed: ${e.message || e}`; }
  }
  closeNoteEditor() { const ov = document.getElementById('stacks-editor-overlay'); if (ov) ov.hidden = true; this._seEditing = null; }

  async downloadStacksFile(id) {
    const it = this.store.getItem(id); if (!it || !this.stacks) return;
    const bytes = await this.stacks.readBytes(it); if (!bytes) return;
    const blob = new Blob([bytes], { type: it.mime || 'application/octet-stream' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a'); a.href = url; a.download = this.stacks._basename(it.path); a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  // ── wiki-links ([[uid]]) + backlinks ──
  // Resolve a [[ref]] to an item: a full item id, or any item whose uid/glass_id matches.
  _resolveRef(ref) {
    const r = String(ref || '').trim(); if (!r) return null;
    const direct = this.store.getItem(r); if (direct) return direct;
    for (const it of this.store.items.values()) if (it.uid === r || it.glass_id === r) return it;
    return null;
  }
  // Items whose body links to `item` (via its uid / glass_id / id) — O(items), no body reads.
  backlinksFor(item) {
    if (!item) return [];
    const refs = new Set([item.uid, item.glass_id, item.id].filter(Boolean));
    const out = [];
    for (const it of this.store.items.values()) {
      if (it.id === item.id || !it.links || !it.links.length) continue;
      if (it.links.some((l) => refs.has(String(l).trim()))) out.push(it);
    }
    return out.sort((a, b) => (a.title || '').localeCompare(b.title || ''));
  }
  // Rewrite renderMarkdown's placeholder wikilink anchors with the resolved target
  // (title + click target), or mark them broken. Done at display (titles can change).
  _resolveWikilinks(html) {
    return String(html).replace(/<a class="wikilink" data-uid="([^"]*)">([\s\S]*?)<\/a>/g, (m, ref, label) => {
      const it = this._resolveRef(ref);
      if (!it) return `<a class="wikilink broken" title="unresolved link: ${escapeHtml(ref)}">${label}</a>`;
      const explicit = label && label !== escapeHtml(ref) && label !== ref;   // [[ref|label]] keeps its label
      const text = explicit ? label : escapeHtml(it.title || ref);
      return `<a class="wikilink" data-target="${escapeHtml(it.id)}" title="${escapeHtml(it.title || '')}">${text}</a>`;
    });
  }
  _backlinksHtml(item) {
    const sources = this.backlinksFor(item);
    if (!sources.length) return '';
    const rows = sources.slice(0, 50).map((s) => `<a class="backlink" data-target="${escapeHtml(s.id)}" title="${escapeHtml(s.path || s.feed_id || '')}">${escapeHtml(s.title || s.path || s.id)}</a>`).join('');
    return `<div class="backlinks"><span class="bl-head">← linked from (${sources.length})</span>${rows}</div>`;
  }
  // Open a linked item: a stacks entry opens in the tree; a feed item jumps to its feed.
  _openRef(id) {
    const it = this.store.getItem(id); if (!it) return;
    if (it.feed_id === 'stacks') { this.selectStackEntry(it.id); return; }
    this.selectFeed(it.feed_id); this.select(it.id); this.expandedId = it.id; this.renderStream();
  }

  _stacksExpandedHtml(it) {
    let inner = '';
    if (it.type === 'note') {
      const cached = this._content.get(it.id);
      if (cached === undefined) {
        this.store.getContent(it.id).then((raw) => {
          const bodyMd = String(raw || '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
          this._content.set(it.id, renderMarkdown(bodyMd)); if (this.expandedId === it.id) this.renderStream();
        });
        inner += '<div class="icontent loading">loading…</div>';
      } else inner += `<div class="icontent">${this._resolveWikilinks(cached) || '<p>(empty note)</p>'}</div>`;
      inner += '<div class="ifooter"><button data-act="editnote">✎ edit</button>';
      inner += `<button data-act="save">${it.saved ? 'unsave' : 'save'}</button></div>`;
    } else {
      let imgHtml = '';
      if ((it.mime || '').startsWith('image/')) {
        const ck = `img:${it.id}`; const c = this._content.get(ck);
        if (c === undefined) {
          this._content.set(ck, '');
          this.stacks.readBytes(it).then((b) => { if (!b) return; const url = URL.createObjectURL(new Blob([b], { type: it.mime })); this._content.set(ck, `<img src="${url}" alt="">`); if (this.expandedId === it.id) this.renderStream(); });
        }
        imgHtml = this._content.get(ck) || '';
      }
      const name = this.stacks ? this.stacks._basename(it.path) : it.path;
      inner += `<div class="icontent"><p>📄 ${escapeHtml(name)} · ${escapeHtml(it.mime || 'file')}</p>${imgHtml}</div>`;
      inner += '<div class="ifooter"><button data-act="dlfile">⬇ download</button>';
      if (it.url) inner += '<button data-act="open">open original ↗</button>';
      inner += `<button data-act="save">${it.saved ? 'unsave' : 'save'}</button></div>`;
    }
    if (it.missing) inner += '<div class="ifooter"><span class="hint" style="color:var(--au-warn)">file missing on disk — “forget” in the rail to clear</span></div>';
    inner += this._backlinksHtml(it);
    return inner;
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
      if (v.query && v.query.catalog) {                  // saved facet drill-down (catalog query)
        const act = this.catalog && this.smartView == null && this._sameFacetView(v) ? ' active' : '';
        rows.push(`<div class="navrow view${act}" data-view-id="${escapeHtml(v.id)}" title="${escapeHtml(this.viewSummary(v))}">`
          + `<span class="lbl"><span class="ico">◈</span> ${escapeHtml(v.name)}</span><span class="count"></span></div>`);
        continue;
      }
      const items = this.store.query(v.query);
      if (v.builtin && items.length === 0) continue;     // empty type default → hide
      const unread = items.reduce((n, i) => n + (i.read ? 0 : 1), 0);
      const ico = v.id === 'v-links' ? '⧉' : v.id === 'v-books' ? '▤' : (ICONS[v.query.type] || (v.query.text ? ICONS.search : '◆'));
      const active = this.smartView?.id === v.id ? ' active' : '';
      rows.push(`<div class="navrow view${active}" data-view-id="${escapeHtml(v.id)}" title="${escapeHtml(this.viewSummary(v))}">`
        + `<span class="lbl"><span class="ico">${ico}</span> ${escapeHtml(v.name)}</span><span class="count">${unread || items.length || ''}</span></div>`);
    }
    el.innerHTML = rows.join('');
  }

  viewSummary(v) {
    const q = v.query || {};
    if (q.catalog) {
      const p = [];
      for (const [fc, arr] of Object.entries(q.catalog.filters || {})) p.push(`${fc}: ${(arr || []).join('/')}`);
      for (const [fc, arr] of Object.entries(q.catalog.excludes || {})) p.push(`−${fc}: ${(arr || []).join('/')}`);
      return p.join(' · ') || 'facet view';
    }
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

  // Saved-link resolver tally in the status bar (flight-deck principle: never
  // wonder what the overnight drip did). Compact line + a hover tooltip with the
  // failure-reason breakdown + recent parked links; click opens Saved Links.
  renderResolverStatus(st) {
    const el = document.getElementById('resolver-status'); if (!el) return;
    const lg = st && st.log;
    const pending = (st && st.pending) || 0;
    if (!lg || (!lg.resolved && !lg.parked && !pending)) { el.textContent = ''; return; }
    el.textContent = `⧉ ${lg.resolved}✓${lg.parked ? ` ${lg.parked}⊘` : ''}${pending ? ` · ${pending}…` : ''}`;
    const reasons = Object.entries(lg.reasons || {}).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}: ${v}`).join(', ');
    const recent = (lg.recent || []).slice(0, 5).map((r) => `  ${r.host} (${r.reason})`).join('\n');
    el.title = `Saved-link resolver — click to open Saved Links\nresolved ${lg.resolved} · parked ${lg.parked} · ${pending} pending`
      + (reasons ? `\nfailure reasons — ${reasons}` : '')
      + (recent ? `\nrecent parked:\n${recent}` : '');
  }

  renderNotify() {
    const el = document.getElementById('notify-status'); if (!el) return;
    const n = this.store.notifications.length;
    el.textContent = n ? `🔔 ${n}` : '';
  }

  // ── feed archaeology (Wayback recovery) ──
  async recoverHistory(feedId) {
    const feed = this.store.getFeed(feedId);
    if (!feed) return { error: 'no such feed' };
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
      return { inserted: up.inserted, updated: up.updated, fetched: r.fetched, total: r.total, failed: r.failed };
    } catch (e) {
      setPoll(`recovery failed: ${e.message}`);
      return { error: e.message };
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ── settings ──
  // WebMCP (Claude Code bridge) connection state → status bar + settings.
  renderWebmcpStatus(state) {
    const s = state || (this.webmcp ? this.webmcp.state() : 'unavailable');
    const bar = document.getElementById('webmcp-status');
    if (bar) { bar.textContent = s === 'connected' ? 'mcp' : s === 'connecting' ? 'mcp…' : s === 'error' ? 'mcp err' : ''; bar.dataset.state = s; }
    const lab = document.getElementById('set-webmcp-state');
    if (lab) lab.textContent = (this.webmcp && this.webmcp.available) ? s : 'unavailable (shim not loaded)';
    const btn = document.getElementById('set-webmcp-toggle');
    if (btn) btn.textContent = (s === 'connected' || s === 'connecting') ? 'disconnect' : 'connect';
  }

  toggleWebmcp() {
    if (!this.webmcp || !this.webmcp.available) { this.renderWebmcpStatus('unavailable'); return; }
    const st = this.webmcp.state();
    if (st === 'connected' || st === 'connecting') { this.webmcp.disconnect(); this.renderWebmcpStatus(); return; }
    const input = document.getElementById('set-webmcp-conn');
    try { this.webmcp.connect((input && input.value) || ''); }
    catch (e) { const lab = document.getElementById('set-webmcp-state'); if (lab) lab.textContent = e.message; }
  }

  async openSettings() {
    const s = this.store.getSettings();
    const val = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
    const chk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
    val('set-poll-interval', s.default_poll_interval_minutes);
    chk('set-adaptive', s.adaptive_polling);
    val('set-poll-concurrency', s.poll_concurrency);
    chk('set-pause-hidden', s.pause_polling_when_hidden);
    chk('set-poll-flightdeck', s.poll_in_flightdeck !== false);
    chk('set-images', s.images_default_allowed);
    chk('set-fullcontent', s.fetch_full_content_default);
    val('set-density', s.density || 'comfortable');
    val('set-cat-provider', s.catalog_provider || 'ollama');
    this._renderCatModelSelect([], s.catalog_model || '');
    val('set-cat-baseurl', s.catalog_base_url || '');
    val('set-cat-pace', s.catalog_pace_ms ?? 400);
    val('set-cat-maxbody', s.catalog_max_body_chars ?? 6000);
    val('set-cat-mailto', s.catalog_mailto || '');
    { const k = document.getElementById('set-cat-key'); if (k) { k.value = ''; hasKey(s.catalog_provider || 'ollama').then((h) => { k.placeholder = h ? 'set ✓ (leave blank to keep)' : '(none)'; }); } }
    this.renderCatUsage();
    { const c = document.getElementById('set-webmcp-conn'); if (c && this.webmcp) c.value = this.webmcp.stored() || ''; }
    this.renderWebmcpStatus();
    chk('set-retention', s.retention_enabled);
    chk('set-tg-enabled', s.telegram_enabled);
    val('set-tg-allowed', s.telegram_allowed_id || '');
    { const k = document.getElementById('set-tg-token'); if (k) { k.value = ''; hasKey('telegram').then((h) => { k.placeholder = h ? 'set ✓ (leave blank to keep)' : '(none)'; }); } }
    if (this.telegram) this.renderTelegramStatus(this.telegram.status);
    chk('set-mcp-feed-removal', s.mcp_allow_feed_removal);
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
    this.renderStorageMount();
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

  async exportBackup() {
    const msg = document.getElementById('settings-msg');
    if (msg) msg.textContent = 'building backup…';
    try {
      const data = await this.store.exportAll();
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `weir-backup-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      if (msg) msg.textContent = `backup: ${data.meta.files} files ✓`;
    } catch (e) { if (msg) msg.textContent = `backup failed: ${e.message}`; }
  }

  async restoreBackup(text) {
    const msg = document.getElementById('settings-msg');
    let data; try { data = JSON.parse(text); } catch { if (msg) msg.textContent = 'not valid JSON'; return; }
    if (!data || !data.files || data.meta?.app !== 'weir') { if (msg) msg.textContent = 'not a weir backup'; return; }
    const n = Object.keys(data.files).length;
    if (!confirm(`Restore ${n} files from this backup? This REPLACES weir's current data and reloads.`)) return;
    try { await this.store.importAll(data); location.reload(); }
    catch (e) { if (msg) msg.textContent = `restore failed: ${e.message}`; }
  }

  // ── filesystem mount (run the store on a real folder; durability) ──
  // On-demand per-area storage breakdown (walks the tree; run it manually so it
  // doesn't compete with a catalog run). Biggest areas first.
  async computeBreakdown() {
    const el = document.getElementById('set-breakdown'); if (!el) return;
    el.textContent = 'computing…';
    try {
      const r = await this.store.storageBreakdown();
      const parts = Object.entries(r.areas).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${escapeHtml(k)} ${fmtBytes(v)}`);
      el.innerHTML = `<b>${fmtBytes(r.total)}</b> — ${parts.join(' · ') || 'empty'}`;
    } catch (e) { el.textContent = `failed: ${e.message}`; }
  }

  renderStorageMount() {
    const loc = document.getElementById('set-storage-loc');
    const acts = document.getElementById('set-storage-actions');
    if (!loc || !acts) return;
    const m = this.fsMount || { type: 'idb' };
    const fsaOk = typeof window !== 'undefined' && !!window.showDirectoryPicker;
    if (m.type === 'fsaa') {
      loc.textContent = 'folder (filesystem) ✓';
      acts.innerHTML = '<button class="btn-link" data-mount="unmount">use browser instead…</button>';
    } else if (m.pending) {
      loc.textContent = 'folder — needs reconnect';
      acts.innerHTML = '<button class="btn-link" data-mount="reconnect">reconnect…</button> &nbsp; <button class="btn-link" data-mount="forget">forget</button>';
    } else {
      loc.textContent = 'browser (IndexedDB)';
      acts.innerHTML = fsaOk ? '<button class="btn-link" data-mount="mount">mount to a folder…</button>' : '<span class="hint">needs Edge/Chrome</span>';
    }
  }

  onMountAction(e) {
    const b = e.target.closest('[data-mount]'); if (!b) return;
    const a = b.dataset.mount;
    if (a === 'mount') this.mountToFolder();
    else if (a === 'reconnect') this.reconnectFolder();
    else if (a === 'unmount') this.unmountFolder();
    else if (a === 'forget') this.forgetFolder();
  }

  async mountToFolder() {
    const msg = document.getElementById('settings-msg');
    let handle;
    try { handle = await pickDirectory(); }
    catch (e) { if (e && e.name === 'AbortError') return; if (msg) msg.textContent = e.message; return; }
    try {
      const adopt = await folderHasStore(handle);
      if (adopt) {
        if (!confirm(`“${handleName(handle)}” already contains a weir store. Run weir from it? Your current browser data stays as a separate IndexedDB copy.`)) { if (msg) msg.textContent = ''; return; }
      } else {
        if (!confirm(`Copy weir's data into “${handleName(handle)}” and run from there? Your IndexedDB copy is kept as a fallback.`)) { if (msg) msg.textContent = ''; return; }
        if (msg) msg.textContent = 'copying to folder…';
        const target = await Store.open({ backend: { type: 'fsaa', handle } });
        await target.importAll(await this.store.exportAll());
      }
      await saveHandle(handle);
      location.reload();
    } catch (e) { if (msg) msg.textContent = `mount failed: ${e.message}`; }
  }

  async reconnectFolder() {
    const h = this.fsMount && this.fsMount.pending; if (!h) return;
    if ((await handlePermission(h, true)) === 'granted') location.reload();
    else { const msg = document.getElementById('settings-msg'); if (msg) msg.textContent = 'permission not granted'; }
  }

  async unmountFolder() {
    const msg = document.getElementById('settings-msg');
    if (!confirm('Stop running weir from the folder and copy its data back into the browser (IndexedDB)? The folder is left untouched.')) return;
    try {
      if (msg) msg.textContent = 'copying back to browser…';
      const idb = await Store.open({ backend: { type: 'idb', name: 'weir' } });
      await idb.importAll(await this.store.exportAll());
      await clearHandle();
      location.reload();
    } catch (e) { if (msg) msg.textContent = `unmount failed: ${e.message}`; }
  }

  async forgetFolder() {
    if (!confirm('Forget the mounted folder and keep using the browser copy? The folder is left untouched; any changes made there stay in the folder.')) return;
    await clearHandle();
    location.reload();
  }

  async saveSettings() {
    const cur = this.store.getSettings();
    const num = (id, def) => { const v = parseFloat(document.getElementById(id).value); return Number.isFinite(v) ? v : def; };
    const chk = (id) => document.getElementById(id).checked;
    const patch = {
      default_poll_interval_minutes: Math.max(1, num('set-poll-interval', cur.default_poll_interval_minutes)),
      adaptive_polling: chk('set-adaptive'),
      poll_concurrency: Math.max(1, Math.min(32, num('set-poll-concurrency', cur.poll_concurrency))),
      pause_polling_when_hidden: chk('set-pause-hidden'),
      poll_in_flightdeck: chk('set-poll-flightdeck'),
      images_default_allowed: chk('set-images'),
      fetch_full_content_default: chk('set-fullcontent'),
      density: document.getElementById('set-density')?.value === 'compact' ? 'compact' : 'comfortable',
      catalog_provider: document.getElementById('set-cat-provider')?.value || 'ollama',
      catalog_model: this._catModelValue(),
      catalog_base_url: document.getElementById('set-cat-baseurl')?.value.trim() || '',
      catalog_pace_ms: Math.max(0, parseInt(document.getElementById('set-cat-pace')?.value, 10) || 0),
      catalog_max_body_chars: Math.max(500, parseInt(document.getElementById('set-cat-maxbody')?.value, 10) || 6000),
      catalog_mailto: document.getElementById('set-cat-mailto')?.value.trim() || '',
      retention_enabled: chk('set-retention'),
      telegram_enabled: chk('set-tg-enabled'),
      telegram_allowed_id: parseInt(document.getElementById('set-tg-allowed')?.value, 10) || 0,
      mcp_allow_feed_removal: chk('set-mcp-feed-removal'),
      auto_check_updates: chk('set-autocheck'),
      recovery_drip_interval_ms: Math.max(60000, num('set-drip-interval', 8) * 60000),
      wayback_min_interval_ms: Math.max(1000, num('set-wb-interval', 5) * 1000),
      wayback_max_snapshots: Math.max(1, Math.round(num('set-wb-max', 40))),
      ia_access_key: document.getElementById('set-ia-access').value.trim(),
      ia_secret_key: document.getElementById('set-ia-secret').value.trim(),
    };
    await this.store.setSettings(patch);
    const keyVal = document.getElementById('set-cat-key')?.value;
    if (keyVal) { await saveKey(patch.catalog_provider, keyVal); const k = document.getElementById('set-cat-key'); if (k) k.value = ''; }
    { const tg = document.getElementById('set-tg-token')?.value; if (tg) { await saveKey('telegram', tg); const t = document.getElementById('set-tg-token'); if (t) t.value = ''; } }
    if (this.telegram) {   // (re)start or stop the influxer to match the new setting
      if (patch.telegram_enabled && await getKey('telegram')) { this.telegram.start(); this.runner?.kick('telegram'); } else this.telegram.stop();
    }
    this._setDensity(patch.density);
    setAutoCheck(patch.auto_check_updates);   // push the preference to the SW
    if (patch.retention_enabled) this.store.runRetention();   // apply immediately if just enabled
    document.getElementById('settings-msg').textContent = 'saved ✓';
    setTimeout(() => this.closeSettings(), 700);
  }

  async renderCatUsage() {
    const el = document.getElementById('cat-usage'); if (!el) return;
    const u = await this.store.getUsage();
    const parts = [];
    for (const [prov, p] of Object.entries(u.providers || {})) {
      const tok = prov === 'nanogpt' ? `${Math.round(p.billed_input / 1000)}k input billed` : `${Math.round((p.input_tokens + p.output_tokens) / 1000)}k tokens`;
      parts.push(`${prov}: ${p.calls} call${p.calls === 1 ? '' : 's'} · ${tok}`);
    }
    el.textContent = parts.length ? parts.join('  ·  ') : 'no LLM usage yet';
  }

  // The chosen model id (from the dropdown, or the custom field if "custom").
  _catModelValue() {
    const sel = document.getElementById('set-cat-model');
    if (sel && sel.value === '__custom__') return document.getElementById('set-cat-model-custom')?.value.trim() || '';
    return sel?.value || '';
  }

  // Fill the model dropdown with `models` (+ keep `selected` even if not listed),
  // plus a "custom id" escape. A real <select> shows every option (no datalist
  // filter-by-typed-text confusion).
  _renderCatModelSelect(models, selected) {
    const sel = document.getElementById('set-cat-model'); if (!sel) return;
    const opts = [...new Set([selected, ...models].filter(Boolean))];
    sel.innerHTML = opts.map((m) => `<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join('')
      + '<option value="__custom__">+ custom id…</option>';
    sel.value = selected && opts.includes(selected) ? selected : (models[0] || (opts[0] || '__custom__'));
    this._reflectCatCustom();
  }

  _reflectCatCustom() {
    const sel = document.getElementById('set-cat-model'); const c = document.getElementById('set-cat-model-custom');
    if (sel && c) c.hidden = sel.value !== '__custom__';
  }

  async loadCatModels() {
    const status = document.getElementById('cat-usage');
    const provider = document.getElementById('set-cat-provider')?.value || 'ollama';
    const key = document.getElementById('set-cat-key')?.value || (await getKey(provider));
    const baseUrl = document.getElementById('set-cat-baseurl')?.value.trim() || '';
    if (status) status.textContent = 'fetching models…';
    try {
      const models = await listModels({ provider, key, baseUrl, fetch: this.poller.fetch });
      this._renderCatModelSelect(models, this._catModelValue());
      if (status) status.textContent = `${models.length} model${models.length === 1 ? '' : 's'} — pick one ↑`;
    } catch (e) { if (status) status.textContent = `couldn't list models: ${e.message}`; }
  }

  async checkCatGauge() {
    const el = document.getElementById('cat-usage'); if (!el) return;
    const provider = document.getElementById('set-cat-provider')?.value || 'ollama';
    const key = document.getElementById('set-cat-key')?.value || (await getKey(provider));
    el.textContent = 'checking…';
    const g = await fetchUsageGauge(provider, key, { fetch: this.poller.fetch });
    if (!g) { el.textContent = 'no subscription gauge for this provider'; return; }
    const pct = g.percentUsed != null ? ` (${Math.round((g.percentUsed > 1 ? g.percentUsed : g.percentUsed * 100))}%)` : '';
    const reset = g.resetAt ? ` · resets ${new Date(typeof g.resetAt === 'number' && g.resetAt < 1e12 ? g.resetAt * 1000 : g.resetAt).toLocaleDateString()}` : '';
    el.textContent = `${g.kind}: ${(g.used ?? 0).toLocaleString()} / ${((g.used ?? 0) + (g.remaining ?? 0)).toLocaleString()}${pct}${reset}`;
  }

  async checkUpdates() {
    const el = document.getElementById('update-check-status');
    if (el) el.textContent = 'checking…';
    const { state } = (await checkForUpdateNow()) || {};
    const MSG = {
      unsupported: 'no service worker here — needs https or installing as an app',
      none: 'no service worker registered yet — reload once to register it',
      waiting: 'update ready — reload to apply',
      uncontrolled: 'this tab loaded without the service worker (so you’re already on the latest) — reload to re-attach it for offline + auto-updates',
      checked: 'checked — a reload prompt appears if there’s an update',
    };
    if (el) el.textContent = MSG[state] || 'check failed';
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
  // The rules overlay edits one of two rulesets (shared engine, separate lists —
  // STACKS.md §4): 'feed' (triage feed items) or 'stacks' (file notes into folders).
  _rulesEnsureEditor() {
    if (this._rulesEditor) return this._rulesEditor;
    const host = document.getElementById('rules-text'); if (!host) return null;
    this._rulesEditor = this._mountCm(host, (window.CM6 && window.CM6.javascript) ? window.CM6.javascript() : null, null);   // JS highlighting for the rule predicates
    return this._rulesEditor;
  }
  async openRules(target = 'feed') { this._rulesEnsureEditor(); this.rulesTarget = null; await this._loadRulesTab(target); document.getElementById('rules-overlay').hidden = false; this._rulesEditor?.measure(); this._rulesEditor?.focus(); }
  async _loadRulesTab(target) {
    if (this.rulesTarget === target) return;
    this.rulesTarget = target;
    const stacks = target === 'stacks';
    const cur = stacks ? await this.store.getStacksRouting() : await this.store.getRouting();
    this._rulesEnsureEditor()?.set(cur && cur.trim() ? cur : (stacks ? DEFAULT_STACKS_ROUTING : DEFAULT_ROUTING));
    const err = stacks ? this.router?.stacksError : this.router?.error;
    document.getElementById('rules-error').textContent = err ? `error: ${err}` : '';
    document.querySelectorAll('[data-rulestab]').forEach((b) => b.classList.toggle('active', b.dataset.rulestab === target));
    const rerun = document.getElementById('rules-rerun'); if (rerun) rerun.textContent = stacks ? 'Re-file inbox' : 'Re-run over history';
  }
  closeRules() { document.getElementById('rules-overlay').hidden = true; }
  async saveRules() {
    const text = this._rulesEditor ? this._rulesEditor.get() : '';
    const stacks = this.rulesTarget === 'stacks';
    if (stacks) { await this.store.setStacksRouting(text); const err = this.router.loadStacks(text); document.getElementById('rules-error').textContent = err ? `error: ${err}` : 'saved ✓ (files new drops)'; if (!err) setTimeout(() => this.closeRules(), 700); return; }
    await this.store.setRouting(text);
    const err = this.router.load(text);
    document.getElementById('rules-error').textContent = err ? `error: ${err}` : 'saved ✓ (applies to new items)';
    if (!err) setTimeout(() => this.closeRules(), 700);
  }
  async uiRerunRules() {
    if (this.rulesTarget === 'stacks') {
      const r = this.stacks ? await this.stacks.refileInbox() : { moved: 0 };
      await this.store.flush(); this.renderStacks(); if (this.stackFilter) this.renderStream();
      document.getElementById('rules-error').textContent = `re-filed inbox — ${r.moved} entr${r.moved === 1 ? 'y' : 'ies'} moved`;
      return;
    }
    const r = this.store.rerunRules();
    document.getElementById('rules-error').textContent = `re-ran over history — ${r.matched} item${r.matched === 1 ? '' : 's'} matched`;
    this.renderAll();
  }

  // Probe the bridge; update the status-bar label and decide the banner. The
  // banner shows only when fetches are actually failing (_fetchFails) AND the
  // bridge isn't detected — so it never false-alarms a CORS-friendly setup.
  async checkBridge() {
    let detected = false, version = null;
    try { detected = !!(await hasBridge()); if (detected) version = await bridgeVersion(); } catch { detected = false; }
    const el = document.getElementById('bridge-status');
    if (el) el.textContent = detected ? `bridge: ${version ? 'v' + version : 'connected'}` : 'bridge: not detected';
    this._setBridgeBanner(!detected && (this._fetchFails || 0) >= 1);
    return detected;
  }

  _setBridgeBanner(show) {
    if (show && this._bridgeDismissed) return;
    document.getElementById('bridge-toast')?.classList.toggle('on', !!show);
  }

  renderPollStatus() {
    const el = document.getElementById('poll-status'); if (!el) return;
    const last = this.poller.lastPollAt ? `last ${relativeTime(this.poller.lastPollAt)}` : 'idle';
    const nextAt = this.poller.nextPollAt();
    const next = nextAt ? ` · next ${nextAt <= Date.now() ? 'due' : 'in ' + relativeTime(2 * Date.now() - nextAt)}` : '';
    const st = this.poller.stats?.();
    const cache = st && st.fetches >= 5 ? ` · ${Math.round(st.ratio * 100)}% unchanged` : '';
    el.textContent = last + next + cache;
  }
}
