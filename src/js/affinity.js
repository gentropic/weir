// Watch-affinity from a Google Takeout watch-history digest. Raw watch count is
// noisy — Shorts autoplay inflates it, and old fads linger (a channel you binged
// years ago but dropped — e.g. a Shorts-era flash-in-the-pan). Weighting by
// recency fixes both: recent watches count fully, stale ones decay hard, so the
// score reflects what you actually watch *now*.

function recencyWeight(monthsSince) {
  if (monthsSince == null) return 0.1;
  if (monthsSince <= 6) return 1;
  if (monthsSince <= 12) return 0.6;
  if (monthsSince <= 24) return 0.25;
  return 0.08;
}

// entry: { watches, months_since } → integer score.
export function affinityScore(entry) {
  if (!entry) return 0;
  return Math.round((entry.watches || 0) * recencyWeight(entry.months_since));
}

// YouTube channel id from a feed/channel URL, or null.
export function channelIdOf(url) {
  const s = String(url || '');
  const m = s.match(/channel_id=(UC[\w-]+)/) || s.match(/\/channel\/(UC[\w-]+)/);
  return m ? m[1] : null;
}

// Digest ({ channelId: { watches, months_since } }) → { channelId: score }.
export function parseWatchDigest(json) {
  const obj = typeof json === 'string' ? JSON.parse(json) : json;
  const out = {};
  for (const [id, e] of Object.entries(obj || {})) out[id] = affinityScore(e);
  return out;
}
