// Lightweight readability — pull the main article out of a fetched web page so
// truncated feeds can be read in full. Browser-only (uses DOMParser for robust
// HTML parsing; that's also where sanitization happens — script/handler/iframe
// removal on the live DOM, more reliable than the regex pass). Heuristic, not
// perfect: prefers <article>/<main>, else the densest low-link text block.

const KILL = 'script,style,noscript,iframe,object,embed,svg,form,nav,header,footer,aside,'
  + '[role=navigation],[role=complementary],[role=banner],[aria-hidden=true]';

export function extractArticle(html, baseUrl, opts = {}) {
  let doc;
  try { doc = new DOMParser().parseFromString(String(html), 'text/html'); } catch { return null; }
  return extractFromDoc(doc, baseUrl, opts);
}

export function extractFromDoc(doc, baseUrl, opts = {}) {
  doc.querySelectorAll(KILL).forEach((n) => n.remove());

  let best = doc.querySelector('article') || doc.querySelector('[role=main]') || doc.querySelector('main');
  if (!best) {
    let bestScore = 0;
    for (const el of doc.querySelectorAll('div, section')) {
      const len = (el.textContent || '').trim().length;
      if (len < 250) continue;
      const linkText = [...el.querySelectorAll('a')].reduce((s, a) => s + (a.textContent || '').length, 0);
      const linkDensity = len ? linkText / len : 1;
      if (linkDensity > 0.5) continue;            // a nav/list, not prose
      const score = len * (1 - linkDensity) + el.querySelectorAll('p').length * 25;
      if (score > bestScore) { bestScore = score; best = el; }
    }
  }
  if (!best) return null;

  // DOM sanitize: drop event handlers + dangerous URLs.
  for (const el of best.querySelectorAll('*')) {
    for (const attr of [...el.attributes]) {
      if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
      else if (/^(href|src|srcset)$/i.test(attr.name) && /^\s*(javascript|vbscript|data):/i.test(attr.value)) el.removeAttribute(attr.name);
    }
  }
  // Resolve relative links/images against the article URL; open links in a tab.
  for (const a of best.querySelectorAll('a[href]')) { try { a.setAttribute('href', new URL(a.getAttribute('href'), baseUrl).href); a.setAttribute('target', '_blank'); a.setAttribute('rel', 'noopener'); } catch { /* bad href */ } }
  for (const img of best.querySelectorAll('img[src]')) { try { img.setAttribute('src', new URL(img.getAttribute('src'), baseUrl).href); } catch { /* bad src */ } img.removeAttribute('srcset'); }
  // Image policy (same as the feed sanitizer): suppress unless allowed.
  if (!opts.allowImages) {
    for (const img of best.querySelectorAll('img[src]')) { img.setAttribute('data-weir-src', img.getAttribute('src')); img.removeAttribute('src'); }
  }

  const out = best.innerHTML.trim();
  return out.length > 60 ? out : null;
}
