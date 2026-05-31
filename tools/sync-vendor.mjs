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
// NOTE: vfs.js / switchboard / bridge-client.js are vendored separately (vfs from
// a built bundle, bridge from the ../bridge repo) — see vendor/PROVENANCE.md.
// Add `['ext/librarian/index.js', 'librarian.js']` here once librarian v2 lands.
const FILES = [
  // ['ext/librarian/index.js', 'librarian.js'],   // enable when @gcu/librarian v2 ships (see PROVENANCE)
];

if (FILES.length === 0) {
  console.log('sync-vendor: no files enabled yet (librarian v2 pending). Pipe is set up;');
  console.log('             uncomment the librarian row in FILES and re-run when it lands.');
  process.exit(0);
}

const banner = '// VENDORED from the auditable repo — do not edit here.\n'
  + '// Re-sync: node tools/sync-vendor.mjs\n';
for (const [src, dest] of FILES) {
  const p = path.join(aud, src);
  if (!fs.existsSync(p)) { console.warn('skip (missing upstream):', src); continue; }
  const body = fs.readFileSync(p, 'utf8');
  fs.writeFileSync(path.join(root, 'vendor', dest), banner + body);
  console.log('vendored', dest, '(' + (body.length / 1024).toFixed(0) + ' KB)');
}
console.log('→ vendor/ synced from', path.relative(root, aud) || aud);
