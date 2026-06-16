// Shelf list — a portable, single-file HTML of the BOOKS holdings in glass call-
// number (shelf) order, built straight from the live store on disk (read-only) and
// run through the real callnumber.js, so the addresses match the app exactly. Use it
// as a walk-the-shelf checklist: anything in hand that ISN'T on the sheet is a gap to
// scan. Run: node tools/shelf-list.mjs [storeDir] [outFile]
//   storeDir defaults to C:\Users\endar\Documents\weir (the FSA-mounted live store)
//   outFile  defaults to <storeDir>\..\weir-shelf.html
import fs from 'node:fs';
import path from 'node:path';
import { callNumber, renderCoded, renderReadable, sortKey } from '../src/js/callnumber.js';

const STORE = process.argv[2] || 'C:/Users/endar/Documents/weir';
const OUT = process.argv[3] || path.join(STORE, '..', 'weir-shelf.html');

const readNdjson = (file) => fs.readFileSync(file, 'utf8').split('\n')
  .map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Books shard(s): items/books.*.ndjson
const itemsDir = path.join(STORE, 'items');
const bookFiles = fs.readdirSync(itemsDir).filter((f) => /^books\./.test(f) && f.endsWith('.ndjson'));
const books = bookFiles.flatMap((f) => readNdjson(path.join(itemsDir, f))).filter((it) => it && it.type === 'book' && !it.archived);

// All glass cards → map by glass_id AND by document_ref (a book points to its card via glass_id).
const catDir = path.join(STORE, 'catalog');
const byGlassId = new Map(), byDocRef = new Map();
for (const f of fs.readdirSync(catDir).filter((f) => f.endsWith('.ndjson'))) {
  for (const c of readNdjson(path.join(catDir, f))) {
    const g = c.glass || {};
    if (g.glass_id) byGlassId.set(g.glass_id, c);
    if (g.document_ref) byDocRef.set(g.document_ref, c);
  }
}

// Build a row per book: call number from its card (+ series/seq from the item), or null.
const rows = books.map((b) => {
  const s = b.structured || {};
  const card = (b.glass_id && byGlassId.get(b.glass_id)) || byDocRef.get(b.id) || null;
  const cn = card ? callNumber(card, { series: s.series, seq: s.seq }) : null;
  const domainTerm = (cn && cn.terms && cn.terms.domain) ? cn.terms.domain : null;
  return {
    id: b.id,
    title: b.title || '(untitled)',
    author: b.author || (card && (card.dublin_core.creator || [])[0]) || '',
    series: s.series || null,
    seq: (s.seq != null && s.seq !== '') ? s.seq : null,
    isbn: s.isbn || null,
    cataloged: !!card,
    coded: cn ? renderCoded(cn) : null,
    readable: cn ? renderReadable(cn) : null,
    sk: cn ? sortKey(cn) : '~~~',
    domain: domainTerm ? domainTerm.replace(/\b\w/g, (c) => c.toUpperCase()) : 'Unclassified',
  };
});

// Shelf order: cataloged by call number (which groups by domain → subdomain → form →
// author → series → volume); uncataloged sink to the end, by title.
const cataloged = rows.filter((r) => r.cataloged).sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : a.title.localeCompare(b.title)));
const uncataloged = rows.filter((r) => !r.cataloged).sort((a, b) => a.title.localeCompare(b.title));

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

// Group cataloged rows by domain so the sheet reads like shelf sections.
let body = '', lastDomain = null;
for (const r of cataloged) {
  if (r.domain !== lastDomain) { body += `<h2>${esc(r.domain)}</h2>`; lastDomain = r.domain; }
  const vol = r.seq != null ? `<span class="vol">${esc(r.series || 'vol')} ${esc(r.seq)}</span>` : '';
  body += `<div class="bk"><code class="cn">${esc(r.coded)}</code><div class="meta"><span class="ti">${esc(r.title)}</span>${vol}${r.author ? `<span class="au">${esc(r.author)}</span>` : ''}</div></div>`;
}
if (uncataloged.length) {
  body += `<h2 class="todo">Not yet cataloged · ${uncataloged.length}</h2>`;
  for (const r of uncataloged) {
    body += `<div class="bk"><code class="cn cn-none">—</code><div class="meta"><span class="ti">${esc(r.title)}</span>${r.author ? `<span class="au">${esc(r.author)}</span>` : ''}</div></div>`;
  }
}

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
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
.bk { display:flex; gap:11px; align-items:baseline; padding:7px 2px; border-bottom:1px solid #1f2226; }
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
  <div class="sub">${cataloged.length} cataloged · ${uncataloged.length} uncataloged · ${rows.length} books · snapshot ${stamp}</div>
  <input id="q" type="search" placeholder="filter title / author / call number…" autocomplete="off">
</header>
<main id="list">
${body || '<p class="empty">No books found in the store.</p>'}
</main>
<script>
const q = document.getElementById('q'), bks = [...document.querySelectorAll('.bk')], hds = [...document.querySelectorAll('h2')];
q.addEventListener('input', () => {
  const n = q.value.trim().toLowerCase();
  for (const b of bks) b.style.display = (!n || b.textContent.toLowerCase().includes(n)) ? '' : 'none';
  for (const h of hds) { let s = h.nextElementSibling, any = false;
    while (s && s.tagName !== 'H2') { if (s.classList.contains('bk') && s.style.display !== 'none') any = true; s = s.nextElementSibling; }
    h.style.display = any ? '' : 'none'; }
});
</script>
</body></html>`;

fs.writeFileSync(OUT, html);
console.log(`shelf list → ${OUT}\n  ${rows.length} books (${cataloged.length} cataloged, ${uncataloged.length} not), ${(html.length / 1024).toFixed(0)} KB`);
