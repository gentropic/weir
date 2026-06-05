// Command palette — a centered fuzzy launcher over the app's actions and
// navigation targets (Cmd/Ctrl-K). Keyboard-first: type to filter, ↑/↓ (or
// Ctrl-N/P) move, Enter runs, Esc closes. Built fresh each open from a flat
// action list the app assembles, so entries always reflect the current
// sources / folders / views / routes. Themed via Switchboard tokens in style.css.
//
// An action is { label, kind, hint?, run } — `kind` is the dim right-side tag
// ("Go", "Do", "Source", …); `hint` is optional secondary text also searched.

// Subsequence match: returns the matched character indices in `text` (already
// lowercased) for query `q`, or null if `q` isn't a subsequence. Greedy/earliest.
function matchIndices(text, q) {
  let i = 0; const idx = [];
  for (const ch of q) {
    const p = text.indexOf(ch, i);
    if (p < 0) return null;
    idx.push(p); i = p + 1;
  }
  return idx;
}

// Lower is better. Big bonus for a contiguous run (a real substring), then
// reward tightness (small span) and an early first hit.
function rankText(text, q) {
  const idx = matchIndices(text, q);
  if (!idx) return null;
  const span = idx[idx.length - 1] - idx[0];
  const contiguous = span === idx.length - 1 ? -1000 : 0;
  return contiguous + span + idx[0] * 0.5;
}

// A leading sigil scopes the search to one kind (the rest of the list is hidden):
// `>` commands, `@` sources, `#` routes. No sigil → search everything.
const SCOPE_SIGILS = { '>': 'Command', '@': 'Source', '#': 'Route' };

// Split a raw query into its scope (a kind, or null) and the bare query text.
export function parseScoped(query) {
  let q = (query || '').replace(/^\s+/, '');
  const kind = q && SCOPE_SIGILS[q[0]] ? SCOPE_SIGILS[q[0]] : null;
  if (kind) q = q.slice(1);
  return { kind, q: q.trim() };
}

// Filter + rank actions for a query. Empty query → original order (groups intact).
// Label matches beat matches that only hit the kind/hint haystack.
export function filterActions(actions, query) {
  const { kind, q: bare } = parseScoped(query);
  const pool = kind ? actions.filter((a) => a.kind === kind) : actions;
  const q = bare.toLowerCase();
  if (!q) return pool.slice();
  const scored = [];
  for (const a of pool) {
    let r = rankText(a.label.toLowerCase(), q);
    if (r == null) {
      const hay = `${a.kind || ''} ${a.label} ${a.hint || ''}`.toLowerCase();
      r = rankText(hay, q);
      if (r == null) continue;
      r += 50;   // demote: matched only via kind/hint, not the label itself
    }
    scored.push({ a, r });
  }
  scored.sort((x, y) => x.r - y.r);
  return scored.map((s) => s.a);
}

let _palEl = null, _onDoc = null;

export function closePalette() {
  if (!_palEl) return;
  _palEl.remove(); _palEl = null;
  if (_onDoc) { document.removeEventListener('keydown', _onDoc, true); _onDoc = null; }
}

function highlight(label, q) {
  const idx = q ? matchIndices(label.toLowerCase(), q.trim().toLowerCase()) : null;
  if (!idx) return palEsc(label);
  let out = '', last = 0; const set = new Set(idx);
  for (let i = 0; i < label.length; i++) {
    if (set.has(i)) { out += `${palEsc(label.slice(last, i))}<b>${palEsc(label[i])}</b>`; last = i + 1; }
  }
  return out + palEsc(label.slice(last));
}

function palEsc(s) { return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

export function showPalette(actions, opts = {}) {
  closePalette();
  const overlay = document.createElement('div');
  overlay.className = 'palette-overlay';
  overlay.innerHTML = '<div class="palette" role="dialog" aria-label="Command palette">'
    + '<input class="palette-input" type="text" placeholder="Jump to a source or view, or run a command…" autocomplete="off" autocapitalize="off" spellcheck="false">'
    + '<div class="palette-list" role="listbox"></div>'
    + '<div class="palette-hintbar"><b>&gt;</b> commands&nbsp;&nbsp;<b>@</b> sources&nbsp;&nbsp;<b>#</b> routes</div></div>';
  document.body.appendChild(overlay);
  _palEl = overlay;
  const input = overlay.querySelector('.palette-input');
  const list = overlay.querySelector('.palette-list');

  let filtered = actions, active = 0;

  const render = () => {
    const q = parseScoped(input.value).q;   // highlight the bare query, not the sigil
    list.innerHTML = filtered.length
      ? filtered.map((a, i) =>
        `<div class="palette-row${i === active ? ' active' : ''}" role="option" data-i="${i}">`
        + `<span class="palette-label">${highlight(a.label, q)}</span>`
        + (a.hint ? `<span class="palette-hint">${palEsc(a.hint)}</span>` : '')
        + (a.kind ? `<span class="palette-kind">${palEsc(a.kind)}</span>` : '')
        + '</div>').join('')
      : '<div class="palette-empty">No matches</div>';
    const cur = list.querySelector('.palette-row.active');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  };

  const refilter = () => { filtered = filterActions(actions, input.value); active = 0; render(); };
  const move = (d) => { if (!filtered.length) return; active = (active + d + filtered.length) % filtered.length; render(); };
  const run = () => { const a = filtered[active]; if (!a) return; closePalette(); try { opts.onRun && opts.onRun(a); } catch { /* recorder must never block the action */ } try { a.run(); } catch (e) { console.error('palette action', e); } };

  input.addEventListener('input', refilter);
  list.addEventListener('mousemove', (e) => { const r = e.target.closest('.palette-row'); if (r) { const i = +r.dataset.i; if (i !== active) { active = i; render(); } } });
  list.addEventListener('click', (e) => { const r = e.target.closest('.palette-row'); if (r) { active = +r.dataset.i; run(); } });

  // Capture-phase so palette keys win over the app's global j/k handler.
  _onDoc = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePalette(); return; }
    if (e.key === 'ArrowDown' || (e.ctrlKey && (e.key === 'n' || e.key === 'N'))) { e.preventDefault(); e.stopPropagation(); move(1); return; }
    if (e.key === 'ArrowUp' || (e.ctrlKey && (e.key === 'p' || e.key === 'P'))) { e.preventDefault(); e.stopPropagation(); move(-1); return; }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); run(); return; }
    // Re-summoning Cmd/Ctrl-K while open closes it (toggle).
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); e.stopPropagation(); closePalette(); }
  };
  document.addEventListener('keydown', _onDoc, true);
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) closePalette(); });

  render();
  input.focus();
}
