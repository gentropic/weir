// The `usgs` adapter — earthquakes from the USGS GeoJSON summary feeds. weir's
// first *exotic* source: not RSS/Atom, not a feed at all, but a raw timestamped
// JSON API reduced to discrete `event` items (ROADMAP: weir-as-gauge — the name
// finally measuring a flow, not just reading a stream).
//
// USGS publishes magnitude-tiered feeds at
//   earthquake.usgs.gov/earthquakes/feed/v1.0/summary/<tier>_<window>.geojson
// where <tier> ∈ significant | 4.5 | 2.5 | 1.0 | all and <window> ∈ hour|day|week|month.
// Volume is bounded BY THE TIER you subscribe to (the firehose-avoidance is the
// feature): `significant` ≈ a handful/week, `4.5` ≈ 10–20/day, `2.5`/`all` = the
// hose to avoid. Each quake carries a stable USGS event id → dedup + in-place
// magnitude revisions for free.

const TIER_LABEL = { significant: 'significant', 4.5: 'M4.5+', 2.5: 'M2.5+', 1.0: 'M1+', all: 'all' };

function parseFeedUrl(url) {
  const m = String(url).match(/summary\/(significant|[\d.]+|all)_(hour|day|week|month)\.geojson/i);
  return m ? { tier: m[1], window: m[2] } : null;
}

// A readable default name from the feed URL: "USGS Earthquakes (M4.5+, week)".
export function usgsName(url) {
  const p = parseFeedUrl(url);
  if (!p) return 'USGS Earthquakes';
  return `USGS Earthquakes (${TIER_LABEL[p.tier] || `M${p.tier}+`}, ${p.window})`;
}

// 1 decimal, '?' if missing — magnitudes are sometimes null for fresh events.
function mag(m) { return (m == null || Number.isNaN(m)) ? '?' : Number(m).toFixed(1); }

export function parseUsgs(text, opts = {}) {
  const feed = opts.feed || { id: 'usgs' };
  let data;
  try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch { return { meta: {}, items: [] }; }
  if (!data || !Array.isArray(data.features)) return { meta: {}, items: [] };

  const items = data.features.map((f) => {
    const p = f.properties || {};
    const g = (f.geometry && f.geometry.coordinates) || [];
    const place = p.place || 'unknown location';
    const depth = g[2];
    const title = p.title || `M ${mag(p.mag)} - ${place}`;
    // A small, human body (the "card" the gauge reduces the raw feature to).
    const bits = [`Magnitude <b>${mag(p.mag)}</b>`, place];
    if (depth != null) bits.push(`depth ${Math.round(depth)} km`);
    if (p.felt) bits.push(`${p.felt} felt reports`);
    if (p.tsunami) bits.push('⚠ tsunami flag');
    return {
      id: `${feed.id}:${f.id}`,                 // stable USGS event id → dedup; revisions update in place
      feed_id: feed.id,
      url: p.url || undefined,
      title,
      published_at: p.time || undefined,
      type: 'event',
      content: `<p>${bits.join(' · ')}.</p>`,
      structured: {
        mag: p.mag ?? undefined,
        place,
        depth_km: depth != null ? Math.round(depth * 10) / 10 : undefined,
        coords: g.length >= 2 ? [g[0], g[1]] : undefined,
        felt: p.felt || undefined,
        tsunami: p.tsunami ? 1 : undefined,
      },
    };
  });
  return { meta: { title: data.metadata && data.metadata.title }, items };
}

export const usgsAdapter = {
  name: 'usgs',
  match(url) {
    try {
      const u = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`);
      return /(^|\.)earthquake\.usgs\.gov$/i.test(u.hostname) && /\.geojson$/i.test(u.pathname);
    } catch { return false; }
  },
  titleFor(url) { return usgsName(url); },
  async parse(response, feed) { return parseUsgs(await response.text(), { feed }).items; },
};
