// e2e-layout — real-browser check that the layout resolver + [data-layout] CSS render correctly.
// Loads the BUILT index.html in Chromium at several viewport widths (and with forced overrides)
// and asserts the effective layout + key computed styles. Catches a class of regression the
// node-only `npm run smoke` can't (CSS nesting support, the head resolver, the breakpoints).
//
// Uses Playwright (a devDependency) + the globally-cached Chromium. LOCAL test, not part of the
// zero-dep `npm run smoke`.  Run: npm run e2e:layout   (rebuilds first, so it tests current src).
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const indexHtml = path.join(here, '..', 'index.html');

// Always test current src.
execSync('node build.js', { cwd: path.join(here, '..'), stdio: 'ignore' });
const url = pathToFileURL(indexHtml).href;

const browser = await chromium.launch();
let failed = 0;

// label, viewport, forced-mode (null = auto), and the expected effective layout + chrome shape.
const cases = [
  { label: 'phone (auto)',            w: 390,  h: 800,  force: null,        layout: 'reader',    cols: 1, botnav: 'flex', statusbar: 'none' },
  { label: 'tablet portrait (auto)',  w: 900,  h: 1280, force: null,        layout: 'tablet',    cols: 1, botnav: 'flex', statusbar: 'none' },
  { label: 'desktop (auto)',          w: 1400, h: 900,  force: null,        layout: 'workspace', cols: 2, botnav: 'none', statusbar: 'flex' },
  { label: 'phone forced workspace',  w: 390,  h: 800,  force: 'workspace', layout: 'workspace', cols: 2, botnav: 'none', statusbar: 'flex' },
  { label: 'desktop forced reader',   w: 1400, h: 900,  force: 'reader',    layout: 'reader',    cols: 1, botnav: 'flex', statusbar: 'none' },
];

for (const c of cases) {
  const page = await browser.newPage({ viewport: { width: c.w, height: c.h } });
  if (c.force) await page.addInitScript((m) => { try { localStorage.setItem('weir-layout', m); } catch { /* */ } }, c.force);
  await page.goto(url);
  await page.waitForTimeout(300);
  const got = await page.evaluate(() => {
    const cs = (sel, prop) => { const e = document.querySelector(sel); return e ? getComputedStyle(e)[prop] : 'NO-EL'; };
    return {
      layout: document.documentElement.dataset.layout,
      cols: cs('.app', 'gridTemplateColumns').split(/\s+/).filter(Boolean).length,
      botnav: cs('.botnav', 'display'),
      statusbar: cs('.statusbar', 'display'),
    };
  });
  await page.close();
  try {
    assert.equal(got.layout, c.layout, `${c.label}: data-layout`);
    assert.equal(got.cols, c.cols, `${c.label}: .app column count`);
    assert.equal(got.botnav, c.botnav, `${c.label}: bottom nav display`);
    assert.equal(got.statusbar, c.statusbar, `${c.label}: status bar display`);
    console.log(`  ok  ${c.label.padEnd(24)} → ${got.layout}, ${got.cols}-col, botnav:${got.botnav}`);
  } catch (e) {
    failed++;
    console.error(`  FAIL ${c.label}: ${e.message}\n       got ${JSON.stringify(got)}`);
  }
}

// Tablet master-detail: an empty reading pane shows a placeholder; an opened item's .iexpand
// becomes a fixed right-hand pane (~56% wide). Inject a fake expanded row — no store data needed.
{
  const page = await browser.newPage({ viewport: { width: 900, height: 1280 } });
  await page.goto(url);
  await page.waitForTimeout(300);
  const r = await page.evaluate(() => {
    const out = {};
    const ws = document.querySelector('.workspace');
    out.placeholder = ws ? getComputedStyle(ws, '::after').content : 'NO-WS';
    const stream = document.getElementById('stream');
    if (stream) {
      stream.insertAdjacentHTML('beforeend', '<article class="item expanded"><div class="iexpand">body</div></article>');
      const ix = stream.querySelector('.item.expanded .iexpand');
      out.iexpandPos = getComputedStyle(ix).position;
      out.iexpandWidthPct = Math.round((ix.getBoundingClientRect().width / window.innerWidth) * 100);
    }
    return out;
  });
  await page.close();
  try {
    assert.match(r.placeholder, /Select an item/, `tablet empty-state placeholder (got ${r.placeholder})`);
    assert.equal(r.iexpandPos, 'fixed', 'tablet expanded .iexpand is a fixed reading pane');
    assert.ok(r.iexpandWidthPct >= 50 && r.iexpandWidthPct <= 62, `tablet reading pane ~56% wide (got ${r.iexpandWidthPct}%)`);
    console.log(`  ok  tablet master-detail      → pane fixed @ ${r.iexpandWidthPct}%, placeholder present`);
  } catch (e) { failed++; console.error(`  FAIL tablet master-detail: ${e.message}`); }
}

await browser.close();
if (failed) { console.error(`\ne2e-layout: ${failed} case(s) FAILED`); process.exit(1); }
console.log('\ne2e-layout: all layout cases pass');
