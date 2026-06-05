// The Courier engine — weir's FS-backed collaborator exchange. Tests the pure
// formatters + the publish/ingest cycle against an in-memory VFS (no browser FSA).
// Run: node tools/smoke-courier.mjs

import assert from 'node:assert';
import { Courier, formatSavedRecent, formatReadme, formatManifest, splitFm, DEFAULT_COURIER } from '../src/js/courier.js';

// ── mocks ────────────────────────────────────────────────────────────────
const store = {
  vocabExportSkos: () => ({ '@context': { skos: 'x' }, '@graph': [{ '@id': 'weir:domain/geostatistics', 'skos:prefLabel': 'geostatistics' }] }),
  query: (opts) => {
    if (opts.feed_id === 'saved') return [
      { id: 's1', title: 'Kriging primer', url: 'https://x/k', published_at: Date.parse('2026-06-01'), type: 'article' },
      { id: 's2', title: 'ESP32 [tricks]', url: 'https://x/e', published_at: Date.parse('2026-05-20'), type: 'article' },
    ];
    if (opts.saved === true) return [
      { id: 'v1', title: 'Saved video', url: 'https://yt/v', published_at: Date.parse('2026-06-03'), type: 'video' },
      { id: 's1', title: 'Kriging primer', url: 'https://x/k', published_at: Date.parse('2026-06-01'), type: 'article' }, // dup
    ];
    return [];
  },
};
const writes = [];
const stacks = { writeNote: async (o) => { writes.push(o); return { id: 'stacks:' + writes.length, path: `stacks/laney/${o.title}.md`, ...o }; } };

// minimal in-memory VFS implementing just what Courier uses
function memVfs() {
  const files = new Map(); const dirs = new Set(['/']);
  const norm = (p) => (p.replace(/\/+$/, '') || '/');
  return {
    async mkdir(p) { let cur = ''; for (const s of norm(p).split('/')) { if (!s) continue; cur += '/' + s; dirs.add(cur); } },
    async writeFile(p, t) { files.set(norm(p), String(t)); },
    async readFile(p) { p = norm(p); if (!files.has(p)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return files.get(p); },
    async readdir(p) {
      p = norm(p); const pre = p === '/' ? '/' : p + '/'; const set = new Set();
      for (const k of [...files.keys(), ...dirs]) { if (k !== p && k.startsWith(pre)) { const name = k.slice(pre.length).split('/')[0]; if (name) set.add(name); } }
      return [...set];
    },
    async stat(p) { p = norm(p); if (dirs.has(p)) return { type: 'directory' }; if (files.has(p)) return { type: 'file' }; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; },
    async rename(a, b) { a = norm(a); b = norm(b); if (files.has(a)) { files.set(b, files.get(a)); files.delete(a); } },
    async exists(p) { p = norm(p); return files.has(p) || dirs.has(p); },
  };
}

// ── 1. formatSavedRecent: merge ∪ dedup ∪ newest-first ──────────────────────
const md = formatSavedRecent({ store, config: DEFAULT_COURIER, now: '2026-06-05T00:00:00Z' });
assert.match(md, /kind: saved-recent/, 'frontmatter');
assert.equal((md.match(/Kriging primer/g) || []).length, 1, 'dedup s1 across both queries');
assert.match(md, /Saved video/); assert.match(md, /ESP32/);
assert.ok(md.indexOf('Saved video') < md.indexOf('Kriging primer'), 'newest first (06-03 before 06-01)');
assert.ok(md.indexOf('Kriging primer') < md.indexOf('ESP32'), 'then 06-01 before 05-20');

// ── 2. splitFm ──────────────────────────────────────────────────────────────
const sf = splitFm('---\ntitle: A connection\ntags: [geostatistics, idea]\ntarget: stacks:k1\n---\n\nThese two relate.');
assert.equal(sf.data.title, 'A connection'); assert.deepEqual(sf.data.tags, ['geostatistics', 'idea']);
assert.equal(sf.data.target, 'stacks:k1'); assert.match(sf.body, /These two relate/);
assert.deepEqual(splitFm('no frontmatter here').data, {}, 'bare body → empty data');

// ── 3. README + manifest ────────────────────────────────────────────────────
assert.match(formatReadme(DEFAULT_COURIER), /Courier — Laney/);
assert.match(formatReadme(DEFAULT_COURIER), /authored by \*\*laney\*\*/);
assert.ok(!/Arthur/.test(formatReadme(DEFAULT_COURIER)), 'owner name is NOT hardcoded');
assert.match(formatReadme(DEFAULT_COURIER), /the owner's/, 'neutral fallback when owner unset');
assert.match(formatReadme({ ...DEFAULT_COURIER, owner: 'Testname' }), /Testname's SKOS/, 'owner name is config-driven');
assert.match(formatSavedRecent({ store, config: { ...DEFAULT_COURIER, owner: 'Testname' }, now: 't' }), /what Testname actually grabbed/, 'saved-recent owner config-driven');
assert.match(formatManifest([{ name: 'out/vocab.jsonld', updated: 't' }], { config: DEFAULT_COURIER, now: 't' }), /"courier": "weir"/);

// ── 4. Courier.publish + ingest against the mem VFS ─────────────────────────
const c = new Courier({ store, stacks, config: DEFAULT_COURIER });
await c.mountVfs(memVfs());

const pub = await c.publish('2026-06-05T00:00:00Z');
assert.deepEqual(pub.written.map((w) => w.name), ['out/vocab.jsonld', 'out/saved-recent.md'], 'both exports written');
assert.match(await c._read('/out/vocab.jsonld'), /geostatistics/, 'vocab content');
assert.match(await c._read('/manifest.json'), /vocab\.jsonld/, 'manifest indexes it');
assert.match(await c._read('/README.md'), /## in\//, 'README generated');

// plant a dispatch in in/ → ingest → becomes an author:laney note → moved to .done
await c.vfs.writeFile('/in/finding-1.md', '---\ntitle: A connection\ntarget: stacks:k1\ntags: [geostatistics]\n---\n\nThese two relate.');
const ing = await c.ingest();
assert.equal(ing.ingested, 1, 'one dispatch ingested');
assert.equal(writes[0].source, 'laney', 'attributed via source → author');
assert.equal(writes[0].target, 'stacks:k1', 'target carried → annotation');
assert.equal(writes[0].folder, 'laney', 'filed under stacks/laney');
assert.match(writes[0].markdown, /These two relate/, 'body ingested');
assert.equal(await c._read('/in/finding-1.md'), null, 'dispatch removed from in/');
assert.match(await c._read('/in/.done/finding-1.md'), /These two relate/, 'moved to .done (never-delete)');

console.log('courier smoke ok:', JSON.stringify({ published: pub.written.length, ingested: ing.ingested }));
