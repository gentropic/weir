// Multi-format import (SPEC §9, extended). Sniffs a dropped file and parses it
// into either FEEDS (OPML — left to the caller's existing OPML path) or
// SAVED-LINK records. Pure + testable; the network unwrap + store insert live in
// the app layer (which has gcuFetch + the store). First link format: Holocene's
// Telegram bot export — see weir-holocene-migration. Add a format = one parser.

// Share-sheet / shortener hosts whose URLs must be unwrapped (followed to their
// real destination) before dedup. Holocene did this with requests.get(allow_
// redirects=True).url; gcuFetch replicates it (follows redirects → response.url).
export const WRAPPER_HOSTS = new Set([
  'share.google', 'search.app', 'goo.gl', 'g.co', 'bit.ly', 't.co', 'tinyurl.com',
  'fb.me', 'lnkd.in', 'ow.ly', 'buff.ly', 'dlvr.it', 'trib.al', 'rebrand.ly',
]);

// Hosts we never import AS saved links: the bot echoes Internet Archive snapshots
// + Telegram-internal links into the chat, and Holocene's own remote-access host
// (holo.stdgeo.com — the Cloudflare tunnel) shows up as "view in Holocene" / login
// pointers, not real content.
const IMP_SKIP_HOSTS = new Set([
  'web.archive.org', 'archive.org', 't.me', 'telegram.org', 'telegram.me',
  'holo.stdgeo.com',
]);

// Is this a host we skip on import (and purge from saved links if it slipped in)?
export function isSkippedUrl(url) { return IMP_SKIP_HOSTS.has(impHost(url)); }

const IMP_URL_RE = /https?:\/\/[^\s<>"'\])]+/g;

export function isWrappedUrl(url) {
  try { return WRAPPER_HOSTS.has(new URL(url).hostname.replace(/^www\./, '')); } catch { return false; }
}
function impHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
function impSkip(url) { return isSkippedUrl(url); }

// A Telegram export message's text is either a string or an array of segments
// (plain strings + entity objects). Reconstruct the plain text + collect URLs.
function impMsgText(m) {
  const t = m && m.text;
  if (typeof t === 'string') return t;
  if (Array.isArray(t)) return t.map((x) => (typeof x === 'string' ? x : (x && x.text) || '')).join('');
  return '';
}
function impMsgUrls(m) {
  const out = [];
  const t = m && m.text;
  if (Array.isArray(t)) for (const x of t) {
    if (x && (x.type === 'link' || x.type === 'text_link' || x.type === 'url')) { const u = x.href || x.text; if (u) out.push(u); }
  }
  const text = impMsgText(m);
  let mm; IMP_URL_RE.lastIndex = 0;
  while ((mm = IMP_URL_RE.exec(text))) out.push(mm[0]);
  // strip trailing punctuation, dedup within the message
  return [...new Set(out.map((u) => String(u).replace(/[.,;:!?)\]]+$/, '')))];
}
// The title that rides along in the share text, e.g. Google Discover's
// "Title | Source https://share.google/…" or "Title\nhttps://…". Strip the
// URL(s) out and tidy what's left; too-short remainders aren't titles.
function impTitleFrom(text, urls) {
  let s = String(text || '');
  for (const u of urls) s = s.split(u).join(' ');
  s = s.replace(/\s+/g, ' ').trim().replace(/^[-–—|:•·\s]+|[-–—|:•·\s]+$/g, '').trim();
  return s.length >= 3 ? s : null;
}

// Parse a Telegram Desktop chat/bot export (result.json) → saved-link records.
// First occurrence of each URL wins (the user's send precedes any bot echo), so
// dedup naturally drops the bot's confirmations.
export function parseTelegramExport(json) {
  const msgs = json && Array.isArray(json.messages) ? json.messages : [];
  // Take only YOUR messages, not the bot's. In a bot/DM chat `json.name` IS the
  // counterparty (the bot — e.g. "Holocene") and equals the `from` on its
  // messages, so skip those: the bot's "Link Added" confirmations echo the real
  // url, so link-counting can't tell you apart (it'd often pick the bot). Fallback
  // when there's no usable chat name: keep only the dominant link-sender.
  const senderOf = (m) => m.from || m.from_id || '?';
  const isDM = json && (json.type === 'bot_chat' || json.type === 'personal_chat');
  const bot = isDM && json.name ? String(json.name) : null;
  let keep = bot ? ((m) => senderOf(m) !== bot) : null;
  if (!keep) {
    const linkCount = {};
    for (const m of msgs) {
      if (impMsgUrls(m).some((u) => /^https?:\/\//i.test(u) && !impSkip(u))) { const s = senderOf(m); linkCount[s] = (linkCount[s] || 0) + 1; }
    }
    const senders = Object.keys(linkCount);
    const owner = senders.length > 1 ? senders.reduce((a, b) => (linkCount[b] > linkCount[a] ? b : a)) : null;
    if (owner) keep = (m) => senderOf(m) === owner;
  }

  const links = [];
  const seen = new Set();
  for (const m of msgs) {
    if (keep && !keep(m)) continue;   // skip the bot / non-owner messages
    const urls = impMsgUrls(m).filter((u) => /^https?:\/\//i.test(u) && !impSkip(u));
    if (!urls.length) continue;
    const text = impMsgText(m);
    const title = impTitleFrom(text, urls);
    const dateMs = m.date_unixtime ? Number(m.date_unixtime) * 1000
      : (m.date ? (Date.parse(m.date) || undefined) : undefined);
    for (const url of urls) {
      const key = url.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ url, title: urls.length === 1 ? title : null, date: dateMs, wrapped: isWrappedUrl(url) });
    }
  }
  return links;
}

// One URL per line, optionally "Title — https://…" / "https://… Title".
export function parseUrlList(text) {
  const links = [];
  const seen = new Set();
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/https?:\/\/[^\s]+/);
    if (!m) continue;
    const url = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (impSkip(url)) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const title = impTitleFrom(line, [m[0]]);
    links.push({ url, title, date: undefined, wrapped: isWrappedUrl(url) });
  }
  return links;
}

// ── LibraryThing JSON export → book holdings ──────────────────────────────────
// LibraryThing has no bulk-collection API, so the workflow is export-and-drop (fits
// weir: no server, no key, no live dependency). The export is an object keyed by
// book id; field shapes vary by export, so parse defensively. Re-importing a fuller
// export is idempotent (stable id from books_id/ISBN), so it UPDATES, never dupes.
function ltStr(v) { return v == null ? '' : String(v).trim(); }
function ltAuthor(b) {
  const a = b.authors || b.author || b.primaryauthor;
  const first = Array.isArray(a) ? a[0] : a;
  if (!first) return '';
  return ltStr(typeof first === 'string' ? first : (first.fl || first.lf || first.name));
}
function ltIsbn(b) {
  const c = b.ISBNs || b.isbns || b.ISBN || b.isbn || b.originalisbn;
  for (const v of (Array.isArray(c) ? c : (c ? [c] : []))) {
    const d = String(v).replace(/[^0-9xX]/gi, '');
    if (d.length === 10 || d.length === 13) return d;
  }
  return null;
}
function ltCode(v) {   // ddc / lcc may be {code:[…]} | {code:"…"} | "…"
  if (!v) return null;
  if (typeof v === 'string') return v.trim() || null;
  const c = v.code;
  return (Array.isArray(c) ? c[0] : c) ? String(Array.isArray(c) ? c[0] : c).trim() : null;
}
function ltTags(b) {
  const t = b.tags;
  if (Array.isArray(t)) return t.map(ltStr).filter(Boolean);
  if (t && typeof t === 'object') return Object.keys(t).map(ltStr).filter(Boolean);
  if (typeof t === 'string') return t.split(',').map((s) => s.trim()).filter(Boolean);
  return [];
}
function ltDate(b) {
  const d = ltStr(b.date || b.publication_date || b.publicationdate || b.originalpublicationdate);
  const y = d.match(/\b(1[4-9]\d\d|20\d\d)\b/);
  if (y) return Date.UTC(Number(y[1]), 0, 1);
  const p = Date.parse(d); return Number.isFinite(p) ? p : undefined;
}
function ltIsBookish(v) { return v && typeof v === 'object' && (v.books_id || v.book_id || v.ISBNs || v.ddc || v.lcc || (v.title && (v.authors || v.tags || v.ISBN || v.isbn))); }

export function parseLibraryThing(json) {
  let data; try { data = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
  const entries = Array.isArray(data) ? data : Object.values(data || {});
  const books = []; const seen = new Set();
  for (const b of entries) {
    if (!b || typeof b !== 'object') continue;
    const title = ltStr(b.title);
    const ltId = ltStr(b.books_id || b.book_id || b.id || b.workcode);
    const isbn = ltIsbn(b);
    if (!title && !isbn && !ltId) continue;
    const key = ltId || isbn || title.toLowerCase();
    if (seen.has(key)) continue; seen.add(key);
    books.push({
      lt_id: ltId || null, isbn, title: title || '(untitled)', author: ltAuthor(b),
      tags: ltTags(b), ddc: ltCode(b.ddc), lcc: ltCode(b.lcc),
      date: ltDate(b), excerpt: ltStr(b.comment || b.review || b.summary).slice(0, 400),
    });
  }
  return books;
}

// Sniff a file's content → { format, links? }. OPML returns no links (the caller
// routes it to the existing feed-import flow); link formats return parsed records.
export function detectImport(text) {
  const t = String(text || '').trimStart();
  if (t[0] === '{' || t[0] === '[') {
    try {
      const j = JSON.parse(text);
      if (j && Array.isArray(j.messages)) return { format: 'telegram', links: parseTelegramExport(j) };
      // LibraryThing export — an object keyed by book id whose entries look bookish.
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        const vals = Object.values(j);
        if (vals.length && vals.some(ltIsBookish)) { const books = parseLibraryThing(j); if (books.length) return { format: 'librarything', books }; }
      }
      if (Array.isArray(j) && j.length && j.some(ltIsBookish) && !j.every((x) => x && typeof x.url === 'string')) {
        const books = parseLibraryThing(j); if (books.length) return { format: 'librarything', books };
      }
      if (Array.isArray(j) && j.length && j.every((x) => x && typeof x.url === 'string')) {
        return {
          format: 'json-links',
          links: j.filter((x) => !impSkip(x.url)).map((x) => ({
            url: x.url, title: x.title || null,
            date: x.date ? (Date.parse(x.date) || undefined) : undefined,
            wrapped: isWrappedUrl(x.url),
          })),
        };
      }
    } catch { /* not the JSON we know — fall through */ }
  }
  if (/<opml[\s>]/i.test(t) || (/<\?xml/i.test(t) && /<outline/i.test(t))) return { format: 'opml' };
  if (/https?:\/\//.test(t)) { const links = parseUrlList(text); if (links.length) return { format: 'urls', links }; }
  return null;
}
