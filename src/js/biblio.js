// Bibliographic enricher — for items that ARE a paper or a book (an arXiv ID, a
// DOI, or an ISBN in the URL), fetch AUTHORITATIVE metadata from the open
// scholarly/library APIs and fill the glass card's Dublin Core from the source,
// so the LLM cataloger only has to do the subjective facets. All free, no API key;
// fetched through gcuFetch (the bridge brokers CORS). Good-citizen: join the
// Crossref/OpenAlex "polite pool" with a mailto when one is configured, and the
// bridge caches responses so we don't re-hit for the same id.
//
// Ported from the Holocene research clients (arXiv / Crossref / Open Library).

import { decodeEntities } from './parse/xml.js';

// Detect a bibliographic identifier in a URL → { kind, id } | null. Order matters:
// arXiv before DOI (an arXiv URL has no DOI), DOI before ISBN.
export function detectBiblio(url) {
  const u = String(url || '');
  let m = u.match(/arxiv\.org\/(?:abs|pdf)\/(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i);
  if (m) return { kind: 'arxiv', id: m[1] };
  m = u.match(/(?:doi\.org\/|\bdoi[:=]\s*)(10\.\d{4,9}\/[^\s"'<>?#&]+)/i) || u.match(/(?:^|[/=])(10\.\d{4,9}\/[A-Za-z0-9._;()/:-]+)/);
  if (m) return { kind: 'doi', id: decodeURIComponent(m[1]).replace(/[).,;]+$/, '') };
  m = u.match(/isbn[/=:]?\s*((?:97[89])?[\dxX]{10,13})/i);
  if (m) { const id = m[1].replace(/[^0-9xX]/gi, ''); if (id.length === 10 || id.length === 13) return { kind: 'isbn', id }; }
  return null;
}

const clean = (s) => (s ? decodeEntities(String(s)).replace(/\s+/g, ' ').trim() : null);
async function asJson(r) { try { return JSON.parse(await r.text()); } catch { return null; } }   // bridge Response may lack .json()

// arXiv Atom API — title / authors / abstract / date for an arXiv id.
async function fetchArxiv(id, fetch) {
  const r = await fetch(`https://export.arxiv.org/api/query?id_list=${encodeURIComponent(id)}&max_results=1`);
  if (!r || !r.ok) return null;
  const xml = await (r.text ? r.text() : '');
  const entry = (xml.match(/<entry\b[\s\S]*?<\/entry>/i) || [''])[0];
  const title = clean((entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]);
  if (!title) return null;
  const published = (entry.match(/<published[^>]*>([\s\S]*?)<\/published>/i) || [, ''])[1].trim();
  const authors = [...entry.matchAll(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>[\s\S]*?<\/author>/gi)].map((mm) => clean(mm[1])).filter(Boolean);
  const abstract = clean((entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i) || [, ''])[1]);
  return { source: 'arxiv', title, creators: authors, date: published.slice(0, 10) || null, abstract, publisher: 'arXiv', identifiers: [`arXiv:${id}`] };
}

// Crossref — DOI → bibliographic record.
async function fetchCrossref(doi, fetch, mailto) {
  const r = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}` + (mailto ? `?mailto=${encodeURIComponent(mailto)}` : ''));
  if (!r || !r.ok) return null;
  const j = await asJson(r); const w = j && j.message; if (!w) return null;
  const parts = w.issued && w.issued['date-parts'] && w.issued['date-parts'][0];
  const date = Array.isArray(parts) ? parts.map((n, i) => (i ? String(n).padStart(2, '0') : String(n))).join('-') : null;
  return {
    source: 'crossref',
    title: clean(Array.isArray(w.title) ? w.title[0] : w.title),
    creators: (w.author || []).map((a) => [a.given, a.family].filter(Boolean).join(' ') || a.name).filter(Boolean),
    date,
    abstract: w.abstract ? clean(String(w.abstract).replace(/<[^>]+>/g, ' ').replace(/\s+([.,;:!?)\]])/g, '$1')) : null,
    publisher: clean(w['container-title'] && w['container-title'][0]) || clean(w.publisher),
    identifiers: [`doi:${doi}`], type: w.type || null,
  };
}

// Open Library — ISBN → title / authors / cover.
async function fetchOpenLibrary(isbn, fetch) {
  const r = await fetch(`https://openlibrary.org/api/books?bibkeys=ISBN:${encodeURIComponent(isbn)}&jscmd=data&format=json`);
  if (!r || !r.ok) return null;
  const j = await asJson(r); const b = j && j[`ISBN:${isbn}`]; if (!b) return null;
  return {
    source: 'openlibrary',
    title: clean(b.title) + (b.subtitle ? `: ${clean(b.subtitle)}` : ''),
    creators: (b.authors || []).map((a) => clean(a.name)).filter(Boolean),
    date: b.publish_date || null,
    abstract: clean(b.notes && (b.notes.value || b.notes)) || null,
    publisher: clean((b.publishers || [])[0] && (b.publishers[0].name || b.publishers[0])) || null,
    identifiers: [`isbn:${isbn}`], cover: (b.cover && b.cover.medium) || null,
  };
}

// Fetch authoritative metadata for a detected identifier. Best-effort: any failure
// (network / parse / not found) returns null so cataloging proceeds LLM-only.
export async function fetchBiblio(det, { fetch, mailto } = {}) {
  if (!det || !fetch) return null;
  try {
    if (det.kind === 'arxiv') return await fetchArxiv(det.id, fetch);
    if (det.kind === 'doi') return await fetchCrossref(det.id, fetch, mailto);
    if (det.kind === 'isbn') return await fetchOpenLibrary(det.id, fetch);
  } catch { /* best-effort */ }
  return null;
}

// Overlay authoritative bibliographic fields onto a glass card's Dublin Core
// (title / creators / date / publisher) + stamp the source in glass.biblio. Leaves
// `description` for the LLM (one-sentence summary) and `identifier` (the URL) alone.
export function applyBiblio(card, bib) {
  if (!bib) return card;
  const dc = { ...card.dublin_core };
  if (bib.title) dc.title = bib.title;
  if (bib.creators && bib.creators.length) dc.creator = bib.creators;
  if (bib.date) dc.date = bib.date;
  if (bib.publisher) dc.publisher = bib.publisher;
  return { ...card, dublin_core: dc, glass: { ...(card.glass || {}), biblio: bib.source } };
}
