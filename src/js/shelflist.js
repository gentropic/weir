// Shelf list — build a self-contained, mobile-first HTML of the BOOKS holdings in
// glass call-number (shelf) order, grouped by class·division. Pure + environment-
// agnostic: given the book items + a card resolver, it returns the HTML string. Used
// by BOTH the in-app export (live store) and tools/shelf-list.mjs (the on-disk
// snapshot). Helpers live inside the function so nothing leaks a top-level name into
// the flat-concat bundle.
import { callNumber, renderCoded, sortKey, CLASS_NAMES } from './callnumber.js';

// books: array of book items (each may carry `structured.series`/`.seq`).
// cardFor: (item) => glass card | null  (resolves the item's catalog card).
// opts.stamp: a snapshot label (defaults to now).
export function buildShelfHtml(books, cardFor, opts = {}) {
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const titleCase = (s) => s.replace(/\b\w/g, (c) => c.toUpperCase());
  const stamp = opts.stamp || new Date().toISOString().slice(0, 16).replace('T', ' ');

  const rows = (books || []).map((b) => {
    const s = b.structured || {};
    const card = cardFor(b) || null;
    const cn = card ? callNumber(card, { series: s.series, seq: s.seq }) : null;
    const domainTerm = (cn && cn.terms && cn.terms.domain) ? cn.terms.domain : null;
    return {
      id: b.id,
      shelved: !!(b.structured && b.structured.shelved),   // physical-shelf status, from the catalog (the source of truth)
      title: b.title || '(untitled)',
      author: b.author || (card && (card.dublin_core.creator || [])[0]) || '',
      series: s.series || null,
      seq: (s.seq != null && s.seq !== '') ? s.seq : null,
      cataloged: !!card,
      coded: cn ? renderCoded(cn) : null,
      sk: cn ? sortKey(cn) : '~~~',
      cls: cn ? cn.cls : null,
      className: cn ? (CLASS_NAMES[cn.cls] || 'General & reference') : null,
      domain: domainTerm ? titleCase(domainTerm) : 'Unclassified',
    };
  });

  // Shelf order: cataloged by call number (class → division → domain → form → author →
  // series → volume); uncataloged sink to the end, by title.
  const cataloged = rows.filter((r) => r.cataloged).sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : a.title.localeCompare(b.title)));
  const uncataloged = rows.filter((r) => !r.cataloged).sort((a, b) => a.title.localeCompare(b.title));

  // Each row is a <label> wrapping a checkbox so tapping anywhere on it toggles
  // "shelved" (handy while walking the shelf); state persists in localStorage by the
  // book's stable item id.
  const row = (r, coded, extra = '') =>
    `<label class="bk${r.shelved ? ' done' : ''}" data-id="${esc(r.id)}"><input type="checkbox" class="shelved"${r.shelved ? ' checked' : ''}><code class="cn${coded ? '' : ' cn-none'}">${esc(coded || '—')}</code><div class="meta"><span class="ti">${esc(r.title)}</span>${extra}${r.author ? `<span class="au">${esc(r.author)}</span>` : ''}</div></label>`;
  let body = '', lastCls = null;
  for (const r of cataloged) {
    if (r.cls !== lastCls) { body += `<h2><span class="ci">${esc(r.cls)}</span>${esc(r.className)}</h2>`; lastCls = r.cls; }
    const vol = r.seq != null ? `<span class="vol">${esc(r.series || 'vol')} ${esc(r.seq)}</span>` : '';
    body += row(r, r.coded, `${vol}<span class="dom">${esc(r.domain)}</span>`);
  }
  if (uncataloged.length) {
    body += `<h2 class="todo">Not yet cataloged · ${uncataloged.length}</h2>`;
    for (const r of uncataloged) body += row(r, null);
  }

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>weir — shelf list</title>
<style>
:root { color-scheme: light dark; --bg:#15171a; --fg:#e7e3da; --dim:#9a958a; --line:#2c2f34; --acc:#d9a441; --cn:#7fb3d5; }
* { box-sizing: border-box; }
body { margin:0; padding:16px 14px 64px; background:var(--bg); color:var(--fg);
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; line-height:1.35; -webkit-text-size-adjust:100%; }
header { position:sticky; top:0; background:var(--bg); padding-bottom:10px; margin-bottom:6px; border-bottom:1px solid var(--line); z-index:2; }
h1 { font-size:1.15rem; margin:0 0 2px; letter-spacing:.02em; }
.sub { color:var(--dim); font-size:.78rem; }
#q { width:100%; margin-top:10px; padding:9px 11px; font-size:1rem; border:1px solid var(--line);
  border-radius:9px; background:#1d2024; color:var(--fg); }
h2 { font-size:.74rem; text-transform:uppercase; letter-spacing:.14em; color:var(--acc);
  margin:22px 0 7px; padding-bottom:3px; border-bottom:1px dashed var(--line); }
h2.todo { color:var(--dim); }
.ci { display:inline-block; min-width:2.2em; margin-right:9px; padding:0 5px; color:var(--bg); background:var(--acc);
  border-radius:5px; text-align:center; font-weight:700; font-variant-numeric:tabular-nums; }
.dom { font-size:.62rem; color:var(--dim); text-transform:uppercase; letter-spacing:.07em; }
.bk { display:flex; gap:10px; align-items:baseline; padding:8px 2px; border-bottom:1px solid #1f2226; cursor:pointer; }
.shelved { flex:0 0 auto; width:18px; height:18px; accent-color:var(--acc); align-self:flex-start; margin-top:2px; }
.bk.done { opacity:.42; }
.bk.done .ti { text-decoration:line-through; }
#prog { color:var(--acc); }
.bar { display:flex; gap:8px; margin-top:9px; }
.bar button, .bar .btn { font:inherit; font-size:.78rem; padding:6px 11px; border:1px solid var(--line); border-radius:8px;
  background:#1d2024; color:var(--fg); cursor:pointer; }
.cn { font-family:"SF Mono", ui-monospace, Menlo, Consolas, monospace; font-size:.72rem; color:var(--cn);
  white-space:nowrap; flex:0 0 auto; min-width:9.5em; }
.cn-none { color:var(--dim); }
.meta { display:flex; flex-wrap:wrap; gap:3px 9px; align-items:baseline; }
.ti { font-weight:600; }
.au { color:var(--dim); font-size:.86rem; }
.vol { font-size:.66rem; background:#2a2620; color:var(--acc); border:1px solid #3a342a;
  padding:1px 6px; border-radius:20px; white-space:nowrap; }
.empty { color:var(--dim); padding:20px 0; }
@media (min-width:640px){ .cn { min-width:11em; } body { max-width:760px; margin:0 auto; } }
</style></head><body>
<header>
  <h1>weir — shelf list</h1>
  <div class="sub">${cataloged.length} cataloged · ${uncataloged.length} uncataloged · ${rows.length} books · <span id="prog">0 shelved</span> · snapshot ${esc(stamp)}</div>
  <input id="q" type="search" placeholder="filter title / author / call number…" autocomplete="off">
  <div class="bar"><button id="exp" type="button">⤓ export shelved (JSON)</button><label class="btn" for="imp">⤒ import<input id="imp" type="file" accept="application/json,.json" hidden></label></div>
</header>
<main id="list">
${body || '<p class="empty">No books found.</p>'}
</main>
<script>
const q = document.getElementById('q'), bks = [...document.querySelectorAll('.bk')], hds = [...document.querySelectorAll('h2')];
// "shelved" checkboxes. BASELINE = what the catalog already marks shelved (the rows are
// server-rendered checked from each book meta, the source of truth). Working layer =
// localStorage (first load seeds from the catalog; after that, local ticks win). Export/
// Import move the set as JSON, to sync ticks back into weir or carry them between devices.
const KEY = 'weir-shelf-shelved', prog = document.getElementById('prog');
const seeded = new Set(bks.filter((b) => b.querySelector('.shelved').checked).map((b) => b.dataset.id));
let done; try { const ls = localStorage.getItem(KEY); done = ls ? new Set(JSON.parse(ls)) : new Set(seeded); } catch { done = new Set(seeded); }
const save = () => { try { localStorage.setItem(KEY, JSON.stringify([...done])); } catch {} };
const upd = () => { if (prog) prog.textContent = done.size + ' shelved'; };
const apply = () => { for (const b of bks) { const on = done.has(b.dataset.id); b.querySelector('.shelved').checked = on; b.classList.toggle('done', on); } upd(); };
for (const b of bks) {
  const id = b.dataset.id, cb = b.querySelector('.shelved');
  cb.addEventListener('change', () => { cb.checked ? (done.add(id), b.classList.add('done')) : (done.delete(id), b.classList.remove('done')); save(); upd(); });
}
apply();
const dl = (name, text) => { const u = URL.createObjectURL(new Blob([text], { type: 'application/json' })); const a = document.createElement('a'); a.href = u; a.download = name; a.click(); URL.revokeObjectURL(u); };
document.getElementById('exp').addEventListener('click', () => dl('weir-shelved.json', JSON.stringify({ shelved: [...done] })));
document.getElementById('imp').addEventListener('change', (e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => { try { const j = JSON.parse(r.result); done = new Set(Array.isArray(j) ? j : (j.shelved || [])); save(); apply(); } catch {} }; r.readAsText(f); });
q.addEventListener('input', () => {
  const n = q.value.trim().toLowerCase();
  for (const b of bks) b.style.display = (!n || b.textContent.toLowerCase().includes(n)) ? '' : 'none';
  for (const h of hds) { let s = h.nextElementSibling, any = false;
    while (s && s.tagName !== 'H2') { if (s.classList.contains('bk') && s.style.display !== 'none') any = true; s = s.nextElementSibling; }
    h.style.display = any ? '' : 'none'; }
});
<\/script>
</body></html>`;
}
