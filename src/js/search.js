// search.js — full-text search v2 on @gcu/librarian (vendored CSR engine).
// Replaces the v0.1 cursor-scan with ranked BM25F (title-boosted) + fuzzy + prefix
// over the in-memory corpus. Lean *folded* index (storeText off → snippets come
// from a callback; positions off) so the whole corpus fits in RAM cheaply
// (~folded: 50k excerpts ≈ 19 MB upstream). Rebuilt on a debounce as the corpus
// changes. A pack/unpack-persisted index (faster boot at large N) is a follow-up
// — see ROADMAP "Search v0.2".

import { Librarian } from '../../vendor/librarian.js';

export class SearchIndex {
  constructor(store, opts = {}) {
    this.store = store;
    this.index = null;
    this.ready = false;
    this._rebuildMs = opts.rebuildMs ?? 4000;
    this._timer = null;
  }

  _doc(it) { return { id: it.id, title: it.title || '', body: it.excerpt || '' }; }

  // Snippet source for the lean index (storeText off). Folded mode calls back with
  // fieldName === null, so return the combined text then.
  _snippet(id, field) {
    const it = this.store.getItem(id); if (!it) return '';
    if (field == null) return `${it.title || ''} ${it.excerpt || ''}`.trim();
    return (field === 'title' ? it.title : it.excerpt) || '';
  }

  build() {
    const docs = [];
    for (const it of this.store.items.values()) if (!it.archived) docs.push(this._doc(it));
    this.index = Librarian.index({
      docs,
      fields: { title: { boost: 4 }, body: { boost: 1 } },
      mode: 'folded', storeText: false, positions: false,
      snippet: (id, field) => this._snippet(id, field),
    });
    this.ready = true;
    return this;
  }

  // Debounced full rebuild — call when the corpus changes (poll inserts, archive).
  // (Incremental addDoc/removeDoc + pack persistence are the scale follow-up.)
  scheduleRebuild() {
    if (this._timer) return;
    this._timer = setTimeout(() => { this._timer = null; try { this.build(); } catch (e) { console.error('search rebuild failed', e); } }, this._rebuildMs);
  }

  // Ranked search. opts: { limit, fuzzy, prefix, filter(docId)→bool }. Returns
  // librarian hits [{ id, score, doc, snippet, hits }]. Defaults fuzzy+prefix on.
  search(q, opts = {}) {
    if (!this.index || !q) return [];
    try { return Librarian.search(this.index, q, { fuzzy: true, prefix: true, ...opts }); }
    catch (e) { console.error('search failed', e); return []; }
  }
}
