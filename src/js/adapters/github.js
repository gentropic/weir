// The `github` adapter — repo releases / commits / tags via GitHub's native
// Atom feeds (no API, no auth). A friendly `github.com/{owner}/{repo}` resolves
// (pure string, no fetch) to `…/releases.atom` by default, or `…/commits.atom`
// / `…/tags.atom` when the path says so; a bare `github.com/{owner}` → that
// user/org's activity feed. Maps entries to `release` / `commit` items.
// Registered before `feed` so it wins for github.com URLs.

import { parseXml } from '../parse/xml.js';
import { sanitizeHtml } from '../parse/sanitize.js';

function ghEpoch(s) { if (!s) return undefined; const t = Date.parse(String(s).trim()); return Number.isNaN(t) ? undefined : t; }

// github.com/{owner}[/{repo}[/{section}]] → matching .atom URL, or null if the
// input is already an .atom feed (nothing to resolve).
export function githubFeedUrl(url) {
  const u = String(url).trim();
  if (/\.atom(\?|#|$)/i.test(u)) return null;
  const m = u.match(/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/([A-Za-z0-9][A-Za-z0-9._-]*))?(?:\/([A-Za-z0-9._/-]*))?/i);
  if (!m) return null;
  const owner = m[1];
  let repo = m[2];
  const sec = (m[3] || '').toLowerCase();
  if (!repo) return `https://github.com/${owner}.atom`;
  repo = repo.replace(/\.git$/i, '');
  if (sec.startsWith('commits')) return `https://github.com/${owner}/${repo}/commits.atom`;
  if (sec.startsWith('tags')) return `https://github.com/${owner}/${repo}/tags.atom`;
  return `https://github.com/${owner}/${repo}/releases.atom`;
}

// A readable feed name from the source URL: "owner/repo releases", "owner/repo
// commits", or "owner (github)" for an activity feed.
export function githubName(url) {
  const m = String(url).match(/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/([A-Za-z0-9][A-Za-z0-9._-]*))?(?:\/([A-Za-z0-9._/-]*))?/i);
  if (!m) return null;
  const owner = m[1];
  let repo = m[2];
  if (!repo) return `${owner} (github)`;
  repo = repo.replace(/\.(git|atom)$/i, '');
  const sec = (m[3] || '').toLowerCase();
  const kind = sec.startsWith('commits') ? ' commits' : sec.startsWith('tags') ? ' tags' : ' releases';
  return `${owner}/${repo}${kind}`;
}

// Which weir item type a github feed produces, from its URL.
function kindFromUrl(url) {
  if (/\/commits(?:\/[^?#]*)?\.atom/i.test(url)) return 'commit';
  if (/\/(?:releases|tags)\.atom/i.test(url)) return 'release';
  return 'status';   // user/org activity feed
}

export function parseGithub(text, opts = {}) {
  const feed = opts.feed || { id: 'github', images_allowed: false };
  const doc = parseXml(text).children[0];
  if (!doc || doc.local !== 'feed') return { meta: {}, items: [] };   // not an Atom feed (e.g. a repo HTML page)

  const type = kindFromUrl(feed.url || '');
  const repo = (String(feed.url || '').match(/github\.com\/([A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*)/i) || [])[1];
  const meta = { title: doc.textOf('title'), site_url: doc.kids('link').find((l) => (l.attr('rel') || 'alternate') === 'alternate')?.attr('href') };

  const items = doc.findAll('entry').map((e) => {
    const id = e.textOf('id') || '';
    const link = (e.kids('link').find((l) => (l.attr('rel') || 'alternate') === 'alternate') || e.kids('link')[0])?.attr('href') || '';
    const tail = (id.match(/[/:]([^/:]+)$/) || [])[1];   // tag name or commit sha
    return {
      id: `${feed.id}:${id || link}`,
      feed_id: feed.id,
      url: link,
      title: e.textOf('title') || '(untitled)',
      author: e.child('author')?.textOf('name') || undefined,
      published_at: ghEpoch(e.textOf('updated') || e.textOf('published')),
      type,
      content: sanitizeHtml(e.textOf('content') || '', { allowImages: feed.images_allowed }),
      structured: {
        repo: repo || undefined,
        ref: tail ? (type === 'commit' ? tail.slice(0, 7) : tail) : undefined,
      },
    };
  });
  return { meta, items };
}

export const githubAdapter = {
  name: 'github',
  match(url) {
    try {
      const h = new URL(/^[a-z]+:\/\//i.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, '');
      return h === 'github.com';   // not gist.github.com / *.github.io
    } catch { return false; }
  },
  // Add-time: rewrite a repo/user URL to its .atom feed (no fetch needed).
  resolveUrl(url) { return githubFeedUrl(url); },
  // Add-time: a friendly default name.
  titleFor(url) { return githubName(url); },
  async parse(response, feed) { return parseGithub(await response.text(), { feed }).items; },
  // Safety net (OPML / pasted repo URL polled before resolution): a github repo
  // page parses to 0 items, and the poller asks us for the real feed URL.
  detectFeedUrl(pageUrl) { return githubFeedUrl(pageUrl); },
};
