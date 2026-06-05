// The Courier engine — weir's FS-backed collaborator exchange. Tests the pure
// formatters + the publish/ingest cycle against an in-memory VFS (no browser FSA).
// Run: node tools/smoke-courier.mjs

import assert from 'node:assert';
import { Courier, formatSavedRecent, formatReadme, formatManifest, splitFm, DEFAULT_COURIER } from '../src/js/courier.js';

// ── mocks ────────────────────────────────────────────────────────────────
const noteItems = new Map([
  ['stacks:n1', { id: 'stacks:n1', feed_id: 'stacks', type: 'note', author: 'laney', title: 'My first note', path: 'laney/my-first-note.md', tags: ['idea'] }],
]);
const store = {
  items: noteItems,
  getItem: (id) => noteItems.get(id),
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
const writes = []; const saves = [];
const stacks = {
  writeNote: async (o) => { writes.push(o); return { id: 'stacks:' + writes.length, path: `stacks/laney/${o.title}.md`, ...o }; },
  saveNote: async (it, md, opts) => { saves.push({ id: it.id, md, opts }); return it; },
  readNote: async (it) => `body of ${it.title}`,
};

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
    async rm(p) { files.delete(norm(p)); },
    async exists(p) { p = norm(p); return files.has(p) || dirs.has(p); },
  };
}

// ── 1. formatSavedRecent: merge ∪ dedup ∪ newest-first ──────────────────────
const md = formatSavedRecent({ store, config: DEFAULT_COURIER, now: '2026-06-05T00:00:00Z' });
assert.match(md, /kind: saved-recent/, 'frontmatter');
assert.equal((md.match(/Kriging primer/g) || []).length, 1, 'dedup s1 across both queries');
assert.match(md, /Saved video/); assert.match(md, /ESP32/);
assert.ok(md.indexOf('Saved video') < md.indexOf('Kriging primer'), 'newest first (06-03 before 06-01)');
assert.match(md, /`v1` ·/, 'each entry carries the item id (for target:/wikilinks)');
assert.ok(md.indexOf('Kriging primer') < md.indexOf('ESP32'), 'then 06-01 before 05-20');

// ── 2. splitFm ──────────────────────────────────────────────────────────────
const sf = splitFm('---\ntitle: A connection\ntags: [geostatistics, idea]\ntarget: stacks:k1\n---\n\nThese two relate.');
assert.equal(sf.data.title, 'A connection'); assert.deepEqual(sf.data.tags, ['geostatistics', 'idea']);
assert.equal(sf.data.target, 'stacks:k1'); assert.match(sf.body, /These two relate/);
assert.deepEqual(splitFm('no frontmatter here').data, {}, 'bare body → empty data');

// ── 3. README + manifest ────────────────────────────────────────────────────
assert.match(formatReadme(DEFAULT_COURIER), /Courier — Laney/);
assert.match(formatReadme(DEFAULT_COURIER), /authored by\s+\*\*laney\*\*/);   // tolerate a line wrap
assert.ok(!/Arthur/.test(formatReadme(DEFAULT_COURIER)), 'owner name is NOT hardcoded');
assert.match(formatReadme(DEFAULT_COURIER), /the owner's/, 'neutral fallback when owner unset');
assert.match(formatReadme({ ...DEFAULT_COURIER, owner: 'Testname' }), /Testname's SKOS/, 'owner name is config-driven');
assert.match(formatSavedRecent({ store, config: { ...DEFAULT_COURIER, owner: 'Testname' }, now: 't' }), /what Testname actually grabbed/, 'saved-recent owner config-driven');
assert.match(formatManifest([{ name: 'out/vocab.jsonld', updated: 't' }], { config: DEFAULT_COURIER, now: 't' }), /"courier": "weir"/);

// ── 4. Courier.publish + ingest against the mem VFS ─────────────────────────
const c = new Courier({ store, stacks, config: DEFAULT_COURIER });
await c.mountVfs(memVfs());

const pub = await c.publish('2026-06-05T00:00:00Z');
assert.deepEqual(pub.written.map((w) => w.name), ['out/vocab.jsonld', 'out/saved-recent.md', 'out/notes/INDEX.md'], 'three exports written');
assert.match(await c._read('/out/vocab.jsonld'), /geostatistics/, 'vocab content');
assert.match(await c._read('/manifest.json'), /vocab\.jsonld/, 'manifest indexes it');
assert.match(await c._read('/README.md'), /## in\//, 'README generated');
// her notes mirrored back as a TREE (index for discovery + one file per note, id in frontmatter)
assert.match(await c._read('/out/notes/INDEX.md'), /stacks:n1/, 'notes INDEX lists her note id');
assert.match(await c._read('/out/notes/my-first-note.md'), /id: stacks:n1/, 'note mirrored to the tree with its id');
assert.match(await c._read('/out/notes/my-first-note.md'), /body of My first note/, 'mirrored note carries the body');
// reconcile: a stale mirror file (no live note) is removed on the next publish
await c.vfs.writeFile('/out/notes/orphan.md', 'stale');
await c.publish('t-repub');
assert.equal(await c._read('/out/notes/orphan.md'), null, 'orphan mirror file removed on reconcile');
assert.match(await c._read('/out/notes/my-first-note.md'), /stacks:n1/, 'live note survives reconcile');

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

// ── 5. dispatch-type routing: a `feed` proposal hits the handler, not a note ─
let proposed = null;
c.handlers = { feed: async ({ data }) => { proposed = data.url; return 'queued (feed proposal)'; } };
await c.vfs.writeFile('/in/feed-1.md', '---\ntype: feed\nurl: https://blog.example/feed.xml\nwhy: matches your geostats interest\n---\n');
const ing2 = await c.ingest('t2');
assert.equal(proposed, 'https://blog.example/feed.xml', 'feed dispatch routed to the handler (data.url)');
assert.equal(writes.length, 1, 'feed dispatch did NOT become a note');
assert.match(ing2.results.find((r) => r.name === 'feed-1.md').disposition, /queued/, 'disposition records the proposal');
assert.match(await c._read('/out/receipts.md'), /feed-1\.md/, 'receipt written to out/');
assert.match(await c._read('/in/.done/feed-1.md'), /type: feed/, 'feed dispatch moved to .done');

// ── 6. subfolder organization: `folder:` nests under the courier namespace ──
await c.vfs.writeFile('/in/org.md', '---\ntitle: Organized\nfolder: research/ai\n---\n\nbody');
await c.ingest('t-org');
assert.equal(writes.find((w) => w.title === 'Organized').folder, 'laney/research/ai', 'folder: nests under stacks/<id>/');
await c.vfs.writeFile('/in/esc.md', '---\ntitle: Escapee\nfolder: ../../etc\n---\n\nbody');
await c.ingest('t-esc');
assert.equal(writes.find((w) => w.title === 'Escapee').folder, 'laney/etc', 'folder: cannot escape the namespace (.. stripped)');

// ── 7. update: revise an existing note in place (saveNote, not a new note) ───
await c.vfs.writeFile('/in/revise.md', '---\nupdate: stacks:n1\ntitle: My first note (rev)\n---\n\nrevised body');
await c.ingest('t-upd');
assert.equal(saves.length, 1, 'update: routed to saveNote');
assert.equal(saves[0].id, 'stacks:n1', 'updated the right note');
assert.match(saves[0].md, /revised body/, 'new body passed to saveNote');

console.log('courier smoke ok:', JSON.stringify({ published: pub.written.length, ingested: ing.ingested, routed: 'feed→handler', subfolder: 'laney/research/ai', mirror: 'your-notes', updated: saves.length }));
