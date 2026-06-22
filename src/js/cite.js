// cite.js — deterministic citation rendering (SPEC-citation-export). Pure, zero-dep,
// no network, NO fabrication: it formats the bibliographic metadata weir already holds
// (item fields + a book's `structured` + a glass card's Dublin Core) into stable,
// resolvable references. The companion to weir_quote: quote VERIFIES a span, cite
// RENDERS the reference for it. A claim with a missing field is reported (`missing`),
// never invented. Mirrors callnumber.js: one structured value, several renderings.

import { slugify } from './store/schema.js';

const citeYearOf = (epoch) => { if (!epoch) return null; try { return String(new Date(epoch).getUTCFullYear()); } catch { return null; } };

// item type → CSL-JSON type (closest standard kind; default webpage for web items)
const CSL_TYPE = {
  paper: 'article-journal', book: 'book', video: 'motion_picture', podcast: 'broadcast',
  note: 'document', doc: 'document', article: 'webpage', status: 'post',
  release: 'webpage', commit: 'webpage', issue: 'webpage', track: 'song', event: 'webpage', file: 'document',
};

// The last name token of an author string ("G. Matheron" → "Matheron"; "Endlein
// Correia" → "Correia"); the inline + cite-key anchor. Falls back to the whole string.
function lastName(author) {
  const s = String(author || '').trim();
  if (!s) return '';
  const first = s.split(/[,;]/)[0].trim();      // first author of a list
  const toks = first.split(/\s+/).filter(Boolean);
  return toks.length ? toks[toks.length - 1] : first;
}

// Pull the bibliographic essentials for an item, drawing on its book `structured` and
// its glass card when present. Returns plain fields + `missing` (absent essentials).
export function citeFields(item, { feed, card } = {}) {
  const dc = (card && card.dublin_core) || {};
  const st = item.structured || {};
  const author = item.author || (Array.isArray(dc.creator) ? dc.creator[0] : dc.creator) || st.author || null;
  const title = (item.title && item.title !== '(untitled)' ? item.title : null) || dc.title || item.title || '(untitled)';
  const year = citeYearOf(item.published_at) || (dc.date ? String(dc.date).slice(0, 4) : null) || (st.year ? String(st.year) : null) || null;
  const container = (feed && feed.name) || dc.source || dc.publisher || null;
  const url = item.url || dc.identifier || null;
  const isbn = st.isbn || null;
  const handle = item.glass_id || item.uid || item.id;   // the stable, resolvable weir handle
  const missing = [];
  if (!author) missing.push('author');
  if (!year) missing.push('date');
  if (title === '(untitled)') missing.push('title');
  return { author, title, year, container, url, isbn, handle, type: item.type, missing };
}

// A deterministic BibTeX-style cite-key: lastname+year (or source/title when no
// author), lowercased + alnum. Disambiguation across a set is the caller's job (pass a
// `seen` Set → a/b/c suffix on collision), so keys are stable per item but unique in a batch.
export function citeKey(item, { feed, card, seen } = {}) {
  const f = citeFields(item, { feed, card });
  const anchor = lastName(f.author) || (f.container ? f.container : '') || String(f.title).split(/\s+/)[0] || 'ref';
  let base = (slugify(anchor).replace(/-/g, '') + (f.year || '')).toLowerCase().replace(/[^a-z0-9]/g, '') || 'ref';
  if (!seen) return base;
  let key = base, i = 0;
  while (seen.has(key)) { key = base + String.fromCharCode(97 + (i++ % 26)); }   // a, b, c…
  seen.add(key);
  return key;
}

// Render one item into every citation form. `locator` (a weir_quote locator, e.g.
// "glass-…#1234-1250") is spliced in as the verified span's handle when present; else
// the item's plain handle is used. `key` is the cite-key for the footnote/inline forms.
export function formatItem(item, { feed, card, locator, key } = {}) {
  const f = citeFields(item, { feed, card });
  const k = key || citeKey(item, { feed, card });
  const ref = locator || `weir ${f.handle}`;   // the durable handle (survives a dead URL — weir holds the copy)

  const inlineAnchor = lastName(f.author) || f.container || String(f.title).slice(0, 24);
  const inline = `(${inlineAnchor}${f.year ? ' ' + f.year : ' n.d.'})`;

  const parts = [];
  if (f.author) parts.push(`${f.author}.`);
  parts.push(`"${f.title}."`);
  if (f.container) parts.push(`${f.container},`);
  parts.push(`${f.year || 'n.d.'}.`);
  if (f.url) parts.push(f.url);
  parts.push(`— ${ref}`);
  if (f.isbn) parts.push(`ISBN ${f.isbn}`);
  const reference = parts.join(' ');

  const csl = {
    id: f.handle,
    type: CSL_TYPE[f.type] || 'webpage',
    title: f.title,
    ...(f.author ? { author: [{ literal: f.author }] } : {}),
    ...(f.year ? { issued: { 'date-parts': [[Number(f.year)]] } } : {}),
    ...(f.container ? { 'container-title': f.container } : {}),
    ...(f.url ? { URL: f.url } : {}),
    ...(f.isbn ? { ISBN: f.isbn } : {}),
    ...(locator ? { locator } : {}),
  };

  return {
    key: k,
    inline,
    reference,
    footnote: `[^${k}]: ${reference}`,
    wikilink: `[[${f.handle}]]`,   // a live graph reference once cited into a stacks note (resolved by wikiLinksOf)
    handle: f.handle,
    csl,
    missing: f.missing,
  };
}

// Assemble a batch of rendered entries into a bibliography block. `style`:
// 'footnotes' (markdown [^key]: …, default), 'numbered' (1. …), or 'plain' (refs).
export function buildBibliography(entries, style = 'footnotes') {
  if (style === 'numbered') return entries.map((e, i) => `${i + 1}. ${e.reference}`).join('\n');
  if (style === 'plain') return entries.map((e) => e.reference).join('\n\n');
  return entries.map((e) => e.footnote).join('\n');
}
