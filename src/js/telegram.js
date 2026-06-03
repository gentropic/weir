// Telegram influxer — a gentle poll loop that drains your weir bot's getUpdates
// while weir is open. Each message becomes a capture: a URL-bearing message (incl.
// a Google Discover share, blurb + link) → a Saved Link (the resolver unwraps +
// enriches it); a pure-text message → a NOTE, stashed to a pending file until the
// notes system lands (so nothing's lost or bricked into a Telegram-blurb shape).
//
// No server, no webhook, no bridge: api.telegram.org is CORS-friendly, so a plain
// fetch works. The bot token lives in the OPFS vault; the offset (last update_id)
// is persisted so nothing re-ingests across reloads. getUpdates is SINGLE-consumer
// — use a fresh, weir-only bot (no webhook, no other poller, e.g. retire rei's).

import { messageLinks } from './importers.js';

const TG_API = 'https://api.telegram.org';
const NOTES_STASH = '/telegram-notes.ndjson';

export class TelegramInflux {
  constructor(store, { fetch, getToken, onLinks, intervalMs = 18_000 } = {}) {
    this.store = store;
    this.fetch = fetch || ((u, o) => globalThis.fetch(u, o));   // direct — CORS-ok, no bridge
    this.getToken = getToken;
    this.onLinks = onLinks;        // (links[]) => Promise, usually app.importLinks
    this.intervalMs = intervalMs;
    this._timer = null; this._busy = false;
    this.status = { enabled: false, bot: null, bound: null, lastPoll: null, captured: 0, notes: 0, ignored: 0, error: null };
    this._listeners = new Set();
  }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  _emit() { const s = { ...this.status }; this._listeners.forEach((f) => { try { f(s); } catch { /* ignore */ } }); }

  _offset() { return this.store.getSettings().telegram_offset || 0; }
  _setOffset(n) { return this.store.setSettings({ telegram_offset: n }); }

  start() {
    if (this._timer) return;
    this.status.enabled = true; this._emit();
    this._timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
    if (this._timer && typeof this._timer.unref === 'function') this._timer.unref();
    this.tick().catch(() => {});
  }
  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } this.status.enabled = false; this._emit(); }

  // One-time check for the settings UI: confirm the token + grab the bot's @username.
  async verify(token) {
    try {
      const r = await this.fetch(`${TG_API}/bot${token}/getMe`);
      const j = JSON.parse(await r.text());
      if (j && j.ok && j.result) { this.status.bot = j.result.username || j.result.first_name; this._emit(); return { ok: true, username: j.result.username }; }
      return { ok: false, error: (j && j.description) || 'getMe failed' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // Pure-text messages are notes — stash them (date + text + sender) so they survive
  // until the notes system consumes /telegram-notes.ndjson. Never lost, never bricked.
  async _stashNote(msg) {
    const rec = JSON.stringify({ at: msg.date ? msg.date * 1000 : Date.now(), text: msg.text, from: msg.from && (msg.from.username || msg.from.first_name) || null });
    try { const prev = await this.store._readText(NOTES_STASH, ''); await this.store.vfs.writeFile(NOTES_STASH, (prev ? prev + '\n' : '') + rec); } catch { /* best effort */ }
  }

  async tick() {
    if (this._busy) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;   // poll only while visible
    const token = this.getToken ? await this.getToken() : null;
    if (!token) return;
    this._busy = true;
    try {
      const offset = this._offset();
      const r = await this.fetch(`${TG_API}/bot${token}/getUpdates?timeout=0&offset=${offset}&allowed_updates=${encodeURIComponent('["message"]')}`);
      const j = JSON.parse(await r.text());
      this.status.lastPoll = Date.now();
      if (!j || !j.ok) { this.status.error = (j && j.description) || 'getUpdates failed'; this._emit(); return; }
      this.status.error = null;
      const updates = j.result || [];
      if (!updates.length) { this._emit(); return; }
      let maxId = offset - 1;
      const links = [];
      // Owner filter: a bot accepts messages from ANYONE who finds it, so only ingest
      // from your own Telegram id. Unset → AUTO-BIND to the first sender (you, since
      // it's a fresh private bot); after that, strangers are ignored. Clear the id in
      // Settings to re-bind. Manual paste also works.
      let allowed = this.store.getSettings().telegram_allowed_id || 0;
      this.status.bound = allowed || null;
      for (const u of updates) {
        if (u.update_id > maxId) maxId = u.update_id;
        const msg = u.message; if (!msg) continue;
        const fromId = msg.from && msg.from.id;
        if (!allowed && fromId) { allowed = fromId; this.status.bound = fromId; await this.store.setSettings({ telegram_allowed_id: fromId }); }
        if (allowed && fromId !== allowed) { this.status.ignored++; continue; }   // not you → ignore (don't capture or stash)
        const ls = messageLinks(msg.text, msg.entities);
        if (ls.length) for (const l of ls) links.push({ ...l, date: msg.date ? msg.date * 1000 : undefined });
        else if ((msg.text || '').trim()) { await this._stashNote(msg); this.status.notes++; }   // a note → stash for the notes system
      }
      await this._setOffset(maxId + 1);   // confirm → Telegram drops the consumed updates
      if (links.length && this.onLinks) { await this.onLinks(links); this.status.captured += links.length; }
      this._emit();
    } catch (e) {
      this.status.error = String((e && e.message) || e); this._emit();
    } finally { this._busy = false; }
  }
}
