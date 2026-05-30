// Data model + pure helpers for the store (SPEC §2/§5). No VFS/DOM here, so
// this runs anywhere (browser bundle and the node smoke test alike).

export const SCHEMA_VERSION = 1;

export const ITEM_TYPES = [
  'article', 'video', 'release', 'paper', 'status', 'track', 'podcast', 'commit', 'issue',
];

// Retention TTLs in days, or 'forever'. Per-feed `retention` overrides these
// (SPEC §5). v0.1 stores expires_at but does not enforce it — the retainer is
// v0.2; the field existing now means no migration later.
export const RETENTION = {
  article: { unread: 60, read: 30 },
  video:   { unread: 30, read: 14 },
  release: { unread: 'forever', read: 'forever' },
  paper:   { unread: 'forever', read: 'forever' },
  status:  { unread: 14, read: 7 },
  track:   { unread: 'forever', read: 'forever' },  // capped by snapshot count, not time
  podcast: { unread: 90, read: 90 },
  commit:  { unread: 30, read: 14 },
  issue:   { unread: 90, read: 30 },
};

export const DEFAULT_SETTINGS = {
  default_poll_interval_minutes: 30,
  poll_concurrency: 8,
  pause_polling_when_hidden: true,
  images_default_allowed: false,
  retainer_run_hour: 4,
  theme: 'switchboard-dark',
  fetch_full_content_default: false,
  // Feed archaeology (Wayback recovery) politeness — be gentle to the IA.
  wayback_min_interval_ms: 5000,    // ~0.2 req/s, one request every 5s
  wayback_max_snapshots: 40,        // hard cap per recovery run
  // Optional Internet Archive S3 keys — NOT needed for read-only recovery; for
  // future Save-Page-Now (proactively archiving your live feeds). Empty = off.
  ia_access_key: '',
  ia_secret_key: '',
};

const DAY_MS = 86_400_000;

export function now() { return Date.now(); }

// FNV-1a → 8 hex chars. Deterministic; used to disambiguate fs keys.
export function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Filesystem-safe key for an arbitrary id. Readable prefix + hash so distinct
// ids never collide and the result is legal on FSA/Windows (no ':' '/' etc.).
export function fsKey(id) {
  const s = String(id);
  const cleaned = s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'x';
  return `${cleaned}.${hash32(s)}`;
}

export function slugify(s) {
  return String(s).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'feed';
}

// Strip tags + collapse whitespace, take the first ~n chars. For list previews.
export function deriveExcerpt(htmlOrText, n = 300) {
  if (!htmlOrText) return '';
  const text = String(htmlOrText)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > n ? text.slice(0, n).trimEnd() + '…' : text;
}

export function deriveSearchText(rec) {
  return [rec.title, rec.author, rec.excerpt].filter(Boolean).join(' ').toLowerCase();
}

// expires_at = published_at + ttl(type, feed); null = never. Saved items never
// expire. Computed against the unread TTL at insert (read TTL handling is v0.2).
export function computeExpiry(rec, feed) {
  if (rec.saved) return null;
  const override = feed && feed.retention && feed.retention.unread_days;
  const ttl = override != null ? override : (RETENTION[rec.type]?.unread ?? 'forever');
  if (ttl === 'forever') return null;
  return rec.published_at + ttl * DAY_MS;
}

// Normalize a raw adapter item into a stored Item *metadata* record. Content
// (the HTML body) is carried separately by the store and lives in its own file
// — this record is what the in-memory index and per-feed shard hold.
export function makeItem(raw, feed) {
  const fetched_at = raw.fetched_at ?? now();
  const rec = {
    id: String(raw.id),
    feed_id: feed.id,
    url: raw.url || '',
    title: raw.title || '(untitled)',
    author: raw.author || undefined,
    published_at: raw.published_at ?? fetched_at,
    fetched_at,
    type: ITEM_TYPES.includes(raw.type) ? raw.type : 'article',
    excerpt: raw.excerpt ?? deriveExcerpt(raw.content || raw.text || ''),
    read: false,
    saved: false,
    archived: false,
    tags: Array.isArray(raw.tags) ? [...raw.tags] : [],
    media: raw.media || undefined,
    structured: raw.structured || undefined,
    has_content: !!(raw.content && String(raw.content).length),
  };
  rec.search_text = deriveSearchText(rec);
  rec.expires_at = computeExpiry(rec, feed);
  return rec;
}

export function makeFeed(raw) {
  const id = raw.id ? String(raw.id) : slugify(raw.name || raw.url || 'feed');
  return {
    id,
    url: raw.url || '',
    adapter: raw.adapter || 'feed',
    name: raw.name || id,
    site_url: raw.site_url || undefined,
    icon_url: raw.icon_url || undefined,
    poll_interval_minutes: raw.poll_interval_minutes ?? DEFAULT_SETTINGS.default_poll_interval_minutes,
    last_polled_at: raw.last_polled_at || undefined,
    next_poll_at: raw.next_poll_at ?? now(),
    etag: raw.etag || undefined,
    last_modified: raw.last_modified || undefined,
    images_allowed: raw.images_allowed ?? DEFAULT_SETTINGS.images_default_allowed,
    fetch_full_content: raw.fetch_full_content ?? DEFAULT_SETTINGS.fetch_full_content_default,
    retention: raw.retention || undefined,
    category: raw.category || undefined,
    feed_health: raw.feed_health || {
      last_successful_poll: undefined,
      consecutive_failures: 0,
      last_error: undefined,
      avg_items_per_week: undefined,
      publication_history: [],
    },
    state: raw.state || 'healthy',
    config: raw.config || undefined,
  };
}

// A tombstone for the archived_index — minimal, not the full item (SPEC §5).
export function makeTombstone(id, feed_id, reason) {
  return { id: String(id), feed_id, archived_at: now(), reason };
}
