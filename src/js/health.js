// Feed health assessment (SPEC §9 v0.3, and the roadmap "hijack/drift" item).
// Pure, DOM-free, node-testable. Classifies a feed from the items weir already
// stores — no extra network — into one of:
//
//   failing  — the poller can't fetch it (network/parse dead)
//   suspect  — likely hijacked / drifted: an abandoned domain or FeedBurner
//              proxy repurposed into SEO spam. Scored from SEVERAL independent
//              signals so legit feeds (incl. non-English + link blogs) don't trip.
//   stale    — fetches fine but hasn't published in a long time (moved/dormant)
//   ok       — nothing notable
//
// The motivating real case: the PSF FeedBurner feed became Vietnamese shoe spam
// — every post by "admin", linking off to humttovietnam.com, titles all sharing
// a "Giày … Humtto …" template. Each tell alone is weak; together they're loud.

const RECENT = 12;                         // assess the newest N items
const SUSPECT_THRESHOLD = 3;               // points needed to flag suspect
const DEFAULT_STALE_DAYS = 120;            // quiet longer than this → stale
const GENERIC_AUTHOR = /^(admin|administrator|webmaster|root|user|wordpress|editor)$/i;
const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'your', 'you', 'this', 'that', 'from', 'have', 'are', 'was', 'will', 'how', 'what', 'why', 'new', 'all', 'our', 'about', 'into', 'out', 'not']);

export function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return null; }
}

// Approximate registrable-domain compare (eTLD+1 by last two labels). Good
// enough to tell "links to its own site" from "links somewhere else entirely".
export function sameSite(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const tail = (h) => h.split('.').slice(-2).join('.');
  return tail(a) === tail(b);
}

function mode(arr) {
  const counts = new Map();
  let best = null, bestN = 0;
  for (const x of arr) { const n = (counts.get(x) || 0) + 1; counts.set(x, n); if (n > bestN) { bestN = n; best = x; } }
  return best == null ? null : { value: best, count: bestN };
}

// A non-stopword token shared by ≥80% of titles (spam templates repeat a brand
// word in every headline). Returns the token, or null. Diacritic-tolerant.
export function repeatedToken(titles) {
  const lists = titles.map((t) => String(t || '').toLowerCase().split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter((w) => w.length >= 4 && !/^\d+$/.test(w) && !STOPWORDS.has(w)));
  const docFreq = new Map();
  for (const words of lists) for (const w of new Set(words)) docFreq.set(w, (docFreq.get(w) || 0) + 1);
  const need = Math.ceil(titles.length * 0.8);
  let hit = null;
  for (const [w, n] of docFreq) if (n >= need && (!hit || n > hit.n)) hit = { w, n };
  return hit ? hit.w : null;
}

// Assess one feed. `items` is that feed's stored item records (any order).
// Returns { status, score, reasons } — reasons are short human strings.
export function assessFeed(feed, items, now = Date.now(), opts = {}) {
  // Network-dead trumps content checks — the poller already knows.
  if (feed && feed.state === 'failing') {
    return { status: 'failing', score: 0, reasons: [feed.feed_health?.last_error || 'repeated fetch failures'] };
  }

  const recent = [...(items || [])]
    .sort((a, b) => (b.published_at || 0) - (a.published_at || 0))
    .slice(0, RECENT);
  if (!recent.length) return { status: 'ok', score: 0, reasons: [] };

  const reasons = [];
  let score = 0;

  // 1) Author collapse to a generic admin-like name (strong tell, +2).
  const adminPosts = recent.filter((r) => r.author && GENERIC_AUTHOR.test(r.author.trim()));
  if (recent.length >= 4 && adminPosts.length / recent.length >= 0.8) {
    score += 2;
    reasons.push(`every recent post by “${adminPosts[0].author.trim()}”`);
  }

  // 2) Links uniformly point off the feed's own site (+1).
  const feedHost = hostOf(feed?.site_url) || hostOf(feed?.url);
  const linkHosts = recent.map((r) => hostOf(r.url)).filter(Boolean);
  if (feedHost && linkHosts.length >= 4) {
    const offsite = linkHosts.filter((h) => !sameSite(h, feedHost));
    const top = mode(offsite);
    if (top && top.count / linkHosts.length >= 0.8) {
      score += 1;
      reasons.push(`links point to ${top.value}, not ${feedHost}`);
    }
  }

  // 3) Titles share a repeated brand/template word (+1).
  const tok = repeatedToken(recent.map((r) => r.title));
  if (recent.length >= 4 && tok) {
    score += 1;
    reasons.push(`“${tok}” in most recent titles`);
  }

  if (score >= SUSPECT_THRESHOLD) return { status: 'suspect', score, reasons };

  // Stale: fetches fine but long quiet (moved blog, dormant author).
  const staleDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const newest = recent[0].published_at || 0;
  const ageDays = newest ? (now - newest) / 86_400_000 : Infinity;
  if (ageDays > staleDays) {
    return { status: 'stale', score, reasons: [`no new posts in ${Math.round(ageDays)} days`] };
  }

  return { status: 'ok', score, reasons: [] };
}
