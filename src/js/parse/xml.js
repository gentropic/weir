// Minimal, tolerant XML parser (SPEC §3 — "bundle a minimal parser, accept
// malformed XML pragmatically"). No DOMParser dependency, so it runs in node
// tests and the browser bundle alike. Not spec-complete: it ignores the XML
// declaration/DOCTYPE/PIs, treats CDATA as raw text, decodes the common
// entities, and is forgiving about mismatched close tags. Good enough for feeds.

export function decodeEntities(s) {
  if (!s || s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, e) => {
    if (e[0] === '#') {
      const code = (e[1] === 'x' || e[1] === 'X') ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      try { return Number.isFinite(code) ? String.fromCodePoint(code) : m; } catch { return m; }
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
    return e in named ? named[e] : m;
  });
}

// A parsed element. `name` keeps the prefix (e.g. "content:encoded"); `local`
// is the part after the colon, which is what the accessors match on so callers
// don't have to care about namespace prefixes.
export class XmlNode {
  constructor(name) {
    this.name = name;
    const c = name.indexOf(':');
    this.local = c >= 0 ? name.slice(c + 1) : name;
    this.prefix = c >= 0 ? name.slice(0, c) : '';
    this.attrs = {};
    this.children = [];
    this.parts = [];   // text fragments owned directly by this element
  }

  get text() {
    let t = this.parts.join('');
    for (const c of this.children) t += c.text;
    return t.trim();
  }

  child(local) { for (const c of this.children) if (c.local === local) return c; return null; }
  kids(local) { return this.children.filter((c) => c.local === local); }
  textOf(local) { const c = this.child(local); return c ? c.text : ''; }

  attr(name) {
    if (name in this.attrs) return this.attrs[name];
    for (const k in this.attrs) { const c = k.indexOf(':'); if (c >= 0 && k.slice(c + 1) === name) return this.attrs[k]; }
    return undefined;
  }

  find(local) {
    for (const c of this.children) { if (c.local === local) return c; const f = c.find(local); if (f) return f; }
    return null;
  }
  findAll(local, acc = []) {
    for (const c of this.children) { if (c.local === local) acc.push(c); c.findAll(local, acc); }
    return acc;
  }
}

function parseAttrs(s, out) {
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(s))) {
    const val = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : (m[5] || '');
    out[m[1]] = decodeEntities(val);
  }
}

// Returns a synthetic #root node; the feed's document element is root.children[0].
export function parseXml(input) {
  const s = String(input).replace(/^﻿/, '');
  const root = new XmlNode('#root');
  const stack = [root];
  const n = s.length;
  let i = 0;

  while (i < n) {
    const lt = s.indexOf('<', i);
    if (lt < 0) { const txt = s.slice(i); if (txt.trim()) stack[stack.length - 1].parts.push(decodeEntities(txt)); break; }
    if (lt > i) { const txt = s.slice(i, lt); if (txt) stack[stack.length - 1].parts.push(decodeEntities(txt)); }

    if (s.startsWith('<!--', lt)) { const e = s.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (s.startsWith('<![CDATA[', lt)) {
      const e = s.indexOf(']]>', lt + 9);
      stack[stack.length - 1].parts.push(e < 0 ? s.slice(lt + 9) : s.slice(lt + 9, e));
      i = e < 0 ? n : e + 3; continue;
    }
    if (s.startsWith('<!', lt)) { const e = s.indexOf('>', lt); i = e < 0 ? n : e + 1; continue; }   // DOCTYPE etc.
    if (s.startsWith('<?', lt)) { const e = s.indexOf('?>', lt); i = e < 0 ? n : e + 2; continue; }   // PI / xml decl

    const gt = s.indexOf('>', lt);
    if (gt < 0) break;
    let inner = s.slice(lt + 1, gt);
    i = gt + 1;

    if (inner[0] === '/') {
      const closeName = inner.slice(1).trim().split(/[\s/]/)[0];
      for (let k = stack.length - 1; k > 0; k--) { if (stack[k].name === closeName) { stack.length = k; break; } }
      continue;
    }

    const selfClose = inner.endsWith('/');
    if (selfClose) inner = inner.slice(0, -1);
    const m = inner.match(/^\s*([^\s>]+)([\s\S]*)$/);
    if (!m) continue;
    const node = new XmlNode(m[1]);
    parseAttrs(m[2], node.attrs);
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
  }

  return root;
}
