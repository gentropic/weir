// The `youtube` adapter — channel feeds (youtube.com/feeds/videos.xml?channel_id=…)
// and channel/@handle/watch page URLs (resolved to a feed via detectFeedUrl).
// YouTube feeds are Atom with yt:/media: extensions; this maps them to `video`
// items with thumbnails + channel + view count. Registered before `feed` so it
// wins for YouTube URLs. (YouTube feeds carry no duration — that field stays empty.)

import { parseXml } from '../parse/xml.js';

function ytEpoch(s) { if (!s) return undefined; const t = Date.parse(String(s).trim()); return Number.isNaN(t) ? undefined : t; }

function descToHtml(t) {
  if (!t) return '';
  return '<p>' + String(t)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\n{2,}/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
}

export function parseYoutube(text, opts = {}) {
  const feed = opts.feed || { id: 'youtube' };
  const doc = parseXml(text).children[0];
  if (!doc || doc.local !== 'feed') return { meta: {}, items: [] };   // not a YouTube feed (e.g. a channel HTML page)

  const meta = { title: doc.textOf('title'), site_url: doc.child('author')?.textOf('uri') };
  const items = doc.findAll('entry').map((e) => {
    const videoId = e.textOf('videoId') || (e.textOf('id') || '').replace(/^yt:video:/, '');
    const link = (e.kids('link').find((l) => (l.attr('rel') || 'alternate') === 'alternate') || e.kids('link')[0])?.attr('href')
      || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : '');
    const group = e.child('group');
    const views = group?.child('community')?.child('statistics')?.attr('views');
    return {
      id: `${feed.id}:${videoId || link}`,
      feed_id: feed.id,
      url: link,
      title: e.textOf('title') || group?.textOf('title') || undefined,
      author: e.child('author')?.textOf('name') || undefined,
      published_at: ytEpoch(e.textOf('published') || e.textOf('updated')),
      type: 'video',
      content: descToHtml(group?.textOf('description')),
      media: { thumbnail: group?.child('thumbnail')?.attr('url') || undefined },
      structured: {
        video_id: videoId || undefined,
        channel_id: e.textOf('channelId') || undefined,
        views: views ? Number(views) : undefined,
      },
    };
  });
  return { meta, items };
}

export const youtubeAdapter = {
  name: 'youtube',
  match(url) { return /(?:youtube\.com|youtu\.be)/i.test(String(url)); },

  async parse(response, feed) { return parseYoutube(await response.text(), { feed }).items; },

  // Resolve a channel/@handle/watch URL to its feed URL by pulling the channel id
  // out of the page (the poller calls this when a non-feed page yields 0 items).
  detectFeedUrl(pageUrl, html) {
    let id = (String(pageUrl).match(/\/channel\/(UC[\w-]+)/) || [])[1];
    if (!id) id = (String(html).match(/"(?:channelId|externalId)"\s*:\s*"(UC[\w-]+)"/) || [])[1];
    if (!id) id = (String(html).match(/\/channel\/(UC[\w-]+)/) || [])[1];
    return id ? `https://www.youtube.com/feeds/videos.xml?channel_id=${id}` : null;
  },
};
