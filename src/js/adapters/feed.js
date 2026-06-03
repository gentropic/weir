// The `feed` adapter — RSS 2.0 / RSS 1.0 (RDF) / Atom 1.0 / JSON Feed. The
// fallback adapter (registered last; matches anything feed-shaped). Produces
// raw item objects ready for store.upsertItems (SPEC §3). Pure `parseFeed` is
// node-testable; `feedAdapter.parse` wraps a Response.

import { parseXml } from '../parse/xml.js';
import { sanitizeHtml } from '../parse/sanitize.js';
import { hash32 } from '../store/schema.js';

function toEpoch(s) {
  if (!s) return undefined;
  const t = Date.parse(String(s).trim());
  return Number.isNaN(t) ? undefined : t;
}

// "HH:MM:SS" / "MM:SS" / "3600" → seconds.
function toSeconds(s) {
  if (!s) return undefined;
  s = String(s).trim();
  if (/^\d+$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some(Number.isNaN)) return undefined;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// Stable, feed-scoped id. Namespacing by feed.id guards against two feeds that
// happen to share a (non-URL) guid — the store dedups globally by id.
function stableId(feed, candidates) {
  const first = candidates.find((c) => c && String(c).trim());
  if (first) return `${feed.id}:${String(first).trim()}`;
  // No usable id/guid/link — synthesize from the visible fields so re-fetches match.
  return `${feed.id}:h${hash32(candidates.join('|'))}`;
}

// First usable <img> URL in a content fragment — a gallery-thumbnail fallback
// for feeds that embed images inline but ship no media:/enclosure tags. Run on
// RAW content (pre-sanitize) so it works even when inline images are blocked;
// the result is a thumbnail URL, not injected content. Skips data URIs,
// relative srcs, tracking pixels, avatars, and 1×1 spacers.
function firstImageIn(html) {
  if (!html) return null;
  const re = /<img\b[^>]*?\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const src = m[1].trim();
    if (!/^https?:\/\//i.test(src)) continue;
    if (/\b(width|height)\s*=\s*["']?1\b/i.test(m[0])) continue;   // 1px spacer
    if (/doubleclick|feedburner|feedsportal|gravatar|\/pixel|1x1|spacer|blank\.gif|\btrack(ing)?\b/i.test(src)) continue;
    return src;
  }
  return null;
}

// Use an extracted content image as the thumbnail when the item has no explicit
// media thumbnail. Returns media (possibly augmented), or undefined.
function withImageFallback(media, rawContent) {
  if (media && media.thumbnail) return media;
  const img = firstImageIn(rawContent);
  if (!img) return media;
  return { ...(media || {}), thumbnail: img };
}

function mediaFor(item) {
  // RSS-ish: media:thumbnail / media:content / itunes:image / enclosure image.
  const thumb = item.child('thumbnail')?.attr('url')
    || item.kids('content').map((c) => (/(image)/i.test(c.attr('type') || c.attr('medium') || '') ? c.attr('url') : null)).find(Boolean)
    || item.child('image')?.attr('href');
  const enc = item.child('enclosure');
  const encType = enc?.attr('type') || '';
  const m = {};
  if (thumb) m.thumbnail = thumb;
  if (enc && /^audio\//i.test(encType)) m.audio_url = enc.attr('url');
  const dur = toSeconds(item.textOf('duration'));
  if (dur != null) m.duration_seconds = dur;
  return Object.keys(m).length ? m : undefined;
}

function rssItem(item, feed) {
  const link = item.textOf('link') || item.child('link')?.attr('href') || '';
  const guid = item.textOf('guid');
  const date = item.textOf('pubDate') || item.textOf('date') || item.textOf('published');
  const rawContent = item.textOf('encoded') || item.textOf('description') || item.textOf('summary');
  const enc = item.child('enclosure');
  const isPodcast = /^audio\//i.test(enc?.attr('type') || '');
  return {
    id: stableId(feed, [guid, link, item.textOf('title')]),
    feed_id: feed.id,
    url: link,
    title: item.textOf('title') || undefined,   // empty → makeItem synthesizes from the body (microblogs)
    author: item.textOf('creator') || item.textOf('author') || undefined,
    published_at: toEpoch(date),
    type: isPodcast ? 'podcast' : 'article',
    content: sanitizeHtml(rawContent, { allowImages: feed.images_allowed }),
    media: withImageFallback(mediaFor(item), rawContent),
  };
}

function atomEntry(entry, feed) {
  const links = entry.kids('link');
  const link = (links.find((l) => (l.attr('rel') || 'alternate') === 'alternate') || links[0])?.attr('href') || '';
  const id = entry.textOf('id');
  const date = entry.textOf('published') || entry.textOf('updated');
  const rawContent = entry.textOf('content') || entry.textOf('summary');
  return {
    id: stableId(feed, [id, link, entry.textOf('title')]),
    feed_id: feed.id,
    url: link,
    title: entry.textOf('title') || undefined,   // empty → makeItem synthesizes from the body (microblogs)
    author: entry.child('author')?.textOf('name') || undefined,
    published_at: toEpoch(date),
    type: 'article',
    content: sanitizeHtml(rawContent, { allowImages: feed.images_allowed }),
    media: withImageFallback(mediaFor(entry), rawContent),
  };
}

function jsonItem(it, top, feed) {
  const isPodcast = (it.attachments || []).some((a) => /^audio\//i.test(a.mime_type || ''));
  const audio = (it.attachments || []).find((a) => /^audio\//i.test(a.mime_type || ''));
  let media = {};
  if (it.image || it.banner_image) media.thumbnail = it.image || it.banner_image;
  if (audio) { media.audio_url = audio.url; if (audio.duration_in_seconds) media.duration_seconds = audio.duration_in_seconds; }
  media = withImageFallback(media, it.content_html) || media;
  return {
    id: stableId(feed, [it.id, it.url, it.title]),
    feed_id: feed.id,
    url: it.url || it.external_url || '',
    title: it.title || undefined,   // empty → makeItem synthesizes from the body (microblogs)
    author: (it.author && it.author.name) || (top.author && top.author.name) || (top.authors && top.authors[0] && top.authors[0].name) || undefined,
    published_at: toEpoch(it.date_published || it.date_modified),
    type: isPodcast ? 'podcast' : 'article',
    content: sanitizeHtml(it.content_html || (it.content_text ? escapeText(it.content_text) : ''), { allowImages: feed.images_allowed }),
    media: Object.keys(media).length ? media : undefined,
  };
}

function escapeText(t) {
  return `<p>${String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>')}</p>`;
}

// Parse feed text into { meta, items }. `opts.feed` supplies the id + flags;
// `opts.contentType` disambiguates JSON Feed when the body is ambiguous.
export function parseFeed(text, opts = {}) {
  const feed = opts.feed || { id: 'feed', images_allowed: false };
  const trimmed = String(text).replace(/^﻿/, '').trimStart();

  if ((opts.contentType || '').includes('json') || trimmed.startsWith('{')) {
    let obj; try { obj = JSON.parse(trimmed); } catch { obj = null; }
    if (obj && Array.isArray(obj.items)) {
      return { meta: { title: obj.title, site_url: obj.home_page_url }, items: obj.items.map((it) => jsonItem(it, obj, feed)) };
    }
  }

  const doc = parseXml(text).children[0];
  if (!doc) return { meta: {}, items: [] };

  if (doc.local === 'feed') {   // Atom
    return {
      meta: { title: doc.textOf('title'), site_url: (doc.kids('link').find((l) => (l.attr('rel') || 'alternate') === 'alternate') || doc.kids('link')[0])?.attr('href') },
      items: doc.findAll('entry').map((e) => atomEntry(e, feed)),
    };
  }
  // RSS 2.0 (channel/item) or RSS 1.0 / RDF (item siblings)
  const channel = doc.child('channel');
  return {
    meta: { title: channel?.textOf('title') || doc.textOf('title'), site_url: channel?.textOf('link') },
    items: doc.findAll('item').map((it) => rssItem(it, feed)),
  };
}

export const feedAdapter = {
  name: 'feed',
  match() { return true; },   // fallback; register last so specific adapters win

  async parse(response, feed) {
    const contentType = response.headers?.get?.('content-type') || '';
    const text = await response.text();
    return parseFeed(text, { feed, contentType }).items;
  },

  // Autodiscovery: find a feed <link> in a page's HTML (SPEC §3).
  detectFeedUrl(pageUrl, html) {
    const re = /<link\b[^>]*>/gi;
    let m;
    while ((m = re.exec(html))) {
      const tag = m[0];
      if (!/rel\s*=\s*["']?alternate/i.test(tag)) continue;
      if (!/type\s*=\s*["']?application\/(rss\+xml|atom\+xml|feed\+json|json)/i.test(tag)) continue;
      const href = tag.match(/href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i);
      const url = href && (href[2] || href[3] || href[4]);
      if (url) { try { return new URL(url, pageUrl).href; } catch { return url; } }
    }
    return null;
  },
};
