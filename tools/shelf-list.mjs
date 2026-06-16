// Shelf list (CLI) — write a portable single-file HTML of the BOOKS holdings in glass
// call-number (shelf) order, built straight from the live store on disk (read-only).
// The HTML is produced by the SHARED builder (src/js/shelflist.js) — the same code the
// in-app "Export shelf list" uses — so the two never drift. Use it as a walk-the-shelf
// checklist: anything in hand that ISN'T on the sheet is a gap to scan.
// Run: node tools/shelf-list.mjs [storeDir] [outFile]
//   storeDir defaults to C:\Users\endar\Documents\weir (the FSA-mounted live store)
//   outFile  defaults to <storeDir>\..\weir-shelf.html
import fs from 'node:fs';
import path from 'node:path';
import { buildShelfHtml } from '../src/js/shelflist.js';

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
const cardFor = (b) => (b.glass_id && byGlassId.get(b.glass_id)) || byDocRef.get(b.id) || null;

const html = buildShelfHtml(books, cardFor);
fs.writeFileSync(OUT, html);
const cataloged = books.filter((b) => !!cardFor(b)).length;
console.log(`shelf list → ${OUT}\n  ${books.length} books (${cataloged} cataloged, ${books.length - cataloged} not), ${(html.length / 1024).toFixed(0)} KB`);
