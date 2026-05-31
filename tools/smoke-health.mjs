// Feed-health / hijack detection tests. Run: node tools/smoke-health.mjs

import assert from 'node:assert';
import { assessFeed, hostOf, sameSite, repeatedToken } from '../src/js/health.js';

const NOW = 1_760_000_000_000;
const DAY = 86_400_000;
const recent = (i) => NOW - i * DAY;   // i days ago

// ── helpers ──
assert.equal(hostOf('https://www.theverge.com/rss'), 'theverge.com', 'strips www');
assert.equal(hostOf('not a url'), null);
assert.equal(sameSite('pyfound.blogspot.com', 'pyfound.blogspot.com'), true);
assert.equal(sameSite('humttovietnam.com', 'pyfound.blogspot.com'), false, 'different site');
assert.equal(sameSite('www.theverge.com', 'theverge.com'), true, 'www-normalized already');
assert.equal(repeatedToken(['Giày chạy bộ Humtto X', 'Giày sandal Humtto Y', 'Giày trekking Humtto Z', 'Giày leo núi Humtto W']), 'giày', 'brand word in every title');
assert.equal(repeatedToken(['Totally different', 'Unrelated headline', 'Another topic here', 'Nothing in common']), null, 'no shared token');

// ── 1) hijacked PSF-style feed → SUSPECT ──
const psfItems = Array.from({ length: 8 }, (_, i) => ({
  title: `Giày chạy bộ thể thao Humtto ${370374 + i}A`,
  author: 'admin',
  url: `https://humttovietnam.com/p/${i}`,
  published_at: recent(i),
}));
const psf = assessFeed({ site_url: 'https://pyfound.blogspot.com/', url: 'https://feeds.feedburner.com/PythonSoftwareFoundationNews' }, psfItems, NOW);
assert.equal(psf.status, 'suspect', 'PSF hijack flagged suspect');
assert.ok(psf.score >= 3, `score ${psf.score} >= 3`);
assert.ok(psf.reasons.some((r) => /admin/.test(r)) && psf.reasons.some((r) => /humttovietnam/.test(r)), 'reasons name the tells');

// ── 2) legit non-English feed → OK (language is NOT a signal) ──
const ptItems = Array.from({ length: 8 }, (_, i) => ({
  title: ['Processamento de imagens de satélite', 'Análise espacial com Python', 'Mapas e geotecnologia', 'Sensoriamento remoto na prática'][i % 4],
  author: 'Arthur Endlein',
  url: `https://processamentodigital.com.br/post-${i}`,
  published_at: recent(i),
}));
assert.equal(assessFeed({ site_url: 'https://processamentodigital.com.br/', url: 'https://feeds.feedburner.com/ProcessamentoDigital' }, ptItems, NOW).status, 'ok',
  'Portuguese feed by a named author on its own domain is fine');

// ── 3) legit LINK BLOG (links offsite, but named author, varied titles) → OK ──
const linkBlog = [
  { title: 'On the future of the web', author: 'John Gruber', url: 'https://example.com/a', published_at: recent(0) },
  { title: 'A great new camera', author: 'John Gruber', url: 'https://other.net/b', published_at: recent(1) },
  { title: 'Thoughts about typography', author: 'John Gruber', url: 'https://third.org/c', published_at: recent(2) },
  { title: 'Why I switched editors', author: 'John Gruber', url: 'https://fourth.io/d', published_at: recent(3) },
  { title: 'The state of podcasts', author: 'John Gruber', url: 'https://fifth.com/e', published_at: recent(4) },
];
const lb = assessFeed({ site_url: 'https://daringfireball.net/', url: 'https://daringfireball.net/feed' }, linkBlog, NOW);
assert.equal(lb.status, 'ok', `link blog not flagged (score ${lb.score} < 3): offsite is only +1 without admin/template`);

// ── 4) stale feed (real posts, but long quiet) → STALE ──
const old = Array.from({ length: 5 }, (_, i) => ({ title: `PyPy 7.3.${i} release`, author: 'mattip', url: `https://pypy.org/${i}`, published_at: NOW - (1800 + i) * DAY }));
const st = assessFeed({ site_url: 'https://www.pypy.org/', url: 'https://feeds.feedburner.com/PyPyStatusBlog' }, old, NOW);
assert.equal(st.status, 'stale', 'feed quiet for years → stale');
assert.match(st.reasons[0], /no new posts/);
// custom threshold can relax it
assert.equal(assessFeed({ url: 'https://x.io/f' }, old, NOW, { staleDays: 5000 }).status, 'ok', 'staleDays override');

// ── 5) network-dead feed → FAILING (poller-driven) ──
assert.equal(assessFeed({ url: 'https://gone.example/feed', state: 'failing', feed_health: { last_error: 'HTTP 404' } }, [], NOW).status, 'failing', 'failing state passes through');

// ── 6) healthy active feed → OK ──
const healthy = Array.from({ length: 6 }, (_, i) => ({ title: ['Release notes', 'A deep dive', 'Community update', 'Performance work'][i % 4], author: 'team', url: `https://realblog.dev/${i}`, published_at: recent(i) }));
assert.equal(assessFeed({ site_url: 'https://realblog.dev/', url: 'https://realblog.dev/feed' }, healthy, NOW).status, 'ok', 'recent on-site varied feed is ok');

// ── 7) empty feed (no items yet) → OK, not stale ──
assert.equal(assessFeed({ url: 'https://new.example/feed' }, [], NOW).status, 'ok', 'no items → ok (not stale)');

console.log('smoke-health: ok');
