// OPML import/export (SPEC §9). Reuses the feed parser's XML reader. Folders
// (outlines without xmlUrl) become a feed's `category`; YouTube subscription
// feeds are flagged `kind:'youtube'` so the importer can offer the §10
// separation pass (a 1,249-entry export is typically ~1,088 YouTube subs).

import { parseXml } from './parse/xml.js';

const YT_RE = /youtube\.com\/feeds\/videos\.xml/i;

export function parseOpml(text) {
  const root = parseXml(text);
  const opml = root.children.find((c) => c.local === 'opml') || root;
  const body = opml.child('body') || opml;
  const feeds = [];

  (function walk(node, category) {
    for (const o of node.kids('outline')) {
      const xmlUrl = o.attr('xmlUrl');
      const title = o.attr('title') || o.attr('text') || xmlUrl || '(untitled)';
      if (xmlUrl) {
        feeds.push({
          xmlUrl,
          title,
          htmlUrl: o.attr('htmlUrl') || undefined,
          type: o.attr('type') || undefined,
          category: category || undefined,
          kind: YT_RE.test(xmlUrl) ? 'youtube' : 'feed',
        });
      }
      const children = o.kids('outline');
      if (children.length) walk(o, xmlUrl ? category : title);   // folder → its title is the category
    }
  })(body, null);

  return feeds;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Build an OPML document from stored Feed records (or parsed-feed shapes).
export function buildOpml(feeds, title = 'weir feeds') {
  const byCat = new Map();
  for (const f of feeds) {
    const cat = f.category || '';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(f);
  }
  const line = (f) => {
    const name = esc(f.name || f.title || f.url || f.xmlUrl);
    const xml = esc(f.url || f.xmlUrl);
    const html = (f.site_url || f.htmlUrl) ? ` htmlUrl="${esc(f.site_url || f.htmlUrl)}"` : '';
    return `<outline text="${name}" title="${name}" type="rss" xmlUrl="${xml}"${html}/>`;
  };
  let body = '';
  for (const [cat, list] of byCat) {
    if (cat) {
      body += `    <outline text="${esc(cat)}" title="${esc(cat)}">\n`;
      for (const f of list) body += `      ${line(f)}\n`;
      body += `    </outline>\n`;
    } else {
      for (const f of list) body += `    ${line(f)}\n`;
    }
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="1.0">\n  <head>\n    <title>${esc(title)}</title>\n  </head>\n  <body>\n${body}  </body>\n</opml>\n`;
}
