// @gcu/glass — Stage 0: deterministic catalog cards from weir items, NO LLM.
// Maps what weir already knows onto the glass card format (see GLASS.md §4–5):
// form←type, provenance←feed, temporal←published_at, Dublin Core ← item fields,
// entity ⊇ tags. The language facets (domain/entity/process/method/scale/spatial)
// and the abstract are left for the Stage-1 cataloger service. Pure + testable.

export const FACETS = ['domain', 'entity', 'process', 'method', 'scale', 'spatial', 'temporal', 'form', 'provenance'];

// weir item.type → glass `form` facet (genre of document).
export const TYPE_TO_FORM = {
  article: 'article', video: 'video', release: 'release', paper: 'paper',
  status: 'status', track: 'track', podcast: 'podcast', commit: 'commit',
  issue: 'issue', note: 'note',
};

// Coarse origin tier until the real provenance vocabulary is frozen (GLASS §15.3,
// seeded from Holocene trust tiers). Stage 0 derives it from the adapter/kind.
export function provenanceFor(feed, item) {
  if (item.type === 'note' || item.feed_id === 'self') return 'self';
  switch (feed && feed.adapter) {
    case 'youtube': return 'video-platform';
    case 'github': return 'code-host';
    default: return 'web-feed';
  }
}

function isoDate(epoch) { if (!epoch) return undefined; try { return new Date(epoch).toISOString().slice(0, 10); } catch { return undefined; } }
function yearOf(epoch) { if (!epoch) return null; try { return String(new Date(epoch).getUTCFullYear()); } catch { return null; } }

// glass_id = glass-YYYYMMDD-NNN (catalog date + 1-based daily sequence).
export function nextGlassId(cataloged, n) {
  return `glass-${String(cataloged).replace(/-/g, '')}-${String(n).padStart(3, '0')}`;
}

// Deterministic Stage-0 facets for an item (+ its feed) — a pure function of what
// weir already knows. The language facets (domain/process/method/scale/spatial)
// stay empty until the Stage-1 cataloger. Used by buildCard AND the live catalog
// view (so the browser is instant + always current; Stage 1 will source enriched
// facets from the persisted card index instead).
export function facetsOf(item, feed) {
  const year = yearOf(item.published_at);
  const entity = Array.isArray(item.tags) ? [...new Set(item.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))] : [];
  return {
    domain: [], entity, process: [], method: [], scale: [],
    form: [TYPE_TO_FORM[item.type] || 'article'],
    provenance: [provenanceFor(feed, item)],
    spatial: [],
    temporal: year ? [year] : [],
  };
}

// Build the deterministic Stage-0 card for one item (+ its feed). No network.
export function buildCard(item, feed, opts = {}) {
  const cataloged = opts.cataloged || new Date().toISOString().slice(0, 10);
  const glass_id = opts.glass_id || nextGlassId(cataloged, 1);

  const dublin_core = {
    title: item.title || '(untitled)',
    creator: item.author ? [item.author] : [],
    date: isoDate(item.published_at),
    type: item.type || 'article',
    identifier: item.url || undefined,
    source: (feed && feed.name) || item.feed_id,
    description: item.excerpt || undefined,
  };

  const facets = facetsOf(item, feed);

  return {
    dublin_core,
    facets,
    glass: {
      glass_id,
      document_ref: item.id,
      cataloged,
      cataloger: 'stage0-rules',
      confidence: 0.3,        // metadata-only; the language facets await the cataloger
      needs_review: true,     // a Stage-1 LLM pass should enrich + confirm
      related: [],
    },
  };
}
