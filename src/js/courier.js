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
  owner: '',                            // the weir user's display name (config — NEVER hardcoded);
                                        // '' → a neutral "the owner" in generated text.
  exports: ['vocab', 'saved-recent', 'notes'],       // trust gradient — `notes` mirrors HER own work back as a tree
  savedRecentLimit: 60,
};
const ownerName = (config) => (config && config.owner) || 'the owner';

// ── export writers: a small registry so adding an export is pluggable, not surgery ──
// Each takes a ctx { store, config, now } and returns { path, text }.
export const EXPORT_WRITERS = {
  vocab(ctx) {
    return { path: 'out/vocab.jsonld', text: JSON.stringify(ctx.store.vocabExportSkos(), null, 1) };
  },
  'saved-recent'(ctx) {
    return { path: 'out/saved-recent.md', text: formatSavedRecent(ctx) };
  },
  // NB: `notes` (the collaborator's own work, mirrored back as a TREE under out/notes/) is
  // multi-file + reconciling, so it's handled in publish() via Courier._mirrorNotes(), not here.
};

// Index for the out/notes/ mirror — cheap discovery so she reads ONE note, not all of them.
export function formatNotesIndex(rows, now) {
  return `---\nkind: notes-index\ngenerated_at: ${now}\ncount: ${rows.length}\n---\n\n`
    + `# Your notes (${rows.length})\n\nFind a note here, then open just that file under \`notes/\` — don't read them all.\n`
    + `Each note's frontmatter carries its **id**; use it in \`update:\`, \`target:\`, or \`[[id]]\`.\n\n`
    + (rows.join('\n') || '_(nothing yet)_') + '\n';
}

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
    + `Shared links + ★saved, newest first — the high-signal slice of what ${ownerName(ctx.config)} actually grabbed.\n`
    + `Each line starts with the weir item **id** in backticks — pass it as \`target:\` (to annotate that item) or \`[[id|label]]\` (to link it) in a dispatch.\n\n`;
  const rows = items.map((it) => {
    const d = it.published_at ? new Date(it.published_at).toISOString().slice(0, 10) : '—';
    const t = escMd(it.title || it.url || it.id);
    const tail = it.type ? ` · ${it.type}` : '';
    return `- \`${it.id}\` · ${d} · [${t}](${it.url || ''})${tail}`;
  }).join('\n');
  return fm + head + (rows || '_(nothing captured yet)_') + '\n';
}

export function formatManifest(files, ctx) {
  return JSON.stringify({ courier: 'weir', name: ctx.config.name, generated_at: ctx.now, files }, null, 1);
}

// Receipt of the last ingest — so the collaborator knows what landed and what didn't.
export function formatReceipts(results, now) {
  const head = `---\nkind: receipts\ngenerated_at: ${now}\n---\n\n# Last ingest (${results.length})\n\n`
    + `What weir did with each file in in/: **filed as note** = it's in the stream · **queued (...)** = a proposal awaiting approval · **error** = left in in/ for you to fix.\n\n`;
  return head + results.map((r) => `- \`${r.name}\` → ${r.disposition}`).join('\n') + '\n';
}

// The self-describing skill — this IS the collaborator's interface + the live protocol spec.
export function formatReadme(config) {
  const owner = ownerName(config);
  return `# weir Courier — ${config.name}

This folder is a **Courier**: weir's filesystem exchange with you. weir writes curated
material into \`out/\`; you write findings ("dispatches") into \`in/\`. weir never reads
anything but \`in/\`, and you only need to write there.

## out/  (weir → you — read-only by convention)
- \`vocab.jsonld\` — ${owner}'s SKOS controlled vocabulary. **Use these terms** when you tag,
  so your work aligns with their taxonomy.
- \`saved-recent.md\` — ${owner}'s recent deliberate captures (shared links + saved), newest
  first. The high-signal slice of what they actually care about — a good thing to work on.
  Each entry begins with the item's **id** in backticks; that's the handle you put in
  \`target:\` to annotate it, or in \`[[id|label]]\` to link it.
- \`notes/\` — **your own notes**, mirrored back as a tree (your folder structure preserved).
  Read \`notes/INDEX.md\` to find one, then open just that file — don't read them all. Each
  carries its canonical **id** in frontmatter; build on them, link them (\`[[id]]\`), or revise
  one (\`update:\` below).
- \`manifest.json\` — machine index: what's here and when it was written. Read this first.

## in/  (you → weir)
Drop one Markdown file per dispatch — **one topic per file** is easiest to catalog (and to
dedup). YAML frontmatter on top, Markdown body below:

\`\`\`markdown
---
title: A short title
type: note                        # optional — see "dispatch types" below (default: note)
tags: [geostatistics, idea]       # optional — prefer terms from vocab.jsonld
target: <weir-item-id>            # optional — annotate that item (ids are in saved-recent.md)
folder: research/ai               # optional — file under your own space (see below)
update: <your-note-id>            # optional — revise that note instead of adding a new one
---

Your note, in Markdown. [[id|label]] links to other items work too.
\`\`\`

Use \`folder:\` to keep your work tidy — it nests under your own \`${config.author}/\` space
(e.g. \`folder: agents\` → \`stacks/${config.author}/agents/\`), created as needed. Everything
you send stays namespaced to you; ${owner} can rearrange it in the stacks tree anytime.

To **revise** one of your earlier notes instead of adding a new one, put its id (from
\`notes/INDEX.md\`) in \`update: <id>\` — weir edits that note in place.

You don't need to sign dispatches — weir files each one as a note authored by **${config.author}** automatically, so it's always attributable to you.

### Dispatch types (\`type:\`)
- **note** (default) — a finding, brief, or annotation. Filed into ${owner}'s stream. With
  \`target:\` (an id from \`saved-recent.md\`), it becomes a 📝 backlink on that item.
- **feed** — *suggest a source to follow.* Frontmatter \`type: feed\`, \`url:\`, and a short
  \`why:\`. weir queues it as a **proposal ${owner} approves** — it does not auto-add. Use it
  when you find a blog / feed / channel worth tracking.

The rule for everything beyond a plain note: **you propose, ${owner} decides.** (More types —
vocabulary suggestions, item relations, slice requests — are coming; they all work this way.)

### Feedback
weir ingests \`in/\` **automatically** (about every 25s while connected), then writes
**\`out/receipts.md\`** — so after dropping a dispatch, give it a moment, then read receipts
to see what each file became: *filed as note* · *queued (a proposal)* · *error* (left in
\`in/\` for you to fix). Your new notes appear under \`out/notes/\` right after ingest.

Write atomically (temp file, then rename into \`in/\`). Processed dispatches move to
\`in/.done/\` — never deleted.

_weir writes this README; don't edit it (your changes are overwritten on next publish)._
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
    // dispatch-type handlers (type → async ({data,body,name}) → dispositionString).
    // `note` is built in (→ a stacks note); the app registers structural types
    // (feed/vocab/relate/…) that land as PROPOSALS the user ratifies (decides-vs-proposes).
    this.handlers = {};
  }
  get mounted() { return !!this.vfs; }
  unmount() { this.vfs = null; this.handle = null; }
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
    const ctx = { store: this.store, stacks: this.stacks, config: this.config, now };
    const written = [];
    for (const key of this.config.exports) {
      if (key === 'notes') { await this._mirrorNotes(now); written.push({ name: 'out/notes/INDEX.md', updated: now }); continue; }
      const w = EXPORT_WRITERS[key]; if (!w) continue;
      const { path, text } = await w(ctx);
      await this._write('/' + path, text);
      written.push({ name: path, updated: now });
    }
    await this._write('/manifest.json', formatManifest(written, ctx));
    await this._write('/README.md', formatReadme(this.config));
    return { written };
  }

  // Mirror the collaborator's OWN notes back as a TREE under out/notes/, preserving her
  // folder structure (one file per note, id in frontmatter) + an INDEX for cheap discovery.
  // Reconciling: files no longer backed by a live note are removed (no stale orphans).
  async _mirrorNotes(now = this._now()) {
    const author = this.config.author;
    const notes = [...this.store.items.values()].filter((it) => it.feed_id === 'stacks' && it.type === 'note' && it.author === author);
    const wanted = new Set(); const rows = [];
    const prefix = new RegExp('^' + author.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/');
    for (const it of notes) {
      const rel = String(it.path || '').replace(prefix, '') || (String(it.id).replace(/[^\w.-]/g, '_') + '.md');
      const mpath = '/out/notes/' + rel;
      let body = ''; try { body = (await this.stacks.readNote(it)) || ''; } catch { /* unreadable → empty */ }
      const fm = `---\nid: ${it.id}\ntitle: ${JSON.stringify(String(it.title || ''))}\ntags: [${(it.tags || []).join(', ')}]\n---\n\n`;
      await this._write(mpath, fm + String(body).trim() + '\n');
      wanted.add(mpath);
      rows.push(`- \`${it.id}\` · [${escMd(it.title || rel)}](${rel}) · ${(it.tags || []).join(', ') || '—'}`);
    }
    await this._write('/out/notes/INDEX.md', formatNotesIndex(rows, now));
    wanted.add('/out/notes/INDEX.md');
    await this._reconcileDir('/out/notes', wanted);
  }
  async _reconcileDir(dir, wanted) {
    let names; try { names = await this.vfs.readdir(dir); } catch { return; }
    for (const name of names) {
      const p = dir + '/' + name;
      let st; try { st = await this.vfs.stat(p); } catch { continue; }
      if (st && st.type === 'directory') await this._reconcileDir(p, wanted);
      else if (!wanted.has(p)) { try { await this.vfs.rm(p); } catch { /* best-effort orphan cleanup */ } }
    }
  }

  // Ingest in/ dispatches, routed by `type:`. `note` (default) → an author-tagged
  // stacks note; other types → a registered handler (a PROPOSAL the user ratifies).
  // Processed files move to in/.done (never-delete); a receipt is written to out/.
  async _fileAsNote(data, body, name) {
    // Everything stays NAMESPACED under stacks/<id>/ (e.g. stacks/laney/) for attribution.
    // The collaborator may organize WITHIN that namespace via `folder:` — sanitized so a
    // dispatch can't escape it (no leading slash, no .., safe chars only).
    const sub = String(data.folder || data.dir || '').replace(/\.\.+/g, '').replace(/[^\w /-]/g, '').replace(/^[ /]+|[ /]+$/g, '').trim();
    const folder = sub ? `${this.config.id}/${sub}` : this.config.id;
    return this.stacks.writeNote({
      folder,
      title: data.title || name.replace(/\.md$/i, ''),
      markdown: body,
      tags: Array.isArray(data.tags) ? data.tags : [],
      source: this.config.author,               // → author: laney (attribution)
      target: data.target || undefined,         // optional → annotation backlink on a weir item
    });
  }
  async ingest(now = this._now()) {
    if (!this.vfs || !this.stacks) return { ingested: 0, results: [] };
    let names; try { names = await this.vfs.readdir('/in'); } catch { return { ingested: 0, results: [] }; }
    const results = [];
    for (const name of names) {
      if (name.startsWith('.') || !/\.md$/i.test(name)) continue;
      let st; try { st = await this.vfs.stat('/in/' + name); } catch { continue; }
      if (st && st.type === 'directory') continue;
      const text = await this._read('/in/' + name); if (text == null) continue;
      const { data, body } = splitFm(text);
      const type = String(data.type || 'note').toLowerCase();
      let disposition;
      try {
        if (type !== 'note' && this.handlers[type]) {
          disposition = (await this.handlers[type]({ data, body, name })) || `queued (${type})`;
        } else {
          // `update: <id>` revises an existing note in place (saveNote); else a new note.
          const updId = (typeof data.update === 'string' && data.update.trim()) || null;
          const it = updId ? this.store.getItem(updId) : null;
          if (it && it.feed_id === 'stacks') {
            await this.stacks.saveNote(it, body, { title: data.title || it.title, tags: Array.isArray(data.tags) ? data.tags : undefined });
            disposition = `updated note ${updId}`;
          } else {
            await this._fileAsNote(data, body, name);
            disposition = updId ? `filed as new note (update target "${updId}" not found)`
              : (type === 'note' ? 'filed as note' : `filed as note (unknown type "${type}")`);
          }
        }
        try { await this.vfs.rename('/in/' + name, '/in/.done/' + name); } catch { /* leave if move fails */ }
      } catch (e) {
        disposition = `error: ${e.message || e}`;   // leave the file in in/ for a retry
      }
      results.push({ name, type, disposition });
    }
    if (results.length) { try { await this._write('/out/receipts.md', formatReceipts(results, now)); } catch { /* best-effort */ } }
    return { ingested: results.filter((r) => !r.disposition.startsWith('error')).length, results };
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
