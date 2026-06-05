// The Courier — weir's OPTIONAL, FS-backed exchange endpoint for external
// collaborators (Laney/hermes today; any agent, tool, or human that speaks the folder
// protocol). weir's third I/O surface:  bridge = fetch · adapters = parse · Courier =
// COLLABORATE.
//
// weir is sync-AGNOSTIC: it only reads/writes an FSA-mounted folder. How that folder is
// shared across machines (Syncthing, a network mount, nothing if same-machine) is the
// user's infra, deliberately OUTSIDE this code — swap it and nothing here changes.
//
// A Courier is parameterized by a config; Laney is the first INSTANCE, not the feature.
// N couriers is a config list, not a refactor — and the seams are placed so this could
// graduate to a shared @gcu/courier primitive later. It lives in weir for now.
//
// Folder layout it maintains (paths relative to the exchange folder root):
//   README.md       generated protocol/skill doc — the LIVE spec (code writes it → can't drift)
//   manifest.json   machine index: what's in out/, when written
//   out/            weir → collaborator (curated exports; this code writes them)
//   in/             collaborator → weir (dispatches: md + YAML frontmatter)
//   in/.done/       processed dispatches, moved aside (never-delete), not removed

import { VFS } from '../../vendor/vfs.js';   // dev-clarity; build inlines (global VFS)

export const DEFAULT_COURIER = {
  id: 'laney', name: 'Laney', author: 'laney',
  exports: ['vocab', 'saved-recent'],   // the trust gradient — start narrow, widen later
  savedRecentLimit: 60,
};

// ── export writers: a small registry so adding an export is pluggable, not surgery ──
// Each takes a ctx { store, config, now } and returns { path, text }.
export const EXPORT_WRITERS = {
  vocab(ctx) {
    return { path: 'out/vocab.jsonld', text: JSON.stringify(ctx.store.vocabExportSkos(), null, 1) };
  },
  'saved-recent'(ctx) {
    return { path: 'out/saved-recent.md', text: formatSavedRecent(ctx) };
  },
};

// ── pure formatters (no I/O — unit-testable) ────────────────────────────────
function escMd(s) { return String(s == null ? '' : s).replace(/\n/g, ' ').replace(/\]/g, '\\]').trim(); }

// Recent DELIBERATE captures = the Saved Links source (shared links) ∪ ★saved, newest
// first. The purest interest signal — what you actually reached out and grabbed.
export function formatSavedRecent(ctx) {
  const limit = ctx.config.savedRecentLimit || DEFAULT_COURIER.savedRecentLimit;
  const pool = [...ctx.store.query({ feed_id: 'saved', limit }), ...ctx.store.query({ saved: true, limit })];
  const seen = new Set(); const items = [];
  pool.sort((a, b) => (b.published_at || 0) - (a.published_at || 0));
  for (const it of pool) { if (seen.has(it.id)) continue; seen.add(it.id); items.push(it); if (items.length >= limit) break; }
  const fm = `---\nkind: saved-recent\ngenerated_at: ${ctx.now}\ncount: ${items.length}\n---\n\n`;
  const head = `# Recent deliberate captures (${items.length})\n\n`
    + `Shared links + ★saved, newest first — the high-signal slice of what Arthur actually grabbed.\n\n`;
  const rows = items.map((it) => {
    const d = it.published_at ? new Date(it.published_at).toISOString().slice(0, 10) : '—';
    const t = escMd(it.title || it.url || it.id);
    const tail = it.type ? ` · ${it.type}` : '';
    return `- ${d} · [${t}](${it.url || ''})${tail}`;
  }).join('\n');
  return fm + head + (rows || '_(nothing captured yet)_') + '\n';
}

export function formatManifest(files, ctx) {
  return JSON.stringify({ courier: 'weir', name: ctx.config.name, generated_at: ctx.now, files }, null, 1);
}

// The self-describing skill — this IS the collaborator's interface + the live protocol spec.
export function formatReadme(config) {
  return `# weir Courier — ${config.name}

This folder is a **Courier**: weir's filesystem exchange with you. weir writes curated
material into \`out/\`; you write findings ("dispatches") into \`in/\`. weir never reads
anything but \`in/\`, and you only need to write there.

## out/  (weir → you — read-only by convention)
- \`vocab.jsonld\` — Arthur's SKOS controlled vocabulary. **Use these terms** when you tag,
  so your work aligns with his taxonomy.
- \`saved-recent.md\` — his recent deliberate captures (shared links + saved), newest first.
  The high-signal slice of what he actually cares about — a good thing to work on.
- \`manifest.json\` — machine index: what's here and when it was written. Read this first.

## in/  (you → weir)
Drop one Markdown file per dispatch, with YAML frontmatter:

\`\`\`markdown
---
title: A short title
tags: [geostatistics, idea]       # optional; prefer terms from vocab.jsonld
target: <weir-item-id>            # optional — binds this as an ANNOTATION on that item
---

Your note, in Markdown. [[wiki-links]] to other items work too.
\`\`\`

weir ingests each dispatch as a note authored by **${config.author}**, catalogs it, and
surfaces it in Arthur's stream. With \`target:\`, it lands as a backlink (📝) on that item.
Write atomically (write a temp file, then rename into \`in/\`). Processed dispatches are
moved to \`in/.done/\` — never deleted.

_weir writes this file; don't edit it (your changes will be overwritten on next publish)._
`;
}

// ── splitFm: frontmatter split with a TOLERANT parser ────────────────────────
// Dispatches are authored OUTSIDE weir (by an agent/human), so their frontmatter is
// ordinary YAML — unquoted scalars, inline arrays — which @gcu/yaml's strict subset
// rejects. We only need a few scalar/array fields (title, tags, target), so a small
// lenient line parser is the right tool, not the strict one.
function unquote(s) {
  s = String(s).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  return s;
}
export function parseFrontmatter(src) {
  const out = {}; const lines = String(src).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);   // key: rest  (value may itself contain ':')
    if (!m) continue;
    const key = m[1]; const val = m[2].trim();
    if (val === '') {                                      // maybe a block list on following lines
      const items = []; let j = i + 1;
      while (j < lines.length && /^\s*-\s+/.test(lines[j])) { items.push(unquote(lines[j].replace(/^\s*-\s+/, ''))); j++; }
      out[key] = items.length ? items : '';
      i = j - 1;
    } else if (val.startsWith('[') && val.endsWith(']')) { // inline array
      out[key] = val.slice(1, -1).split(',').map((s) => unquote(s)).filter(Boolean);
    } else {
      out[key] = unquote(val);
    }
  }
  return out;
}
export function splitFm(raw) {
  const text = String(raw == null ? '' : raw);
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { data: {}, body: text };
  let data = {};
  try { data = parseFrontmatter(m[1]); } catch { data = {}; }
  return { data: data || {}, body: text.slice(m[0].length) };
}

// ── the Courier: thin VFS shell around the pure formatters ───────────────────
export class Courier {
  constructor({ store, stacks, config } = {}) {
    this.store = store; this.stacks = stacks;
    this.config = { ...DEFAULT_COURIER, ...(config || {}) };
    this.handle = null; this.vfs = null;
  }
  get mounted() { return !!this.vfs; }
  _now() { return new Date().toISOString(); }

  // Mount an FSA directory handle (the exchange folder) and scaffold the layout.
  async mount(handle) {
    this.handle = handle;
    this.vfs = await VFS.create({ type: 'fsaa', handle });
    await this._ensureSkeleton();
    return this;
  }
  // For tests: mount a non-FSA VFS (e.g. an in-memory backend) directly.
  async mountVfs(vfs) { this.vfs = vfs; await this._ensureSkeleton(); return this; }

  async _ensureSkeleton() {
    for (const d of ['/out', '/in', '/in/.done']) { try { await this.vfs.mkdir(d, { recursive: true }); } catch { /* exists */ } }
    await this._write('/README.md', formatReadme(this.config));
  }
  async _write(path, text) {
    const dir = path.replace(/\/[^/]*$/, '');
    if (dir) { try { await this.vfs.mkdir(dir, { recursive: true }); } catch { /* exists */ } }
    await this.vfs.writeFile(path, String(text));
  }
  async _read(path) { try { return await this.vfs.readFile(path, 'utf8'); } catch { return null; } }

  // Publish the configured exports into out/, refresh the manifest + README.
  async publish(now = this._now()) {
    if (!this.vfs) throw new Error('courier: not mounted');
    const ctx = { store: this.store, config: this.config, now };
    const written = [];
    for (const key of this.config.exports) {
      const w = EXPORT_WRITERS[key]; if (!w) continue;
      const { path, text } = w(ctx);
      await this._write('/' + path, text);
      written.push({ name: path, updated: now });
    }
    await this._write('/manifest.json', formatManifest(written, ctx));
    await this._write('/README.md', formatReadme(this.config));
    return { written };
  }

  // Ingest in/ dispatches → weir stacks notes (author-tagged), then move each to in/.done.
  async ingest() {
    if (!this.vfs || !this.stacks) return { ingested: 0, items: [] };
    let names; try { names = await this.vfs.readdir('/in'); } catch { return { ingested: 0, items: [] }; }
    const items = [];
    for (const name of names) {
      if (name.startsWith('.') || !/\.md$/i.test(name)) continue;
      let st; try { st = await this.vfs.stat('/in/' + name); } catch { continue; }
      if (st && st.type === 'directory') continue;
      const text = await this._read('/in/' + name); if (text == null) continue;
      const { data, body } = splitFm(text);
      try {
        const rec = await this.stacks.writeNote({
          folder: this.config.id,                 // → stacks/<id>/ (e.g. stacks/laney/)
          title: data.title || name.replace(/\.md$/i, ''),
          markdown: body,
          tags: Array.isArray(data.tags) ? data.tags : [],
          source: this.config.author,             // → author: laney (attribution)
          target: data.target || undefined,       // optional → annotation backlink on a weir item
        });
        items.push(rec);
        // never-delete: move the processed dispatch aside, don't remove it.
        try { await this.vfs.rename('/in/' + name, '/in/.done/' + name); } catch { /* leave in place if move fails */ }
      } catch (e) { /* skip a bad dispatch; leave it in in/ for a retry */ }
    }
    return { ingested: items.length, items };
  }

  // Snapshot for the UI / weir_courier tool.
  async status() {
    let inbox = 0, done = 0;
    if (this.vfs) {
      try { inbox = (await this.vfs.readdir('/in')).filter((n) => !n.startsWith('.') && /\.md$/i.test(n)).length; } catch {}
      try { done = (await this.vfs.readdir('/in/.done')).filter((n) => /\.md$/i.test(n)).length; } catch {}
    }
    return { id: this.config.id, name: this.config.name, mounted: this.mounted, folder: this.handle?.name || null, exports: this.config.exports, pendingIn: inbox, ingested: done };
  }
}
