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

const ROOT = __dirname;
const SRC = path.join(ROOT, 'src');
const VENDOR = path.join(ROOT, 'vendor');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BUILD_DATE = new Date().toISOString().slice(0, 10);

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
  for (const relPath of importPaths) {
    const filePath = path.resolve(moduleDir, relPath);
    if (seen.has(filePath)) continue;
    seen.add(filePath);
    if (!fs.existsSync(filePath)) {
      console.error(`Error: import not found: ${relPath} (from ${path.relative(ROOT, mainPath)})`);
      process.exit(1);
    }
    const label = path.relative(ROOT, filePath).replace(/\\/g, '/');
    chunks.push(`// ── ${label} ──\n\n${stripModuleSyntax(fs.readFileSync(filePath, 'utf8'))}`);
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
  const style = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8');
  return [buildFontFaceCss(), tokens.trim(), style.trim()].join('\n\n');
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

// ── Build ──────────────────────────────────────────────────────────────────

let js = processModules(path.join(SRC, 'js', 'main.js'), path.join(SRC, 'js'));
js = js
  .replace(/__WEIR_VERSION__/g, pkg.version || '0.0.0')
  .replace(/__WEIR_BUILD_DATE__/g, BUILD_DATE);

const css = buildCss();
const template = fs.readFileSync(path.join(SRC, 'template.html'), 'utf8');

const html = `<!DOCTYPE html>
<!-- @gcu/weir ${pkg.version} — a unified reader for timestamped streams. -->
<!-- Built ${BUILD_DATE} from src/ via build.js. https://github.com/gentropic/weir -->
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
console.log(`Built index.html (${kb} KB)`);
