// Physical-library LABEL artifacts, generated from the live store (read-only).
// Emits two gitignored files into tools/:
//   shelf-labels.txt      — printable list for the Brother P-touch (ALL-CAPS pt-BR, all classes)
//   label-placement.html  — phone guide: each label + the SHELVED books beneath it, in shelf
//                           order, so you know exactly where to slot each section divider.
// Run: node tools/shelf-labels.mjs [storeDir]   (default store = C:\Users\endar\Documents\weir)
// pt-BR class names live in PT below — the single place to tweak wording/casing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { callNumber, renderCoded, sortKey, CLASS_NAMES } from '../src/js/callnumber.js';

const STORE = process.argv[2] || 'C:/Users/endar/Documents/weir';
const HERE = path.dirname(fileURLToPath(import.meta.url));

// Readable case; output uppercases it (accents preserved). Edit here to reword a label.
const PT = {
  '00': 'Geral e Referência', '10': 'Filosofia e Psicologia', '20': 'Ciências Sociais',
  '30': 'Ciências (Geral)', '31': 'Matemática', '32': 'Estatística', '33': 'Ciências Físicas',
  '35': 'Biologia e Natureza', '36': 'Geociências', '38': 'Astronomia e Espaço',
  '40': 'Medicina e Saúde', '50': 'Tecnologia (Geral)', '51': 'Computação e Software',
  '52': 'Dados e IA', '53': 'Eletrônica e Hardware', '54': 'Engenharia', '55': 'Redes e Segurança',
  '60': 'Artes e Design', '70': 'Literatura', '71': 'Línguas e Linguística', '72': 'HQ e Mangá',
  '80': 'História', '90': 'Lazer e Estilo de Vida', '91': 'Culinária', '92': 'Artesanatos e Maker',
  '93': 'Jogos e Hobbies',
};
const NAME = (cls) => (PT[cls] || CLASS_NAMES[cls] || '?').toUpperCase();

const read = (f) => fs.readFileSync(f, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean)
  .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const itemsDir = path.join(STORE, 'items');
const books = fs.readdirSync(itemsDir).filter((f) => /^books\./.test(f) && f.endsWith('.ndjson'))
  .flatMap((f) => read(path.join(itemsDir, f))).filter((it) => it && it.type === 'book' && !it.archived);

const byG = new Map(), byRef = new Map();
for (const f of fs.readdirSync(path.join(STORE, 'catalog')).filter((f) => f.endsWith('.ndjson')))
  for (const c of read(path.join(STORE, 'catalog', f))) { const g = c.glass || {}; if (g.glass_id) byG.set(g.glass_id, c); if (g.document_ref) byRef.set(g.document_ref, c); }
const cardOf = (b) => (b.glass_id && byG.get(b.glass_id)) || byRef.get(b.id) || null;

const rows = books.map((b) => {
  const s = b.structured || {}, c = cardOf(b), cn = c ? callNumber(c, { series: s.series, seq: s.seq }) : null;
  return { cls: cn ? cn.cls : null, coded: cn ? renderCoded(cn) : '—', sk: cn ? sortKey(cn) : '~~~',
    title: b.title || '(untitled)', author: b.author || (c && (c.dublin_core.creator || [])[0]) || '', shelved: !!s.shelved };
});

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');

// ---- shelf-labels.txt — all classes, ALL CAPS, reserves flagged ----
const occ = new Set(rows.filter((r) => r.cls).map((r) => r.cls));
const keys = Object.keys(CLASS_NAMES).sort();
const reserves = keys.filter((k) => !occ.has(k));
const txt =
  'weir — ETIQUETAS DAS SEÇÕES DA ESTANTE (Brother P-touch; uma por suporte, em ordem)\n' +
  'Reservas sem livros ainda (imprima só se for deixar espaço): ' + reserves.join(', ') + '.\n' +
  'Se a P-touch não tiver o · (ponto médio), troque por - ou :.\n\n\n' +
  keys.map((k) => k + ' · ' + NAME(k)).join('\n') + '\n';
fs.writeFileSync(path.join(HERE, 'shelf-labels.txt'), txt);

// ---- label-placement.html — phone guide, SHELVED books under each label ----
const shelved = rows.filter((r) => r.shelved && r.cls).sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : a.title.localeCompare(b.title)));
const perCls = {}; for (const r of shelved) (perCls[r.cls] = perCls[r.cls] || []).push(r);
let body = '';
for (const cls of Object.keys(perCls).sort()) {
  body += '<h2><span class="ci">' + esc(cls) + '</span>' + esc(NAME(cls)) + '<span class="n">' + perCls[cls].length + '</span></h2>';
  for (const r of perCls[cls])
    body += '<div class="bk"><code class="cn">' + esc(r.coded) + '</code><div class="m"><span class="ti">' + esc(r.title) + '</span>' + (r.author ? '<span class="au">' + esc(r.author) + '</span>' : '') + '</div></div>';
}
const html = '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">\n' +
'<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
'<title>weir — onde colocar as etiquetas</title>\n' +
'<style>\n' +
':root{color-scheme:light dark;--bg:#15171a;--fg:#e7e3da;--dim:#9a958a;--line:#2c2f34;--acc:#d9a441;--cn:#7fb3d5}\n' +
'*{box-sizing:border-box}body{margin:0;padding:16px 14px 64px;background:var(--bg);color:var(--fg);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;line-height:1.35;-webkit-text-size-adjust:100%}\n' +
'header{position:sticky;top:0;background:var(--bg);padding-bottom:10px;margin-bottom:4px;border-bottom:1px solid var(--line);z-index:2}\n' +
'h1{font-size:1.1rem;margin:0 0 2px}.sub{color:var(--dim);font-size:.76rem}.hint{color:var(--acc);font-size:.8rem;margin-top:6px}\n' +
'#q{width:100%;margin-top:10px;padding:9px 11px;font-size:1rem;border:1px solid var(--line);border-radius:9px;background:#1d2024;color:var(--fg)}\n' +
'h2{display:flex;align-items:center;gap:9px;font-size:.92rem;letter-spacing:.04em;margin:24px 0 6px;padding:7px 9px;background:#1d2024;border-left:4px solid var(--acc);border-radius:6px}\n' +
'h2 .ci{background:var(--acc);color:var(--bg);font-weight:700;border-radius:5px;padding:0 6px;font-variant-numeric:tabular-nums}\n' +
'h2 .n{margin-left:auto;color:var(--dim);font-size:.74rem;font-weight:400}\n' +
'.bk{display:flex;gap:10px;align-items:baseline;padding:6px 4px;border-bottom:1px solid #1f2226}\n' +
'.cn{font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace;font-size:.68rem;color:var(--cn);white-space:nowrap;flex:0 0 auto;min-width:11em}\n' +
'.m{display:flex;flex-wrap:wrap;gap:2px 9px;align-items:baseline}.ti{font-weight:600}.au{color:var(--dim);font-size:.84rem}\n' +
'.empty{color:var(--dim);padding:20px 0}@media(min-width:640px){body{max-width:760px;margin:0 auto}}\n' +
'</style></head><body>\n' +
'<header><h1>weir — onde colocar as etiquetas</h1>\n' +
'<div class="sub">' + Object.keys(perCls).length + ' seções · ' + shelved.length + ' livros na estante · ' + esc(stamp) + '</div>\n' +
'<div class="hint">Cada etiqueta vai logo ANTES do primeiro livro listado abaixo dela ↓</div>\n' +
'<input id="q" type="search" placeholder="filtrar título / autor / código…" autocomplete="off"></header>\n' +
'<main>\n' + (body || '<p class="empty">Nenhum livro marcado como guardado ainda.</p>') + '\n</main>\n' +
'<script>\n' +
'var q=document.getElementById("q"),bks=[].slice.call(document.querySelectorAll(".bk")),hds=[].slice.call(document.querySelectorAll("h2"));\n' +
'q.addEventListener("input",function(){var n=q.value.trim().toLowerCase();\n' +
' for(var i=0;i<bks.length;i++)bks[i].style.display=(!n||bks[i].textContent.toLowerCase().indexOf(n)>=0)?"":"none";\n' +
' for(var j=0;j<hds.length;j++){var s=hds[j].nextElementSibling,a=false;while(s&&s.tagName!=="H2"){if(s.className.indexOf("bk")>=0&&s.style.display!=="none")a=true;s=s.nextElementSibling;}hds[j].style.display=a?"":"none";}});\n' +
'</script>\n</body></html>\n';
fs.writeFileSync(path.join(HERE, 'label-placement.html'), html);

console.log('wrote tools/shelf-labels.txt (' + keys.length + ' labels) + tools/label-placement.html (' +
  Object.keys(perCls).length + ' sections, ' + shelved.length + ' shelved books)');
