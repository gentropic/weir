// sync-vendor.mjs — vendor zero-dep ESM libs from the sibling `auditable` repo
// into vendor/. weir vendors @gcu/* as SOURCE (no npm); this keeps the copies in
// sync with canon. Upstream-first: fix in auditable, then re-run this.
//
//   node tools/sync-vendor.mjs            # auto-locates ../auditable
//   node tools/sync-vendor.mjs <path>     # explicit auditable repo path
//
// Per the librarian vendoring contract (auditable/ext/librarian/SPEC.md §
// "Vendoring"): never hand-edit the vendored copy. One librarian, everywhere.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const aud = path.resolve(process.argv[2] || path.join(root, '..', 'auditable'));
if (!fs.existsSync(path.join(aud, 'ext'))) {
  console.error('sync-vendor: no auditable repo at', aud, '\n  pass its path: node tools/sync-vendor.mjs <path-to-auditable>');
  process.exit(1);
}

// upstream (in auditable) → vendored name (in weir/vendor/). Standalone ESM only
// (zero relative imports), so the build can inline them directly.
// NOTE: vfs.js / switchboard / accountable-client.js are vendored separately (vfs from
// a built bundle, accountable from the ../accountable repo) — see vendor/PROVENANCE.md.
// Add `['ext/librarian/index.js', 'librarian.js']` here once librarian v2 lands.
// [src, dest, wrap?] — `wrap` is the single export symbol to expose; when set,
// the module body is enclosed in an IIFE so its (generic) internal names don't
// leak into weir's single-file (flat-concat) scope and collide. librarian's
// bundle has names like `search`/`index`/`scan`, so it MUST be wrapped.
const FILES = [
  ['ext/librarian/index.js', 'librarian.js', 'Librarian'],   // @gcu/librarian v2 (unified CSR engine) — shipped 2026-06-01
];

if (FILES.length === 0) {
  console.log('sync-vendor: no files enabled yet (librarian v2 pending). Pipe is set up;');
  console.log('             uncomment the librarian row in FILES and re-run when it lands.');
  process.exit(0);
}

const banner = '// VENDORED from the auditable repo — do not edit here.\n'
  + '// Re-sync: node tools/sync-vendor.mjs\n';
for (const [src, dest, wrap] of FILES) {
  const p = path.join(aud, src);
  if (!fs.existsSync(p)) { console.warn('skip (missing upstream):', src); continue; }
  let body = fs.readFileSync(p, 'utf8');
  // Neutralize the bundle's `// ── file.js ──` section comments: weir's build inlines
  // each module under that exact marker and its duplicate-decl guard SKIPS vendored
  // regions by tracking it (build.js checkDuplicateDecls). A vendored bundle that uses
  // the same em-dash marker masquerades as a real chunk → the guard starts policing the
  // bundle's internals and false-collides (e.g. its STOPWORDS vs weir's health.js). Drop
  // the box-drawing dashes to '--' so only weir's own markers match. (Comment-only edit.)
  body = body.replace(/─/g, '-');
  if (wrap) {
    // Drop the upstream export(s), enclose the body in an IIFE, and re-export only
    // `Sym` — so the flat-concat build introduces just that one top-level name (its
    // internals stay scoped inside the IIFE). The bundle's block re-export can be
    // multiline / trailing-comma / multi-symbol (`export {\n  Librarian,\n};`), and an
    // inner `export` is illegal once wrapped in a function (breaks standalone ESM import),
    // so strip ALL block exports + any `export ` decl-prefixes — not just `export { Sym };`.
    body = body.replace(/export\s*\{[\s\S]*?\}\s*;?/g, '');
    body = body.replace(/^[ \t]*export\s+(?=(?:async\s+)?(?:function|const|let|class)\b)/gm, '');
    body = `// wrapped at vendor time so its internals don't collide in weir's single-file build.\n`
      + `export const ${wrap} = (function () {\n${body}\nreturn ${wrap};\n})();\n`;
  }
  fs.writeFileSync(path.join(root, 'vendor', dest), banner + body);
  console.log('vendored', dest, '(' + (body.length / 1024).toFixed(0) + ' KB)' + (wrap ? ` [wrapped → ${wrap}]` : ''));
}
console.log('→ vendor/ synced from', path.relative(root, aud) || aud);
