// Pragmatic v0.1 HTML sanitizer (SPEC §2 — strip scripts, event handlers, and
// javascript: URLs at parse time; stored content is then trusted at render).
//
// NOTE: this is a deliberately small string-based pass, not a DOM-grade
// sanitizer. It covers the vectors SPEC names for a single-user local tool. A
// DOMParser/DOMPurify-grade pass should replace it before any shared/multi-user
// scenario — tracked as a follow-up. Image src suppression (SPEC §2) moves the
// src to data-weir-src so the renderer can offer a per-item "load images" verb.

export function sanitizeHtml(html, opts = {}) {
  if (!html) return '';
  let s = String(html);

  s = s.replace(/<script[\s\S]*?<\/script\s*>/gi, '');
  s = s.replace(/<style[\s\S]*?<\/style\s*>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  // <iframe>/<object>/<embed> — drop the open tags (and close where present).
  s = s.replace(/<\/?(?:iframe|object|embed|link|meta|base)\b[^>]*>/gi, '');
  // inline event handlers:  onclick="…"  onload='…'  onerror=…
  s = s.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  // javascript:/data: in href/src — neutralize to a harmless anchor
  s = s.replace(/\b(href|src)\s*=\s*("|')\s*(?:javascript|data|vbscript):[^"']*\2/gi, '$1=$2#$2');

  if (!opts.allowImages) {
    s = s.replace(/<img\b([^>]*?)\ssrc\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)([^>]*)>/gi,
      (m, pre, src, post) => `<img${pre} data-weir-src=${src}${post}>`);
  }

  return s.trim();
}
