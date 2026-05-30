// Feed archaeology — recover a feed's lost/dead history from the Internet
// Archive's Wayback Machine. READ-ONLY and anonymous (no IA key needed; keys are
// for Save-Page-Now, a separate future feature). Be a good citizen: the IA is a
// nonprofit. We mirror holocene's archive.org etiquette — ~0.2 req/s (one every
// 5s), sequential (concurrency 1), a hard snapshot cap, and back-off on 429.
//
// fetch + parseFeed are injected so this is node-testable; in the browser the
// fetch is gcuFetch (the bridge handles archive.org's missing CORS headers).

const CDX = 'https://web.archive.org/cdx/search/cdx';

// Min spacing between requests — politeness, not performance. 5s = 0.2 req/s.
class RateGate {
  constructor(minMs) { this.minMs = minMs; this.last = 0; }
  async wait() {
    const since = Date.now() - this.last;
    if (since < this.minMs) await new Promise((r) => setTimeout(r, this.minMs - since));
    this.last = Date.now();
  }
}

function snapshotUrl(timestamp, original) {
  return `https://web.archive.org/web/${timestamp}id_/${original}`;   // id_ = raw original, no toolbar
}

// Evenly sample n items across the array (keeps first + last) — when a feed has
// hundreds of snapshots we'd rather span the whole timeline than hammer the start.
function sample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const out = [];
  const step = (arr.length - 1) / (n - 1);
  for (let i = 0; i < n; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

// List distinct (by content digest) HTTP-200 snapshots of a URL, oldest first.
export async function cdxSnapshots(feedUrl, { fetch, from, to, limit, retries = 1 } = {}) {
  const params = new URLSearchParams({ url: feedUrl, output: 'json', collapse: 'digest', filter: 'statuscode:200' });
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  if (limit) params.set('limit', String(limit));
  const url = `${CDX}?${params}`;

  let res;
  for (let attempt = 0; ; attempt++) {
    res = await fetch(url);
    if (res.ok) break;
    // 429/503 = IA is busy or rate-limiting us. Back off politely, retry once.
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const ra = Number(res.headers?.get?.('retry-after'));
      await new Promise((r) => setTimeout(r, ra > 0 ? ra * 1000 : 10_000));
      continue;
    }
    throw new Error(`CDX ${res.status}${res.status === 503 ? ' (Internet Archive busy — try later)' : ''}`);
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length < 2) return [];
  const cols = rows[0];
  const ti = cols.indexOf('timestamp'), oi = cols.indexOf('original'), di = cols.indexOf('digest');
  const seen = new Set();
  const out = [];
  for (const r of rows.slice(1)) {
    if (seen.has(r[di])) continue;
    seen.add(r[di]);
    out.push({ timestamp: r[ti], original: r[oi], digest: r[di] });
  }
  return out;
}

// Walk a feed's snapshots politely, parse each, and union the items (deduped by
// id; the store's own dedup makes re-import idempotent too). Returns
// { items, total, fetched, failed }.
export async function recoverFeed(feedUrl, opts = {}) {
  const {
    fetch, parseFeed, feed = { id: 'feed' },
    maxSnapshots = 40, minIntervalMs = 5000,
    cdxLimit = 1000,   // bound the index scan; prolific feeds have thousands of snapshots
    onProgress, signal,
  } = opts;

  const all = await cdxSnapshots(feedUrl, { fetch, limit: cdxLimit });
  const snaps = sample(all, maxSnapshots);
  const gate = new RateGate(minIntervalMs);
  const byId = new Map();
  let fetched = 0, failed = 0, consec = 0;

  for (const s of snaps) {
    if (signal?.aborted) break;
    await gate.wait();
    try {
      const res = await fetch(snapshotUrl(s.timestamp, s.original));
      if (res.status === 429) { consec++; await new Promise((r) => setTimeout(r, 30_000)); if (consec >= 3) break; continue; }
      if (!res.ok) { failed++; if (++consec >= 5) break; continue; }
      const items = parseFeed(await res.text(), { feed }).items;
      for (const it of items) if (!byId.has(it.id)) byId.set(it.id, it);
      fetched++; consec = 0;
      onProgress?.({ fetched, total: snaps.length, items: byId.size, when: s.timestamp });
    } catch {
      failed++; if (++consec >= 5) break;
    }
  }
  return { items: [...byId.values()], total: snaps.length, fetched, failed };
}
