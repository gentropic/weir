#!/usr/bin/env node
// Zero-dependency build for @gcu/weir.
//
// Dev workflow: edit files under src/, run `node build.js`, open index.html.
// The single-file index.html IS the artifact — there is no separate dev page.
//
// What it does (mirrors the tool targets in auditable/build.js):
//   1. Inlines src/js/ modules — src/js/main.js is an ordered import manifest;
//      each relative import is read, its import/export syntax stripped, and the
//      bodies concatenated in order. The vendored VFS bundle is pulled in the
//      same way (its `export {…}` line stripped, names left in scope).
//   2. Inlines vendor/switchboard/tokens.css + src/style.css, replacing the
//      @font-face url() rules with base64 data: URLs so the output is offline +
//      truly single-file.
//   3. Injects build metadata (version, date) and a vendored-licenses note.
//   4. Wraps template.html + CSS + JS into one self-contained index.html.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const VENDOR = path.join(ROOT, 'vendor');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
// Empty by default so `node build.js` is deterministic (same src → same
// index.html, no daily churn in git). Set WEIR_BUILD_DATE=YYYY-MM-DD for releases.
const BUILD_DATE = process.env.WEIR_BUILD_DATE || '';

// ── Module inliner ────────────────────────────────────────────────────────

function stripModuleSyntax(src) {
  // import … from '…';   and   import '…';   (side-effect) — tolerate a
  // trailing // line comment after the statement (main.js annotates its imports).
  src = src.replace(/^import\b[\s\S]*?from\s+['"][^'"]*['"];?[ \t]*(?:\/\/[^\n]*)?$/gm, '');
  src = src.replace(/^import\s+['"][^'"]*['"];?[ \t]*(?:\/\/[^\n]*)?$/gm, '');
  // export <decl> → <decl>
  src = src.replace(/^export function /gm, 'function ');
  src = src.replace(/^export async function /gm, 'async function ');
  src = src.replace(/^export const /gm, 'const ');
  src = src.replace(/^export let /gm, 'let ');
  src = src.replace(/^export class /gm, 'class ');
  // export { … };   and   export default …
  src = src.replace(/^export\s*\{[\s\S]*?\}\s*;?\s*$/gm, '');
  src = src.replace(/^export\s+default\s+.*$/gm, '');
  return src.replace(/^\n+/, '').replace(/\n+$/, '');
}

// Guard against the OTHER flat-concatenation footgun: an ALIASED or NAMESPACE import
// (`import { emit as yamlEmit }`, `import * as Y`). stripModuleSyntax deletes the
// import line and leaves names resolving against the inlined globals BY NAME — so the
// alias `yamlEmit` / namespace `Y` is an undefined reference in the bundle. It works
// under node ESM (real import bindings), so smoke tests pass while the browser throws
// "X is not defined" at runtime (bit the Stacks save path). Aliasing is NEVER valid
// here: import the real exported name (collisions → the duplicate-decl guard).
function collectAliasedImports(rawSrc, label, out) {
  const importRe = /^import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"]/gm;
  let m;
  while ((m = importRe.exec(rawSrc))) {
    const clause = m[1];
    const oneLine = clause.replace(/\s+/g, ' ').trim();
    if (/\*\s+as\s+/.test(clause)) out.push(`  ${label}: namespace import "${oneLine}" — becomes undefined in the flat bundle`);
    else if (/\{/.test(clause) && /\bas\b/.test(clause)) out.push(`  ${label}: aliased import "${oneLine}" — the alias is undefined in the flat bundle; use the real name`);
  }
}

// Read main.js, follow its relative imports in declared order, inline each.
// main.js is a manifest only — its own (post-strip) body, if any, runs last.
function processModules(mainPath, moduleDir) {
  const mainSrc = fs.readFileSync(mainPath, 'utf8');
  const importPaths = [];
  for (const rawLine of mainSrc.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    const m = line.match(/^import\s+.*['"](\.\.?\/.+?)['"];?\s*(?:\/\/.*)?$/);
    if (m) importPaths.push(m[1]);
  }
  const chunks = [];
  const seen = new Set();
  const aliased = [];
  collectAliasedImports(mainSrc, 'src/js/main.js', aliased);
  for (const relPath of importPaths) {
    const filePath = path.resolve(moduleDir, relPath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (!fs.existsSync(filePath)) {
      console.error(`Error: import not found: ${relPath} (from ${path.relative(ROOT, mainPath)})`);
      process.exit(1);
    }
    const label = path.relative(ROOT, filePath).replace(/\\/g, '/');
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!label.startsWith('vendor/')) collectAliasedImports(raw, label, aliased);   // vendored bundles are self-contained
    chunks.push(`// ── ${label} ──\n\n${stripModuleSyntax(raw)}`);
  }
  if (aliased.length) {
    console.error(`Error: aliased/namespace imports don't survive the flat-concat build —\n${aliased.join('\n')}`);
    process.exit(1);
  }
  const mainBody = stripModuleSyntax(mainSrc);
  if (mainBody.trim()) chunks.push(`// ── src/js/main.js ──\n\n${mainBody}`);
  return chunks.join('\n\n');
}

// ── Fonts: base64 @font-face blocks (offline, single-file) ─────────────────

const FONT_FACES = [
  { file: 'barlow-400.woff2',      family: 'Barlow',     weight: 400, style: 'normal' },
  { file: 'barlow-500.woff2',      family: 'Barlow',     weight: 500, style: 'normal' },
  { file: 'barlow-600.woff2',      family: 'Barlow',     weight: 600, style: 'normal' },
  { file: 'barlow-700.woff2',      family: 'Barlow',     weight: 700, style: 'normal' },
  { file: 'space-mono-400.woff2',  family: 'Space Mono', weight: 400, style: 'normal' },
  { file: 'space-mono-400i.woff2', family: 'Space Mono', weight: 400, style: 'italic' },
  { file: 'space-mono-700.woff2',  family: 'Space Mono', weight: 700, style: 'normal' },
];

function buildFontFaceCss() {
  const fontsDir = path.join(VENDOR, 'switchboard', 'fonts');
  const blocks = [];
  for (const f of FONT_FACES) {
    const p = path.join(fontsDir, f.file);
    if (!fs.existsSync(p)) { console.warn(`font missing: ${f.file}`); continue; }
    const b64 = fs.readFileSync(p).toString('base64');
    blocks.push(
      `@font-face{font-family:'${f.family}';font-weight:${f.weight};`
      + `font-style:${f.style};font-display:swap;`
      + `src:url(data:font/woff2;base64,${b64}) format('woff2');}`);
  }
  return blocks.join('\n');
}

// ── CSS assembly ───────────────────────────────────────────────────────────

function buildCss() {
  let tokens = fs.readFileSync(path.join(VENDOR, 'switchboard', 'tokens.css'), 'utf8');
  // Drop the url()-based @font-face rules; we re-add them base64-inlined.
  tokens = tokens.replace(/@font-face\s*\{[^}]*\}\s*/g, '');
  const railsCss = fs.readFileSync(path.join(VENDOR, 'rails.css'), 'utf8');   // structural; the .rails-* theme lives in style.css
  const style = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
  return [buildFontFaceCss(), tokens.trim(), railsCss.trim(), style.trim()].join('\n\n');
}

// ── Vendored-licenses note (OFL attribution travels with the fonts) ─────────

function licensesComment() {
  const manifestPath = path.join(ROOT, 'vendor-licenses.json');
  if (!fs.existsSync(manifestPath)) return '';
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const lines = ['Vendored components bundled into this file:'];
  for (const [name, e] of Object.entries(manifest.vendored || {})) {
    lines.push(`  - ${name}${e.version ? ' ' + e.version : ''} — ${e.spdx || 'UNKNOWN'}${e.note ? ' (' + e.note + ')' : ''}`);
  }
  return `<!--\n${lines.join('\n')}\n-->\n`;
}

// Guard against the flat-concatenation footgun: every module is inlined into one
// classic-script scope, so two modules declaring the same top-level name collide.
// A duplicate `let`/`const`/`class` is a hard SyntaxError that crashes the whole
// app on load; a duplicate `function` silently lets the last definition win
// (shadowing). We only inspect column-0 declarations — the convention for
// top-level names here — which is exactly where past collisions (_el, escapeText)
// lived. (Multi-declarator lines like `let a, b` are matched by their first name.)
function checkDuplicateDecls(js) {
  const decls = new Map();   // name → [{ kind, file }]
  let file = 'src/js/main.js';
  for (const line of js.split('\n')) {
    // Only build's own chunk markers (real .js paths) start a file; vendored
    // bundles carry their own `// ── section ──` comments that must not count.
    const fm = line.match(/^\/\/ ── (\S+\.js) ──/);
    if (fm) { file = fm[1]; continue; }
    // Vendored bundles are self-contained (own scope/IIFE); a line-based scan
    // can't see their nesting, so trust them and only police our own source.
    if (file.startsWith('vendor/')) continue;
    const m = line.match(/^(?:export\s+)?(?:async\s+)?(const|let|class|function)\s+([A-Za-z_$][\w$]*)/);
    if (!m) continue;
    (decls.get(m[2]) || decls.set(m[2], []).get(m[2])).push({ kind: m[1], file });
  }
  const fatal = [], warn = [];
  for (const [name, sites] of decls) {
    if (sites.length < 2) continue;
    const where = sites.map((s) => `${s.kind} @ ${s.file}`).join(', ');
    if (sites.some((s) => s.kind !== 'function')) fatal.push(`  '${name}' — ${where}`);
    else warn.push(`  '${name}' redeclared (last wins, shadowing risk) — ${where}`);
  }
  if (warn.length) console.warn(`⚠ build: top-level function shadowing —\n${warn.join('\n')}`);
  if (fatal.length) {
    console.error(`Error: duplicate top-level lexical declarations would crash the bundle —\n${fatal.join('\n')}\nRename one of each pair to a unique global.`);
    process.exit(1);
  }
}

// ── Build ──────────────────────────────────────────────────────────────────

let js = processModules(path.join(SRC, 'js', 'main.js'), path.join(SRC, 'js'));
checkDuplicateDecls(js);

const css = buildCss();
// Build id = short content hash of the bundle. A git SHA can't go here (a commit
// can't contain its own hash), so we hash the code itself: deterministic, changes
// on every meaningful rebuild, and lets the footer be verified against what I
// report. Hashed BEFORE placeholder substitution so it's a pure function of source.
const buildId = crypto.createHash('sha256').update(js + css).digest('hex').slice(0, 7);
js = js
  .replace(/__WEIR_VERSION__/g, pkg.version || '0.0.0')
  .replace(/__WEIR_BUILD_DATE__/g, BUILD_DATE)
  .replace(/__WEIR_COMMIT__/g, buildId);
const template = fs.readFileSync(path.join(SRC, 'template.html'), 'utf8');

const html = `<!DOCTYPE html>
<!-- @gcu/weir ${pkg.version}${BUILD_DATE ? ` (${BUILD_DATE})` : ''} — a unified reader for timestamped streams. -->
<!-- Built from src/ via build.js. https://github.com/gentropic/weir -->
${licensesComment()}<html lang="en" data-theme="dark">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>@gcu/weir</title>
<link rel="manifest" href="./manifest.webmanifest">
<meta name="theme-color" content="#D4672E">
<link rel="icon" type="image/svg+xml" href="./icon.svg">
<style>
${css}
</style>
</head>
<body>

${template}

<script>
${js}
</script>
</body>
</html>
`;

const outPath = path.join(ROOT, 'index.html');
fs.writeFileSync(outPath, html);
const kb = (fs.statSync(outPath).size / 1024).toFixed(1);
console.log(`Built index.html (${kb} KB) — build ${buildId}`);

// Stamp the build id into the service-worker cache name so each meaningful build
// auto-busts the SW cache — no manual bump, no forgetting. `buildId` is the bundle
// (js+css) content hash, so a content-only deploy (data lives in the VFS, not the
// cache) leaves it unchanged and won't churn returning clients.
const swPath = path.join(ROOT, 'sw.js');
const sw = fs.readFileSync(swPath, 'utf8');
const swNew = sw.replace(/const CACHE = 'weir-shell-[^']*';/, `const CACHE = 'weir-shell-${buildId}';`);
if (swNew !== sw) { fs.writeFileSync(swPath, swNew); console.log(`Stamped sw.js cache → weir-shell-${buildId}`); }
