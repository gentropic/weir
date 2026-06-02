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

// URLs we never want to import AS saved links (the bot echoes archive snapshots
// + Telegram-internal links into the chat).
const IMP_SKIP_HOSTS = new Set(['web.archive.org', 'archive.org', 't.me', 'telegram.org', 'telegram.me']);

const IMP_URL_RE = /https?:\/\/[^\s<>"'\])]+/g;

export function isWrappedUrl(url) {
  try { return WRAPPER_HOSTS.has(new URL(url).hostname.replace(/^www\./, '')); } catch { return false; }
}
function impHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}
function impSkip(url) { return IMP_SKIP_HOSTS.has(impHost(url)); }

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
  // In a bot/DM chat the bot only REPLIES, so take links from the chat OWNER (you)
  // only: the sender of the most link-bearing messages. (Single-sender export →
  // owner null → take all.) This excludes the bot's own suggestions/answers, on
  // top of the archive/telegram-link skip + url dedup below.
  const senderOf = (m) => m.from || m.from_id || '?';
  const linkCount = {};
  for (const m of msgs) {
    if (impMsgUrls(m).some((u) => /^https?:\/\//i.test(u) && !impSkip(u))) {
      const s = senderOf(m);
      linkCount[s] = (linkCount[s] || 0) + 1;
    }
  }
  const senders = Object.keys(linkCount);
  const owner = senders.length > 1 ? senders.reduce((a, b) => (linkCount[b] > linkCount[a] ? b : a)) : null;

  const links = [];
  const seen = new Set();
  for (const m of msgs) {
    if (owner && senderOf(m) !== owner) continue;   // skip the bot's messages
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

// Sniff a file's content → { format, links? }. OPML returns no links (the caller
// routes it to the existing feed-import flow); link formats return parsed records.
export function detectImport(text) {
  const t = String(text || '').trimStart();
  if (t[0] === '{' || t[0] === '[') {
    try {
      const j = JSON.parse(text);
      if (j && Array.isArray(j.messages)) return { format: 'telegram', links: parseTelegramExport(j) };
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
