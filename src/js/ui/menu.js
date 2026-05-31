// Tiny context-menu primitive. showMenu(x, y, items) where each item is
// { label, onClick, danger } or { sep: true }. Closes on outside-click, Esc,
// scroll, or selection. Themed via Switchboard tokens in style.css.

let _el = null;

export function closeMenu() {
  if (!_el) return;
  _el.remove(); _el = null;
  document.removeEventListener('pointerdown', _onDown, true);
  document.removeEventListener('keydown', _onKey, true);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('resize', closeMenu);
}

function _onDown(e) { if (_el && !_el.contains(e.target)) closeMenu(); }
function _onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); } }

export function showMenu(x, y, items) {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'ctxmenu';
  for (const it of items) {
    if (!it) continue;
    if (it.sep) { const s = document.createElement('div'); s.className = 'ctxsep'; el.appendChild(s); continue; }
    const b = document.createElement('button');
    b.className = 'ctxitem' + (it.danger ? ' danger' : '');
    b.textContent = it.label;
    if (it.disabled) b.disabled = true;
    else b.addEventListener('click', () => { closeMenu(); try { it.onClick?.(); } catch (e) { console.error(e); } });
    el.appendChild(b);
  }
  document.body.appendChild(el);
  const r = el.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(x, window.innerWidth - r.width - 6))}px`;
  el.style.top = `${Math.max(4, Math.min(y, window.innerHeight - r.height - 6))}px`;
  _el = el;
  // Defer listener attach so the opening click/contextmenu doesn't immediately close it.
  setTimeout(() => {
    document.addEventListener('pointerdown', _onDown, true);
    document.addEventListener('keydown', _onKey, true);
    window.addEventListener('blur', closeMenu);
    window.addEventListener('resize', closeMenu);
  }, 0);
}
