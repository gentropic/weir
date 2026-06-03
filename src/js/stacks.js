// The Stacks (STACKS.md) — weir's authored-notes + dropped-files surface, living
// as REAL files under /stacks/ in the VFS (so a mounted folder opens in Obsidian /
// git / your editor). Entries are first-class Items under the synthetic 'stacks'
// feed; identity is a stable `uid` written into frontmatter (notes) or a
// `.meta.json` sidecar (files), so a move/rename keeps the item's tags, read-state,
// catalog card, and inbound [[uid]] links (STACKS.md §9). The path is just the
// entry's current address.
//
// Frontmatter is parsed/emitted with the vendored @gcu/yaml (strict, no-RCE,
// quoted-scalar subset). weir owns the files it writes (canonical, quoted, valid
// standard YAML); external unquoted frontmatter that fails the strict parse is
// tolerated — the file is treated as bodyless-frontmatter and re-stamped on next
// write. External-edit two-way sync is a later stage; v1 is weir-authoritative.

// NB: import the REAL exported names (no aliasing) — the single-file build strips
// imports and resolves these against the vendored globals BY NAME, so a renamed import
// would be an undefined reference in the bundle (it works under node ESM but not built).
import { parse, emit, scalar, mapNode, seqNode } from '../../vendor/yaml.js';
import { deriveExcerpt, slugify, now, hash32 } from './store/schema.js';

const ROOT = '/stacks';
const INBOX = 'inbox';
const STACKS_STASH = '/telegram-notes.ndjson';

// Skip dotfiles/dotfolders so a git-backed or Obsidian mount Just Works
// (.git, .obsidian, …) — STACKS.md §9 "git-friendly mount".
const isHidden = (name) => name.startsWith('.');
const isNotePath = (p) => /\.(md|markdown|mdown|txt)$/i.test(p);
const isSidecar = (p) => /\.meta\.json$/i.test(p);

const MIME = {
  pdf: 'application/pdf', epub: 'application/epub+zip',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  md: 'text/markdown', txt: 'text/plain', json: 'application/json', csv: 'text/csv',
  zip: 'application/zip', mp3: 'audio/mpeg', mp4: 'video/mp4',
};
const mimeFor = (name) => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

export class StacksStore {
  constructor(store) {
    this.store = store;
    this.vfs = store.vfs;
  }

  // ── identity / paths ──
  _uid() {
    const c = globalThis.crypto;
    if (c && c.randomUUID) return c.randomUUID().replace(/-/g, '').slice(0, 12);
    return (now().toString(36) + Math.floor(Math.random() * 1e9).toString(36)).slice(0, 12);
  }
  _join(folder, name) {
    const f = String(folder || '').replace(/^\/+|\/+$/g, '');
    const n = String(name || '').replace(/^\/+/, '');
    return f ? `${f}/${n}` : n;
  }
  _abs(rel) { return `${ROOT}/${String(rel).replace(/^\/+/, '')}`; }
  _rel(abs) { return String(abs).startsWith(`${ROOT}/`) ? abs.slice(ROOT.length + 1) : abs; }
  _basename(p) { return String(p).split('/').pop(); }
  _dirname(p) { const i = String(p).lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
  _safeName(name, fallbackExt) {
    let n = String(name || '').trim().replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').slice(0, 120);
    if (!n) n = 'untitled';
    if (fallbackExt && !/\.[A-Za-z0-9]+$/.test(n)) n += fallbackExt;
    return n;
  }
  async _exists(abs) { try { return await this.vfs.exists(abs); } catch { return false; } }
  // Avoid clobbering a different entry: if the path is taken, version it (name (2).ext).
  async _uniqueRel(rel) {
    if (!(await this._exists(this._abs(rel)))) return rel;
    const dir = this._dirname(rel), base = this._basename(rel);
    const dot = base.lastIndexOf('.');
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : '';
    for (let i = 2; i < 999; i++) {
      const cand = this._join(dir, `${stem} (${i})${ext}`);
      if (!(await this._exists(this._abs(cand)))) return cand;
    }
    return rel;
  }

  // ── frontmatter ↔ JS (strict @gcu/yaml) ──
  _fmEmit(obj) {
    const entries = [];
    for (const [k, v] of Object.entries(obj)) {
      if (v == null) continue;
      if (Array.isArray(v)) {
        if (!v.length) continue;
        entries.push({ key: scalar('string', k), value: seqNode(v.map((x) => scalar('string', String(x)))) });
      } else {
        entries.push({ key: scalar('string', k), value: scalar('string', String(v)) });
      }
    }
    if (!entries.length) return '';
    return emit(mapNode(entries));
  }
  _nodeToJs(node) {
    if (!node) return null;
    if (node.kind === 'scalar') return node.value;
    if (node.kind === 'seq') return node.items.map((n) => this._nodeToJs(n));
    if (node.kind === 'map') { const o = {}; for (const e of node.entries) o[this._nodeToJs(e.key)] = this._nodeToJs(e.value); return o; }
    return null;
  }
  // Split a doc into { data, body }. Frontmatter is a leading --- … --- block.
  _splitFm(raw) {
    const text = String(raw == null ? '' : raw);
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { data: {}, body: text };
    let data = {};
    try { const ast = parse(m[1] + '\n'); if (ast && ast.kind === 'map') data = this._nodeToJs(ast); }
    catch { data = {}; }   // unparseable (e.g. external unquoted YAML) → re-stamp on next write
    return { data: data || {}, body: text.slice(m[0].length) };
  }
  _titleFromBody(body, rel) {
    const h = String(body || '').match(/^\s*#\s+(.+?)\s*$/m);
    if (h) return h[1].trim();
    const base = this._basename(rel || '');
    return base.replace(/\.[A-Za-z0-9]+$/, '') || '(untitled note)';
  }

  // ── low-level fs ──
  async _readText(abs) { try { return await this.vfs.readFile(abs, 'utf8'); } catch (e) { if (e && e.code === 'ENOENT') return null; throw e; } }
  async _writeText(abs, text) {
    const dir = this._dirname(abs);
    if (dir) await this.vfs.mkdir(dir, { recursive: true });
    await this.vfs.writeFile(abs, String(text));
  }

  // ── setup ──
  async ensure() {
    await this.vfs.mkdir(`${ROOT}/${INBOX}`, { recursive: true });
    if (!this.store.getFeed('stacks')) {
      await this.store.putFeed({ id: 'stacks', name: 'Stacks', adapter: 'stacks', url: '', next_poll_at: 8.64e15 });
    }
  }

  // ── scan: reconcile the on-disk tree with the index ──
  // Walks /stacks, stamps a uid into anything that lacks one, upserts each entry
  // (preserving human state), and flags vanished entries as missing.
  async scan() {
    const res = { notes: 0, files: 0, stamped: 0, missing: 0 };
    const present = new Set();
    const files = [];
    await this._walk(ROOT, files);
    for (const abs of files) {
      const rel = this._rel(abs);
      const base = this._basename(rel);
      if (isHidden(base) || isSidecar(rel)) continue;
      const entry = isNotePath(rel) ? await this._scanNote(abs, rel, res) : await this._scanFile(abs, rel, res);
      if (!entry) continue;
      present.add(entry.uid);
      this.store.syncStacksEntry(entry);
      isNotePath(rel) ? res.notes++ : res.files++;
    }
    res.missing = this.store.markStacksMissing(present);
    return res;
  }

  async _walk(dir, out) {
    let names; try { names = await this.vfs.readdir(dir); } catch { return out; }
    for (const name of names) {
      if (isHidden(name)) continue;   // git-friendly: never descend dotfolders
      const p = `${dir}/${name}`;
      let st; try { st = await this.vfs.stat(p); } catch { continue; }
      if (st.type === 'directory') await this._walk(p, out);
      else out.push(p);
    }
    return out;
  }

  async _scanNote(abs, rel, res) {
    const raw = await this._readText(abs);
    if (raw == null) return null;
    const { data, body } = this._splitFm(raw);
    let uid = data.uid;
    const created = this._parseTs(data.created);
    if (!uid) {   // stamp identity into the file (the anchor moves can't strip)
      uid = this._uid();
      const fm = this._fmEmit({ uid, title: data.title || this._titleFromBody(body, rel), tags: data.tags || [], created: new Date(created).toISOString(), source: data.source });
      await this._writeText(abs, `---\n${fm}---\n\n${body.replace(/^\n+/, '')}`);
      res.stamped++;
    }
    return {
      uid, path: rel, type: 'note',
      title: data.title || this._titleFromBody(body, rel),
      tags: Array.isArray(data.tags) ? data.tags : [],
      created, source: data.source,
      excerpt: deriveExcerpt(body, 300),
    };
  }

  async _scanFile(abs, rel, res) {
    const sidecarAbs = `${abs}.meta.json`;
    let data = {};
    const sc = await this._readText(sidecarAbs);
    if (sc) { try { data = JSON.parse(sc) || {}; } catch { data = {}; } }
    let uid = data.uid;
    const created = this._parseTs(data.created);
    if (!uid) {
      uid = this._uid();
      data = { uid, title: data.title || this._basename(rel), tags: data.tags || [], created: new Date(created).toISOString(), mime: data.mime || mimeFor(rel), source: data.source };
      await this._writeText(sidecarAbs, JSON.stringify(data, null, 2));
      res.stamped++;
    }
    return {
      uid, path: rel, type: 'file',
      title: data.title || this._basename(rel),
      tags: Array.isArray(data.tags) ? data.tags : [],
      created, source: data.source,
      mime: data.mime || mimeFor(rel),
      excerpt: this._basename(rel),
    };
  }

  _parseTs(v) {
    if (v == null) return now();
    if (typeof v === 'number') return v;
    const t = Date.parse(v);
    return Number.isFinite(t) ? t : now();
  }

  // ── authoring ──
  // Create a note. Returns the stored Item record.
  async writeNote({ folder = INBOX, name, title, markdown = '', tags = [], source, uid, created } = {}) {
    uid = uid || this._uid();
    created = created || now();
    title = title || this._titleFromBody(markdown, name || '');
    const base = this._safeName(name || slugify(title) || 'note', '.md');
    const rel = await this._uniqueRel(this._join(folder, base));
    const fm = this._fmEmit({ uid, title, tags, created: new Date(created).toISOString(), source });
    await this._writeText(this._abs(rel), `---\n${fm}---\n\n${String(markdown).trim()}\n`);
    const rec = this.store.syncStacksEntry({ uid, path: rel, type: 'note', title, tags, created, source, excerpt: deriveExcerpt(markdown, 300) });
    this.store.emit('items', { inserted: 1, updated: 0, skipped: 0 });
    return rec;
  }

  // Update an existing note's body (and optionally title/tags), keeping its uid +
  // created. Preserves any frontmatter keys weir doesn't manage.
  async saveNote(item, markdown, { title, tags } = {}) {
    const abs = this._abs(item.path);
    const raw = await this._readText(abs);
    const { data } = this._splitFm(raw == null ? '' : raw);
    const uid = data.uid || item.uid || this._uid();
    const created = this._parseTs(data.created) || item.published_at || now();
    const nextTitle = title != null ? title : (data.title || item.title);
    const nextTags = tags != null ? tags : (Array.isArray(data.tags) ? data.tags : (item.tags || []));
    const fm = this._fmEmit({ ...data, uid, title: nextTitle, tags: nextTags, created: new Date(created).toISOString() });
    await this._writeText(abs, `---\n${fm}---\n\n${String(markdown).trim()}\n`);
    const rec = this.store.syncStacksEntry({ uid, path: item.path, type: 'note', title: nextTitle, tags: nextTags, created, source: data.source, excerpt: deriveExcerpt(markdown, 300) });
    this.store.emit('item', { id: rec.id });
    return rec;
  }

  // Drop a binary file into the stacks (bytes = Uint8Array/ArrayBuffer).
  async addFile({ folder = INBOX, name, bytes, mime, tags = [], source, created } = {}) {
    const uid = this._uid();
    created = created || now();
    const base = this._safeName(name || 'file');
    const rel = await this._uniqueRel(this._join(folder, base));
    const abs = this._abs(rel);
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    await this.vfs.mkdir(this._dirname(abs), { recursive: true });
    await this.vfs.writeFile(abs, data);
    const meta = { uid, title: base, tags, created: new Date(created).toISOString(), mime: mime || mimeFor(base), source };
    await this._writeText(`${abs}.meta.json`, JSON.stringify(meta, null, 2));
    const rec = this.store.syncStacksEntry({ uid, path: rel, type: 'file', title: base, tags, created, source, mime: meta.mime, excerpt: base });
    this.store.emit('items', { inserted: 1, updated: 0, skipped: 0 });
    return rec;
  }

  // Move/refile an entry to another folder — keeps the uid (so state + links ride
  // along, STACKS.md §9). Renames the file and any sidecar.
  async move(item, toFolder) {
    const oldRel = item.path;
    const newRel = await this._uniqueRel(this._join(toFolder, this._basename(oldRel)));
    if (newRel === oldRel) return item;
    const oldAbs = this._abs(oldRel), newAbs = this._abs(newRel);
    await this.vfs.mkdir(this._dirname(newAbs), { recursive: true });
    try { await this.vfs.rename(oldAbs, newAbs); }
    catch { const buf = await this.vfs.readFile(oldAbs); await this.vfs.writeFile(newAbs, buf); await this.vfs.unlink(oldAbs).catch(() => {}); }
    if (item.type === 'file') { try { await this.vfs.rename(`${oldAbs}.meta.json`, `${newAbs}.meta.json`); } catch { /* no sidecar */ } }
    const rec = this.store.syncStacksEntry({ uid: item.uid, path: newRel, type: item.type, title: item.title, tags: item.tags, created: item.published_at, mime: item.mime, excerpt: item.excerpt });
    this.store.emit('items', { inserted: 0, updated: 1, skipped: 0 });
    return rec;
  }

  // Mirror an entry's current tags (and identity fields) back into its file —
  // note frontmatter or file .meta.json sidecar — so an external tag change (e.g.
  // via the MCP tools) stays portable/Obsidian-readable. Shard stays source of truth.
  async syncTagsToFile(item) {
    const abs = this._abs(item.path);
    const created = new Date(item.published_at || now()).toISOString();
    if (item.type === 'note') {
      const raw = await this._readText(abs); if (raw == null) return;
      const { data, body } = this._splitFm(raw);
      const fm = this._fmEmit({ ...data, uid: item.uid || data.uid, title: item.title || data.title, tags: item.tags || [], created: data.created || created });
      await this._writeText(abs, `---\n${fm}---\n\n${body.replace(/^\n+/, '')}`);
    } else {
      const scAbs = `${abs}.meta.json`;
      let data = {}; const sc = await this._readText(scAbs); if (sc) { try { data = JSON.parse(sc) || {}; } catch { data = {}; } }
      data = { ...data, uid: item.uid || data.uid, title: item.title || data.title, tags: item.tags || [], mime: item.mime || data.mime, created: data.created || created };
      await this._writeText(scAbs, JSON.stringify(data, null, 2));
    }
  }

  // Delete an entry — but honor "never really delete": move the file (+ sidecar)
  // into /stacks/.trash/ (a dotfolder the scanner ignores), so it vanishes from weir
  // while the bytes survive on disk, recoverable. Drops the index entry. Returns
  // { trashed, dest } so the caller can offer undo (restoreFromTrash).
  async trash(item) {
    const oldRel = item.path; const oldAbs = this._abs(oldRel);
    const dest = `.trash/${item.uid || hash32(oldRel)}__${this._basename(oldRel)}`;
    const destAbs = this._abs(dest);
    await this.vfs.mkdir(this._dirname(destAbs), { recursive: true });
    try { await this.vfs.rename(oldAbs, destAbs); }
    catch { const b = await this.vfs.readFile(oldAbs); await this.vfs.writeFile(destAbs, b); await this.vfs.unlink(oldAbs).catch(() => {}); }
    if (item.type === 'file') { try { await this.vfs.rename(`${oldAbs}.meta.json`, `${destAbs}.meta.json`); } catch { /* no sidecar */ } }
    const id = `stacks:${item.uid}`;
    this.store.items.delete(id); this.store._feedSet('stacks').delete(id);
    this.store._markFeedDirty('stacks');
    this.store.emit('items', { inserted: 0, updated: 0, skipped: 0, removed: 1 });
    return { trashed: oldRel, dest };
  }
  // Undo a trash: move the file back and re-index it.
  async restoreFromTrash(dest, toRel) {
    const destAbs = this._abs(dest), toAbs = this._abs(toRel);
    await this.vfs.mkdir(this._dirname(toAbs), { recursive: true });
    try { await this.vfs.rename(destAbs, toAbs); }
    catch { const b = await this.vfs.readFile(destAbs); await this.vfs.writeFile(toAbs, b); await this.vfs.unlink(destAbs).catch(() => {}); }
    try { await this.vfs.rename(`${destAbs}.meta.json`, `${toAbs}.meta.json`); } catch { /* no sidecar */ }
    const res = { stamped: 0 };
    const entry = isNotePath(toRel) ? await this._scanNote(toAbs, toRel, res) : await this._scanFile(toAbs, toRel, res);
    if (entry) { this.store.syncStacksEntry(entry); this.store.emit('items', { inserted: 1, updated: 0, skipped: 0 }); }
    return entry;
  }

  // The markdown body of a note (frontmatter stripped), for the reader/editor.
  async readNote(item) {
    const raw = await this.store.getContent(item.id);
    if (raw == null) return '';
    return this._splitFm(raw).body.replace(/^\n+/, '');
  }
  // Raw bytes of a file entry, for preview/download.
  async readBytes(item) { try { return await this.vfs.readFile(this._abs(item.path)); } catch { return null; } }

  // ── consume the Telegram notes stash into /stacks/inbox/ ──
  async ingestStash() {
    const raw = await this._readText(STACKS_STASH);
    if (!raw || !raw.trim()) return 0;
    let n = 0;
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      const md = String(j.text || '').trim();
      if (!md) continue;
      const title = (md.split('\n')[0] || 'note').slice(0, 80);
      await this.writeNote({ folder: INBOX, title, markdown: md, tags: ['telegram'], source: 'telegram', created: j.at });
      n++;
    }
    try { await this.vfs.writeFile(STACKS_STASH, ''); } catch { /* best effort */ }   // consumed
    return n;
  }

  // ── views for the rail/tree ──
  entries() {
    const out = [];
    for (const id of this.store._feedSet('stacks')) { const r = this.store.getItem(id); if (r) out.push(r); }
    return out.sort((a, b) => (a.path || '').localeCompare(b.path || ''));
  }
  forgetMissing() { return this.store.forgetMissingStacks(); }
}
