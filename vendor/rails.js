// ⚠ GENERATED FILE — DO NOT EDIT. Source: ext/rails/src/  Build: node ext/rails/build.js
// @gcu/rails — layout engine for docked tab-based workspaces
// Rails, stacks, tabs. Panels never reparent. Zero dependencies.

// -- state.js --

// @gcu/rails — state operations
// Pure functions over the State tree. Zero DOM, zero imports.
//
// State shape (informative, see SPEC-rails §3):
//   State  = { rails: Rail[], floats: Float[] }           — floats deferred to next pass
//   Rail   = { id, flex, width?, stacks: Stack[] }
//   Stack  = { id, flex, height?, tabs: Tab[], active, tabPosition? }
//   Tab    = { id, title, closeable?, draggable?, ...consumer }

let _nextIdCounter = 1;

// Bare numeric id — only safe when state is empty or ids don't collide.
// Prefer freshId(state, prefix) for runtime insertions.
function makeId(prefix) {
  return prefix + (_nextIdCounter++).toString(36);
}

// Collect every id currently in state (rails, stacks, tabs, floats).
function collectIds(state) {
  const used = new Set();
  for (const rail of state.rails || []) {
    if (rail.id) used.add(rail.id);
    for (const stack of rail.stacks || []) {
      if (stack.id) used.add(stack.id);
      for (const tab of stack.tabs || []) {
        if (tab.id) used.add(tab.id);
      }
    }
  }
  for (const float of state.floats || []) {
    if (float.id) used.add(float.id);
    for (const tab of float.stack?.tabs || []) {
      if (tab.id) used.add(tab.id);
    }
  }
  return used;
}

// Generate an id with the given prefix that doesn't collide with anything
// currently in state. Use this for any id created at runtime — seed states
// with user-chosen ids (e.g., 's1', 's2', 'r1') are common and will
// otherwise clash with naive counter-based ids.
function freshId(state, prefix) {
  const used = collectIds(state);
  while (true) {
    const id = prefix + (_nextIdCounter++).toString(36);
    if (!used.has(id)) return id;
  }
}

function findTab(state, tabId) {
  for (const rail of state.rails) {
    for (const stack of rail.stacks) {
      const idx = stack.tabs.findIndex(t => t.id === tabId);
      if (idx >= 0) return { rail, stack, tab: stack.tabs[idx], idx, container: 'rail' };
    }
  }
  for (const float of state.floats || []) {
    if (!float.stack) continue;
    const idx = float.stack.tabs.findIndex(t => t.id === tabId);
    if (idx >= 0) return { float, stack: float.stack, tab: float.stack.tabs[idx], idx, container: 'float' };
  }
  return null;
}

function findFloat(state, floatId) {
  for (const float of state.floats || []) {
    if (float.id === floatId) return float;
  }
  return null;
}

function findStack(state, stackId) {
  for (const rail of state.rails) {
    for (const stack of rail.stacks) {
      if (stack.id === stackId) return { rail, stack, container: 'rail' };
    }
  }
  for (const float of state.floats || []) {
    if (float.stack && float.stack.id === stackId) {
      return { float, stack: float.stack, container: 'float' };
    }
  }
  return null;
}

function findRail(state, railId) {
  for (const rail of state.rails) {
    if (rail.id === railId) return rail;
  }
  return null;
}

// Remove a tab from its stack. Returns the removed Tab or null.
// Leaves the stack potentially empty; call cleanup(instance) after.
function removeTabFromStack(state, tabId) {
  const hit = findTab(state, tabId);
  if (!hit) return null;
  hit.stack.tabs.splice(hit.idx, 1);
  if (hit.stack.active === tabId && hit.stack.tabs.length) {
    const fallback = Math.max(0, hit.idx - 1);
    hit.stack.active = hit.stack.tabs[fallback].id;
  }
  return hit.tab;
}

// Cleanup pass: drop empty stacks, empty rails, empty floats. Reselect active
// when needed.
//
// Caller is responsible for deciding when to evict panels: closeTab evicts,
// moveTab does not. This function handles the structural cleanup of empty
// containers and does NOT touch the panel cache.
function cleanup(state) {
  for (const rail of state.rails) {
    rail.stacks = rail.stacks.filter(s => s.tabs.length > 0);
    for (const s of rail.stacks) {
      if (!s.tabs.find(t => t.id === s.active)) {
        s.active = s.tabs[0].id;
      }
    }
  }
  state.rails = state.rails.filter(r => r.stacks.length > 0);

  // Empty float's stack → float removed entirely (invariant 3).
  if (Array.isArray(state.floats)) {
    state.floats = state.floats.filter(f => f.stack && f.stack.tabs.length > 0);
    for (const f of state.floats) {
      if (!f.stack.tabs.find(t => t.id === f.stack.active)) {
        f.stack.active = f.stack.tabs[0].id;
      }
    }
  }
}

// Collect the set of tab ids currently in state. Used to decide panel evictions.
function liveTabIds(state) {
  const ids = new Set();
  for (const rail of state.rails) {
    for (const stack of rail.stacks) {
      for (const tab of stack.tabs) ids.add(tab.id);
    }
  }
  for (const float of state.floats || []) {
    for (const tab of float.stack?.tabs || []) ids.add(tab.id);
  }
  return ids;
}

// Validate that a minimal state satisfies invariants §2.2. Throws on violation.
// Run after deserialize / programmatic state replacement. Skipped in hot paths.
function validateState(state) {
  if (!state || !Array.isArray(state.rails)) {
    throw new Error('rails: state.rails must be an array');
  }
  const seenTabIds = new Set();
  const seenStackIds = new Set();
  const seenRailIds = new Set();
  const seenFloatIds = new Set();

  for (const rail of state.rails) {
    if (!rail.id) throw new Error('rails: rail missing id');
    if (seenRailIds.has(rail.id)) throw new Error(`rails: duplicate rail id ${rail.id}`);
    seenRailIds.add(rail.id);
    if (!Array.isArray(rail.stacks) || rail.stacks.length === 0) {
      throw new Error(`rails: rail ${rail.id} must contain at least one stack`);
    }
    for (const stack of rail.stacks) {
      validateStack(stack, seenStackIds, seenTabIds);
    }
  }

  for (const float of state.floats || []) {
    if (!float.id) throw new Error('rails: float missing id');
    if (seenFloatIds.has(float.id)) throw new Error(`rails: duplicate float id ${float.id}`);
    seenFloatIds.add(float.id);
    if (!float.stack) throw new Error(`rails: float ${float.id} missing stack`);
    validateStack(float.stack, seenStackIds, seenTabIds);
    for (const dim of ['x', 'y', 'w', 'h', 'z']) {
      if (typeof float[dim] !== 'number' || !Number.isFinite(float[dim])) {
        throw new Error(`rails: float ${float.id} ${dim} must be a finite number`);
      }
    }
  }
}

function validateStack(stack, seenStackIds, seenTabIds) {
  if (!stack.id) throw new Error('rails: stack missing id');
  if (seenStackIds.has(stack.id)) throw new Error(`rails: duplicate stack id ${stack.id}`);
  seenStackIds.add(stack.id);
  if (!Array.isArray(stack.tabs) || stack.tabs.length === 0) {
    throw new Error(`rails: stack ${stack.id} must contain at least one tab`);
  }
  for (const tab of stack.tabs) {
    if (!tab.id) throw new Error('rails: tab missing id');
    if (seenTabIds.has(tab.id)) throw new Error(`rails: duplicate tab id ${tab.id}`);
    seenTabIds.add(tab.id);
  }
  if (!stack.tabs.find(t => t.id === stack.active)) {
    throw new Error(`rails: stack ${stack.id} active references missing tab ${stack.active}`);
  }
}

// Merge-patch a tab's fields. Returns {changed, chromeVisible} for render routing.
// chromeVisible fields force a structural strip rebuild; others are payload-only.
const CHROME_VISIBLE_FIELDS = new Set(['title', 'closeable', 'draggable', 'badge']);

function patchTab(state, tabId, patch) {
  const hit = findTab(state, tabId);
  if (!hit) return { changed: false, chromeVisible: false };
  let changed = false;
  let chromeVisible = false;
  for (const key of Object.keys(patch)) {
    if (key === 'id') continue;
    if (hit.tab[key] !== patch[key]) {
      hit.tab[key] = patch[key];
      changed = true;
      if (CHROME_VISIBLE_FIELDS.has(key)) chromeVisible = true;
    }
  }
  return { changed, chromeVisible };
}

// Serialize state to JSON. Consumer passes a replacer for non-JSON tab fields.
function serializeState(state, replacer) {
  return JSON.stringify(state, replacer);
}

// Default empty state — valid per invariant 7 (empty workspace legal).
function emptyState() {
  return { rails: [], floats: [] };
}

// -- render.js --

// @gcu/rails — chrome rendering + content positioning + panel cache
// DOM-touching. Expects an instance object holding host/chromeLayer/contentLayer/state/panels/callbacks.


function cssEscape(s) {
  return (typeof window !== 'undefined' && window.CSS && window.CSS.escape)
    ? window.CSS.escape(s)
    : String(s).replace(/["\\]/g, '\\$&');
}

// z-index scheme. Rail panels sit at RAIL_PANEL_Z, above rail/stack splitters
// (z:2) but below the lowest float. Each float gets a 10-unit z-band:
//   chrome  (titlebar/strip/slot)        : base + z*10 + 0
//   panel   (the rendered tab body)      : base + z*10 + 5
//   handles (resize handles overlay)     : base + z*10 + 6
// The handles overlay is a sibling of the float (not a child), so it lives
// outside the float's stacking context and can paint above the panel — which
// otherwise would cover the bottom and side handles wherever the slot extends
// to the float's edges. The next float's chrome starts at +10 above this one,
// so float windows still stack as discrete units.
const RAIL_PANEL_Z = 5;
const FLOAT_Z_BASE = 100;
const FLOAT_Z_STEP = 10;
const FLOAT_PANEL_OFFSET = 5;
const FLOAT_HANDLES_OFFSET = 6;

function floatChromeZ(z) {
  return FLOAT_Z_BASE + z * FLOAT_Z_STEP;
}

function floatPanelZ(z) {
  return FLOAT_Z_BASE + z * FLOAT_Z_STEP + FLOAT_PANEL_OFFSET;
}

function floatHandlesZ(z) {
  return FLOAT_Z_BASE + z * FLOAT_Z_STEP + FLOAT_HANDLES_OFFSET;
}

// Chrome sublayer structure (built once in api.js's createRails init):
//
//   .rails-chrome
//     .rails-rails     — rail/stack layout, rebuilt on structural rail changes
//     .rails-floats    — float frames, rebuilt on structural float changes
//
// renderChrome wipes + rebuilds both sublayers from state. Float raise and
// stack activate are in-place and do NOT rebuild (see activateInPlace,
// raiseFloatInPlace in api.js / drag.js).

function ensureSublayers(inst) {
  if (!inst.railsLayer) {
    inst.railsLayer = document.createElement('div');
    inst.railsLayer.className = 'rails-rails';
    inst.chromeLayer.appendChild(inst.railsLayer);
  }
  if (!inst.floatsLayer) {
    inst.floatsLayer = document.createElement('div');
    inst.floatsLayer.className = 'rails-floats';
    inst.chromeLayer.appendChild(inst.floatsLayer);
  }
}

function renderChrome(inst) {
  ensureSublayers(inst);
  inst.railsLayer.innerHTML = '';
  inst.floatsLayer.innerHTML = '';
  inst._emptyEl = null;

  // Empty workspace: mount renderEmpty() if provided.
  if (inst.state.rails.length === 0 && (!inst.state.floats || inst.state.floats.length === 0)) {
    if (inst.callbacks.renderEmpty) {
      const el = inst.callbacks.renderEmpty();
      if (el) {
        el.classList.add('rails-empty');
        inst.railsLayer.appendChild(el);
        inst._emptyEl = el;
      }
    }
    reposition(inst);
    inst._emit('layout:change', { state: inst.state });
    return;
  }

  renderRails(inst);
  renderFloats(inst);
  reposition(inst);
  inst._emit('layout:change', { state: inst.state });
}

function buildRailBtn(inst, rail, kind) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = kind === 'expand' ? 'rails-rail-expand-btn' : 'rails-rail-collapse-btn';
  btn.textContent = kind === 'expand' ? '\u25b6' : '\u25c0';
  btn.setAttribute('aria-label', kind === 'expand' ? 'Expand rail' : 'Collapse rail');
  btn.title = kind === 'expand' ? 'Expand rail' : 'Collapse rail';
  btn.tabIndex = -1;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    inst._toggleRailCollapsed(rail.id);
  });
  return btn;
}

function renderRails(inst) {
  inst.state.rails.forEach((rail, ri) => {
    const railEl = document.createElement('div');
    railEl.className = 'rails-rail';
    if (rail.collapsed) railEl.classList.add('rails-collapsed');
    railEl.dataset.railId = rail.id;

    if (rail.collapsed) {
      // Collapsed rail: fixed-width strip with a restore button. No stacks
      // render; their panels are hidden by reposition (no slot found).
      railEl.style.flex = '0 0 32px';
      railEl.appendChild(buildRailBtn(inst, rail, 'expand'));
    } else {
      if (rail.width != null) {
        railEl.style.flex = `0 0 ${rail.width}px`;
      } else {
        railEl.style.flex = rail.flex ?? 1;
      }

      rail.stacks.forEach((stack, si) => {
        const stackEl = buildStackEl(inst, stack);
        if (stack.height != null) {
          stackEl.style.flex = `0 0 ${stack.height}px`;
        } else {
          stackEl.style.flex = stack.flex ?? 1;
        }
        railEl.appendChild(stackEl);

        if (si < rail.stacks.length - 1) {
          const sp = document.createElement('div');
          sp.className = 'rails-stack-split';
          sp.addEventListener('pointerdown', e => inst._onSplitterDown(e, 'stack', rail, si));
          railEl.appendChild(sp);
        }
      });

      // For collapsible rails, append the collapse button into the first
      // stack's strip-wrap so it sits as a flex sibling of the tabs/overflow
      // button (intentional neighbors), not absolutely-positioned over them.
      if (rail.collapsible && rail.stacks.length > 0) {
        const firstWrap = railEl.querySelector('.rails-strip-wrap');
        if (firstWrap) firstWrap.appendChild(buildRailBtn(inst, rail, 'collapse'));
      }
    }

    inst.railsLayer.appendChild(railEl);

    if (ri < inst.state.rails.length - 1) {
      const sp = document.createElement('div');
      sp.className = 'rails-rail-split';
      sp.addEventListener('pointerdown', e => inst._onSplitterDown(e, 'rail', null, ri));
      inst.railsLayer.appendChild(sp);
    }
  });
}

// Build a fully-assembled .rails-stack element (no size styling applied yet;
// caller handles flex/width/height). Used for rail-stacks and float-stacks.
function buildStackEl(inst, stack) {
  const stackEl = document.createElement('div');
  stackEl.className = 'rails-stack';
  const tabPos = stack.tabPosition || inst.config.tabPosition || 'top';
  if (tabPos === 'bottom') stackEl.classList.add('rails-tabs-bottom');
  stackEl.dataset.stackId = stack.id;

  const stripWrap = buildStripWrap(inst, stack);
  const slot = document.createElement('div');
  slot.className = 'rails-slot';
  slot.dataset.slotFor = stack.id;
  // ARIA: slot holds the active panel via its cached element.
  slot.setAttribute('role', 'tabpanel');
  slot.id = `rails-panel-${stack.id}`;

  if (tabPos === 'bottom') {
    stackEl.append(slot, stripWrap);
  } else {
    stackEl.append(stripWrap, slot);
  }
  return stackEl;
}

// Strip wrapper — flex row holding the scrollable strip + overflow button.
// The button lives next to (not inside) the scrollable strip so it doesn't
// scroll away with the tabs.
function buildStripWrap(inst, stack) {
  const wrap = document.createElement('div');
  wrap.className = 'rails-strip-wrap';
  const strip = buildStrip(inst, stack);
  const overflowBtn = buildOverflowBtn(inst, stack, strip);
  wrap.append(strip, overflowBtn);
  return wrap;
}

function buildOverflowBtn(inst, stack, strip) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'rails-overflow-btn';
  btn.textContent = '\u22ef'; // ⋯
  btn.setAttribute('aria-label', 'Overflow tabs');
  btn.title = 'Overflow tabs';
  btn.tabIndex = -1;
  btn.hidden = true;
  btn.addEventListener('click', e => {
    e.stopPropagation();
    const overflowTabs = computeOverflowTabs(strip, stack);
    const r = btn.getBoundingClientRect();
    inst._emit('strip:overflow', {
      stack, overflowTabs,
      x: r.right, y: r.bottom,
    });
  });
  // Observe the strip for size/content changes; toggle btn visibility.
  if (typeof ResizeObserver !== 'undefined') {
    const ro = new ResizeObserver(() => updateOverflowBtn(btn, strip));
    ro.observe(strip);
  }
  // Initial compute in a microtask so layout has run.
  Promise.resolve().then(() => updateOverflowBtn(btn, strip));
  return btn;
}

function updateOverflowBtn(btn, strip) {
  if (!btn.isConnected) return;
  const overflow = strip.scrollWidth > strip.clientWidth + 1;
  btn.hidden = !overflow;
}

function computeOverflowTabs(strip, stack) {
  // Tabs whose rendered edges fall outside the strip's visible viewport.
  const tabEls = strip.querySelectorAll(':scope > .rails-tab');
  const sr = strip.getBoundingClientRect();
  const out = [];
  tabEls.forEach(el => {
    const r = el.getBoundingClientRect();
    if (r.right > sr.right + 1 || r.left < sr.left - 1) {
      const tab = stack.tabs.find(t => t.id === el.dataset.tabId);
      if (tab) out.push(tab);
    }
  });
  return out;
}

function buildStrip(inst, stack) {
  const strip = document.createElement('div');
  strip.className = 'rails-strip';
  strip.dataset.stackId = stack.id;
  strip.setAttribute('role', 'tablist');
  strip.tabIndex = 0;

  strip.addEventListener('contextmenu', e => {
    if (e.target === strip) {
      e.preventDefault();
      inst._emit('strip:contextmenu', { stack, x: e.clientX, y: e.clientY });
    }
  });
  strip.addEventListener('keydown', e => inst._onStripKeyDown(e, stack));

  stack.tabs.forEach(tab => {
    const tabEl = document.createElement('div');
    tabEl.className = 'rails-tab';
    if (tab.id === stack.active) tabEl.classList.add('rails-active');
    if (tab.closeable === false) tabEl.classList.add('rails-pinned-closed');
    if (tab.draggable === false) tabEl.classList.add('rails-locked');
    tabEl.dataset.tabId = tab.id;

    // ARIA
    tabEl.setAttribute('role', 'tab');
    tabEl.setAttribute('aria-selected', tab.id === stack.active ? 'true' : 'false');
    tabEl.setAttribute('aria-controls', `rails-panel-${stack.id}`);
    tabEl.id = `rails-tab-${tab.id}`;
    tabEl.tabIndex = tab.id === stack.active ? 0 : -1;

    const label = document.createElement('span');
    label.className = 'rails-tab-label';
    label.textContent = tab.title ?? tab.id;
    tabEl.appendChild(label);

    if (tab.badge != null && tab.badge !== '') {
      const badge = document.createElement('span');
      badge.className = 'rails-tab-badge';
      badge.textContent = String(tab.badge);
      tabEl.appendChild(badge);
    }

    if (tab.closeable !== false) {
      const x = document.createElement('span');
      x.className = 'rails-x';
      x.textContent = '\u00d7';
      x.dataset.closeTab = tab.id;
      x.setAttribute('aria-label', `Close ${tab.title ?? tab.id}`);
      x.setAttribute('role', 'button');
      tabEl.appendChild(x);
    }

    tabEl.addEventListener('pointerdown', e => inst._onTabDown(e, tab.id));
    tabEl.addEventListener('contextmenu', e => {
      e.preventDefault();
      inst._emit('tab:contextmenu', { tab, stack, x: e.clientX, y: e.clientY });
    });

    strip.appendChild(tabEl);
  });
  return strip;
}

function renderFloats(inst) {
  if (!Array.isArray(inst.state.floats)) return;
  // Render in z-order so the DOM order is irrelevant for painting
  // (we use style.zIndex directly), but DOM order still matches z for dev tools.
  const sorted = [...inst.state.floats].sort((a, b) => a.z - b.z);
  for (const float of sorted) {
    inst.floatsLayer.appendChild(buildFloatEl(inst, float));
    inst.floatsLayer.appendChild(buildFloatHandlesEl(inst, float));
  }
}

function buildFloatEl(inst, float) {
  const el = document.createElement('div');
  el.className = 'rails-float';
  if (float.minimized) el.classList.add('rails-minimized');
  if (float.maximized) el.classList.add('rails-maximized');
  // Auto-hide the in-stack tab strip when the float holds exactly one tab.
  // The titlebar already shows that tab's title, so the strip would just be
  // a redundant single-pill row. CSS keys off this class.
  if ((float.stack?.tabs?.length ?? 0) <= 1) el.classList.add('rails-float-single-tab');
  el.dataset.floatId = float.id;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', float.stack?.tabs.find(t => t.id === float.stack.active)?.title ?? 'Floating panel');
  el.style.left = float.x + 'px';
  el.style.top = float.y + 'px';
  el.style.width = float.w + 'px';
  el.style.height = float.h + 'px';
  el.style.zIndex = floatChromeZ(float.z);

  // Titlebar (drag handle + buttons)
  const titlebar = document.createElement('div');
  titlebar.className = 'rails-titlebar';
  titlebar.dataset.floatId = float.id;

  const titleLabel = document.createElement('div');
  titleLabel.className = 'rails-titlebar-label';
  const activeTab = float.stack?.tabs.find(t => t.id === float.stack.active);
  titleLabel.textContent = activeTab?.title ?? '';
  titlebar.appendChild(titleLabel);

  const btns = document.createElement('div');
  btns.className = 'rails-titlebar-buttons';
  btns.appendChild(makeTitleButton('rails-btn-minimize', '\u2013', 'Minimize'));
  btns.appendChild(makeTitleButton('rails-btn-maximize', float.maximized ? '\u29c9' : '\u25a1', float.maximized ? 'Restore' : 'Maximize'));
  btns.appendChild(makeTitleButton('rails-btn-close', '\u00d7', 'Close'));
  titlebar.appendChild(btns);

  titlebar.addEventListener('pointerdown', e => inst._onFloatTitlebarDown(e, float.id));
  titlebar.addEventListener('contextmenu', e => {
    e.preventDefault();
    inst._emit('float:titlebar:contextmenu', { float, x: e.clientX, y: e.clientY });
  });

  // Click on title buttons (delegated)
  btns.addEventListener('click', e => {
    const btn = e.target.closest('.rails-btn-minimize, .rails-btn-maximize, .rails-btn-close');
    if (!btn) return;
    e.stopPropagation();
    if (btn.classList.contains('rails-btn-minimize')) inst._toggleFloatMinimized(float.id);
    else if (btn.classList.contains('rails-btn-maximize')) inst._toggleFloatMaximized(float.id);
    else if (btn.classList.contains('rails-btn-close')) inst._closeFloat(float.id);
  });

  el.appendChild(titlebar);

  // Stack (strip + slot). Floats always render top-tabs.
  if (float.stack) {
    const stackEl = buildStackEl(inst, float.stack);
    // Float stacks fill remaining space below titlebar.
    stackEl.classList.add('rails-stack-in-float');
    el.appendChild(stackEl);
  }

  // Raise-on-pointerdown anywhere in the float.
  el.addEventListener('pointerdown', e => {
    // Only raise if the float isn't already topmost.
    const topZ = Math.max(0, ...inst.state.floats.map(f => f.z));
    if (float.z < topZ) inst._raiseFloat(float.id);
  }, true);

  return el;
}

// Per-float handles overlay — sibling of the float in floatsLayer, at z above
// the panel. Pointer-transparent; only the 8 handles re-enable pointer events.
// The overlay's bounds and z-index are kept synced to the float by
// setFloatBoundsInPlace and raiseFloatInPlace.
function buildFloatHandlesEl(inst, float) {
  const overlay = document.createElement('div');
  overlay.className = 'rails-float-handles';
  if (float.minimized) overlay.classList.add('rails-minimized');
  if (float.maximized) overlay.classList.add('rails-maximized');
  overlay.dataset.handlesFor = float.id;
  overlay.style.left = float.x + 'px';
  overlay.style.top = float.y + 'px';
  overlay.style.width = float.w + 'px';
  overlay.style.height = float.h + 'px';
  overlay.style.zIndex = floatHandlesZ(float.z);

  for (const dir of ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']) {
    const handle = document.createElement('div');
    handle.className = `rails-resize-handle rails-resize-handle-${dir}`;
    handle.dataset.resize = dir;
    handle.addEventListener('pointerdown', e => inst._onFloatResizeDown(e, float.id, dir));
    overlay.appendChild(handle);
  }

  // No raise-on-pointerdown listener here: onFloatResizeDown already raises
  // the float at resize start, and the overlay itself is pointer-transparent
  // (pointer-events: none) so non-handle clicks fall through to the panel.

  return overlay;
}

function makeTitleButton(cls, glyph, label) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = cls;
  b.textContent = glyph;
  b.setAttribute('aria-label', label);
  b.title = label;
  b.tabIndex = -1;
  return b;
}

// Rebuild a single stack's strip wrapper in place (used by updateTab).
// Rebuilds the whole strip-wrap (strip + overflow button) so the RO and
// click-handler closures reference the new strip element.
function rebuildStrip(inst, stackId) {
  const oldStrip = inst.chromeLayer.querySelector(
    `.rails-strip[data-stack-id="${cssEscape(stackId)}"]`
  );
  if (!oldStrip) {
    renderChrome(inst);
    return;
  }
  const stack = findStackInState(inst.state, stackId);
  if (!stack) {
    renderChrome(inst);
    return;
  }
  const oldWrap = oldStrip.parentElement;
  if (!oldWrap || !oldWrap.classList.contains('rails-strip-wrap')) {
    renderChrome(inst);
    return;
  }
  const newWrap = buildStripWrap(inst, stack);
  oldWrap.replaceWith(newWrap);
  reposition(inst);
  inst._emit('layout:change', { state: inst.state });
}

function findStackInState(state, stackId) {
  for (const rail of state.rails) {
    for (const stack of rail.stacks) {
      if (stack.id === stackId) return stack;
    }
  }
  for (const float of state.floats || []) {
    if (float.stack && float.stack.id === stackId) return float.stack;
  }
  return null;
}

// Position panels for all stacks (rails + floats). Show the active tab per
// stack; hide all others. Assigns per-panel z-index:
//   - rail tabs → 5 (above rail/stack splitters at z:2, below the floats
//     layer at z:100)
//   - float tabs → 100 + float.z (same effective root z as the float's own
//     chrome; DOM order breaks the tie and the panel wins because contentLayer
//     comes after chromeLayer in DOM. This is what lets the topmost float's
//     panel paint above every other float's chrome when you raise it.)
function reposition(inst) {
  const wsRect = inst.host.getBoundingClientRect();
  const activeIds = new Set();

  const placeFromStack = (stack, float) => {
    const slot = inst.chromeLayer.querySelector(
      `.rails-slot[data-slot-for="${cssEscape(stack.id)}"]`
    );
    if (!slot) return;
    const r = slot.getBoundingClientRect();
    const activeTab = stack.tabs.find(t => t.id === stack.active);
    if (!activeTab) return;
    const panel = getPanel(inst, activeTab);
    panel.style.left = (r.left - wsRect.left) + 'px';
    panel.style.top = (r.top - wsRect.top) + 'px';
    panel.style.width = r.width + 'px';
    panel.style.height = r.height + 'px';
    panel.style.display = '';
    panel.style.zIndex = float ? String(floatPanelZ(float.z ?? 0)) : String(RAIL_PANEL_Z);
    activeIds.add(activeTab.id);
  };

  for (const rail of inst.state.rails) {
    for (const stack of rail.stacks) placeFromStack(stack, null);
  }
  for (const float of inst.state.floats || []) {
    if (float.minimized) continue; // panel hidden when float is minimized
    if (float.stack) placeFromStack(float.stack, float);
  }

  for (const [tabId, el] of inst.panels) {
    if (!activeIds.has(tabId)) el.style.display = 'none';
  }
}

function getPanel(inst, tab) {
  let panel = inst.panels.get(tab.id);
  if (panel) return panel;
  const wrap = document.createElement('div');
  wrap.className = 'rails-panel';
  wrap.dataset.tabId = tab.id;
  const body = inst.callbacks.renderPanel(tab);
  if (body) wrap.appendChild(body);
  inst.contentLayer.appendChild(wrap);
  inst.panels.set(tab.id, wrap);
  return wrap;
}

function destroyPanel(inst, tabId, tab) {
  const el = inst.panels.get(tabId);
  if (!el) return;
  try {
    if (inst.callbacks.onPanelDestroy) {
      inst.callbacks.onPanelDestroy(tab || { id: tabId }, el);
    }
  } catch (err) {
    console.error('rails: onPanelDestroy threw', err);
  }
  el.remove();
  inst.panels.delete(tabId);
}

function reconcilePanels(inst) {
  const live = liveTabIds(inst.state);
  for (const [tabId] of inst.panels) {
    if (!live.has(tabId)) destroyPanel(inst, tabId, null);
  }
}

function destroyAllPanels(inst) {
  for (const [tabId] of inst.panels) destroyPanel(inst, tabId, null);
}

// In-place activate: swap .rails-active class on the strip, then reposition.
function activateInPlace(inst, stack, tabId) {
  if (stack.active === tabId) return;
  stack.active = tabId;
  const strip = inst.chromeLayer.querySelector(
    `.rails-strip[data-stack-id="${cssEscape(stack.id)}"]`
  );
  if (strip) {
    for (const tabEl of strip.querySelectorAll('.rails-tab')) {
      const match = tabEl.dataset.tabId === tabId;
      tabEl.classList.toggle('rails-active', match);
      tabEl.setAttribute('aria-selected', match ? 'true' : 'false');
      tabEl.tabIndex = match ? 0 : -1;
    }
  }
  reposition(inst);
  const tab = stack.tabs.find(t => t.id === tabId);
  if (tab) inst._emit('tab:activate', { tab, stack });
}

// In-place raise of a float: update zIndex on the float element + handles
// overlay, then re-run reposition so the float's panel z-index is current.
// Without the reposition, a freshly-raised float's panel still has its old
// z-index and a previously-topmost float's panel keeps painting above it.
function raiseFloatInPlace(inst, floatId) {
  const float = inst.state.floats.find(f => f.id === floatId);
  if (!float) return;
  const maxZ = Math.max(0, ...inst.state.floats.map(f => f.z));
  if (float.z >= maxZ) return;
  float.z = maxZ + 1;
  const el = inst.chromeLayer.querySelector(`.rails-float[data-float-id="${cssEscape(floatId)}"]`);
  if (el) el.style.zIndex = floatChromeZ(float.z);
  const handlesEl = inst.chromeLayer.querySelector(
    `.rails-float-handles[data-handles-for="${cssEscape(floatId)}"]`
  );
  if (handlesEl) handlesEl.style.zIndex = floatHandlesZ(float.z);
  reposition(inst);
  inst._emit('float:raise', { float });
}

// In-place bounds update (drag / resize). No chrome rebuild. Updates both
// the float root element and its handles overlay sibling.
function setFloatBoundsInPlace(inst, floatId, bounds) {
  const float = inst.state.floats.find(f => f.id === floatId);
  if (!float) return;
  if ('x' in bounds) float.x = bounds.x;
  if ('y' in bounds) float.y = bounds.y;
  if ('w' in bounds) float.w = bounds.w;
  if ('h' in bounds) float.h = bounds.h;
  const el = inst.chromeLayer.querySelector(`.rails-float[data-float-id="${cssEscape(floatId)}"]`);
  if (el) {
    el.style.left = float.x + 'px';
    el.style.top = float.y + 'px';
    el.style.width = float.w + 'px';
    el.style.height = float.h + 'px';
  }
  const handlesEl = inst.chromeLayer.querySelector(
    `.rails-float-handles[data-handles-for="${cssEscape(floatId)}"]`
  );
  if (handlesEl) {
    handlesEl.style.left = float.x + 'px';
    handlesEl.style.top = float.y + 'px';
    handlesEl.style.width = float.w + 'px';
    handlesEl.style.height = float.h + 'px';
  }
  reposition(inst);
}

// -- drag.js --

// @gcu/rails — tab drag, splitter drag, float drag/resize, drop zones, Escape-cancel
// All drag state lives on the instance (inst.drag); no module-scoped mutables.



const HOVER_ACTIVATE_DELAY_MS = 500;
const STRIP_EDGE_SCROLL_PX = 40;
const STRIP_EDGE_SCROLL_SPEED = 8; // px per frame

// ── splitter drag ─────────────────────────────────────────────────────────

const MIN_RAIL_WIDTH = 140;
const MIN_STACK_HEIGHT = 100;

function onSplitterDown(inst, e, kind, rail, idx) {
  e.preventDefault();
  e.stopPropagation();

  const snapshot = [];
  if (kind === 'rail') {
    const a = inst.state.rails[idx], b = inst.state.rails[idx + 1];
    snapshot.push({ target: a, flex: a.flex });
    snapshot.push({ target: b, flex: b.flex });
  } else {
    const a = rail.stacks[idx], b = rail.stacks[idx + 1];
    snapshot.push({ target: a, flex: a.flex });
    snapshot.push({ target: b, flex: b.flex });
  }

  for (const p of inst.panels.values()) p.classList.add('rails-dragging');

  const scrim = document.createElement('div');
  scrim.className = 'rails-scrim';
  inst.host.appendChild(scrim);

  const onMove = ev => {
    if (kind === 'rail') {
      const a = inst.state.rails[idx], b = inst.state.rails[idx + 1];
      const ae = inst.railsLayer.querySelector(`.rails-rail[data-rail-id="${cssEscape(a.id)}"]`);
      const be = inst.railsLayer.querySelector(`.rails-rail[data-rail-id="${cssEscape(b.id)}"]`);
      if (!ae || !be) return;
      const ra = ae.getBoundingClientRect(), rb = be.getBoundingClientRect();
      const total = ra.width + rb.width;
      const totalFlex = (a.flex ?? 1) + (b.flex ?? 1);
      const w = Math.max(MIN_RAIL_WIDTH, Math.min(total - MIN_RAIL_WIDTH, ev.clientX - ra.left));
      a.flex = (w / total) * totalFlex;
      b.flex = totalFlex - a.flex;
      ae.style.flex = a.flex;
      be.style.flex = b.flex;
    } else {
      const a = rail.stacks[idx], b = rail.stacks[idx + 1];
      const ae = inst.railsLayer.querySelector(`.rails-stack[data-stack-id="${cssEscape(a.id)}"]`);
      const be = inst.railsLayer.querySelector(`.rails-stack[data-stack-id="${cssEscape(b.id)}"]`);
      if (!ae || !be) return;
      const ra = ae.getBoundingClientRect(), rb = be.getBoundingClientRect();
      const total = ra.height + rb.height;
      const totalFlex = (a.flex ?? 1) + (b.flex ?? 1);
      const h = Math.max(MIN_STACK_HEIGHT, Math.min(total - MIN_STACK_HEIGHT, ev.clientY - ra.top));
      a.flex = (h / total) * totalFlex;
      b.flex = totalFlex - a.flex;
      ae.style.flex = a.flex;
      be.style.flex = b.flex;
    }
    inst._reposition();
  };

  const cleanup = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    for (const p of inst.panels.values()) p.classList.remove('rails-dragging');
    inst.drag = null;
  };

  const onUp = () => {
    cleanup();
    inst._emit('layout:change', { state: inst.state });
  };

  const onKey = ev => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    for (const snap of snapshot) snap.target.flex = snap.flex;
    cleanup();
    inst._renderChrome();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('keydown', onKey);

  inst.drag = { kind: 'splitter' };
}

// ── tab drag ──────────────────────────────────────────────────────────────

function onTabDown(inst, e, tabId) {
  if (e.target.dataset.closeTab) return;
  if (e.button !== 0) return;
  e.preventDefault();

  const hit = findTab(inst.state, tabId);
  if (!hit) return;
  if (hit.tab.draggable === false) {
    const onUp = () => {
      document.removeEventListener('pointerup', onUp);
      inst._activate(hit.stack, tabId);
    };
    document.addEventListener('pointerup', onUp);
    return;
  }

  // Capture the pointer on the tab element so the move/up fire there even
  // if the finger leaves it (esp. touch).
  try { e.target.setPointerCapture?.(e.pointerId); } catch {}

  const pointerType = e.pointerType;
  const startX = e.clientX, startY = e.clientY;
  const threshold = inst.config.dragThreshold ?? 4;
  let started = false;

  const onMove = ev => {
    if (!started) {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < threshold) return;
      started = true;
      beginTabDrag(inst, hit.tab, pointerType);
    }
    updateTabDrag(inst, ev);
  };

  const onUp = ev => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
    if (started) {
      endTabDrag(inst, ev);
    } else {
      const h = findTab(inst.state, tabId);
      if (h) inst._activate(h.stack, tabId);
    }
  };

  const onKey = ev => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    if (started) cancelTabDrag(inst);
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('keydown', onKey);
}

// ── float titlebar drag (either moves float, or redocks into rails) ───────

function onFloatTitlebarDown(inst, e, floatId) {
  // Ignore clicks on titlebar buttons.
  if (e.target.closest('.rails-titlebar-buttons')) return;
  if (e.button !== 0) return;
  e.preventDefault();

  const float = findFloat(inst.state, floatId);
  if (!float) return;
  if (float.maximized) return; // can't drag a maximized float

  // Raise on pointerdown.
  raiseFloatInPlace(inst, floatId);

  const startX = e.clientX, startY = e.clientY;
  const origX = float.x, origY = float.y, origW = float.w, origH = float.h;
  const grabOffset = { dx: e.clientX - float.x, dy: e.clientY - float.y };
  const threshold = inst.config.dragThreshold ?? 4;
  let started = false;
  let dragMode = null; // 'move' | 'redock'

  const onMove = ev => {
    if (!started) {
      if (Math.abs(ev.clientX - startX) + Math.abs(ev.clientY - startY) < threshold) return;
      started = true;
      // Begin as a move. If the cursor enters a rails drop zone during the drag,
      // we'll transition into 'redock' mode (showing zones, allowing drop).
      dragMode = 'move';
      beginFloatDrag(inst, float, origX, origY, origW, origH);
    }
    updateFloatDrag(inst, ev, float, grabOffset);
  };

  const onUp = ev => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
    if (started) endFloatDrag(inst, ev, float);
    // else: click on titlebar with no drag; the raise above already fired.
  };

  const onKey = ev => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    if (started) {
      // Restore pre-drag bounds.
      setFloatBoundsInPlace(inst, floatId, { x: origX, y: origY, w: origW, h: origH });
      teardownFloatDrag(inst);
    }
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('keydown', onKey);
}

function beginFloatDrag(inst, float, origX, origY, origW, origH) {
  for (const p of inst.panels.values()) p.classList.add('rails-dragging');

  const scrim = document.createElement('div');
  scrim.className = 'rails-scrim';
  inst.host.appendChild(scrim);

  // Compute rails drop zones (not new-float — the float itself is being dragged)
  // so the user can redock onto rails by dropping on a rail zone. Exclude the
  // dragging float's own titlebar from the zone set — dropping a float on itself
  // is a no-op.
  const activeTab = float.stack?.tabs.find(t => t.id === float.stack.active);
  const zones = activeTab ? computeRedockZones(inst, activeTab, float.id) : [];
  const zoneEls = zones.map(z => makeZoneEl(inst, z));

  inst.drag = {
    kind: 'float',
    float,
    origBounds: { x: origX, y: origY, w: origW, h: origH },
    scrim,
    zones,
    zoneEls,
    active: null,
  };
}

function updateFloatDrag(inst, ev, float, grabOffset) {
  const drag = inst.drag;
  if (!drag || drag.kind !== 'float') return;
  // Move float by pointer.
  const newX = ev.clientX - grabOffset.dx;
  const newY = ev.clientY - grabOffset.dy;
  setFloatBoundsInPlace(inst, float.id, { x: newX, y: newY });

  // Hit-test redock zones.
  const wsRect = inst.host.getBoundingClientRect();
  const lx = ev.clientX - wsRect.left;
  const ly = ev.clientY - wsRect.top;
  let best = null, bestScore = Infinity;
  for (const z of drag.zones) {
    const r = z.rect;
    if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) {
      const area = r.w * r.h;
      const score = z.priority === 'body-append' ? area + 1e9 : area;
      if (score < bestScore) { best = z; bestScore = score; }
    }
  }
  drag.zoneEls.forEach((el, i) => el.classList.toggle('rails-active', drag.zones[i] === best));
  drag.active = best;
}

function endFloatDrag(inst, ev, float) {
  const drag = inst.drag;
  if (!drag || drag.kind !== 'float') return;
  const { active } = drag;
  teardownFloatDrag(inst);

  if (!active) {
    // Plain move; emit event.
    inst._emit('float:move', {
      float,
      from: drag.origBounds,
      to: { x: float.x, y: float.y, w: float.w, h: float.h }
    });
    inst.drag = null;
    return;
  }

  // Redock: destroy float, move each of its tabs to the target stack.
  // We preserve tab order; the active tab in the float stays active post-redock.
  const tabs = [...float.stack.tabs];
  const activeId = float.stack.active;
  const toDesc = zoneToMoveTarget(active);

  // Remove the float first.
  inst.state.floats = inst.state.floats.filter(f => f.id !== float.id);

  // For multi-tab redock, create the target stack once (if needed) then
  // append all tabs into it. For stack/append-type targets, just append.
  const destStack = resolveRedockDestination(inst, active);
  if (destStack) {
    for (const tab of tabs) destStack.tabs.push(tab);
    destStack.active = activeId;
  }

  inst.drag = null;
  inst._cleanupAndRender();
  inst._emit('float:close', { float });
  inst._emit('tab:move', {
    tab: tabs[0],
    from: { floatId: float.id },
    to: toDesc
  });
}

// Resolve (or create) the target stack for redocking a float's tabs in bulk.
// For 'new-rail'/'new-stack' targets, creates the container. For stack/insert
// targets, returns the existing stack.
function resolveRedockDestination(inst, zone) {
  if (zone.type === 'new-rail') {
    const ns = { id: inst._freshId('s'), flex: 1, tabs: [], active: null };
    const nr = { id: inst._freshId('r'), flex: 1, stacks: [ns] };
    inst.state.rails.splice(zone.at, 0, nr);
    return ns;
  }
  if (zone.type === 'new-stack') {
    const ns = { id: inst._freshId('s'), flex: 1, tabs: [], active: null };
    const rail = inst.state.rails.find(r => r.id === zone.railId);
    if (rail) rail.stacks.splice(zone.at, 0, ns);
    return ns;
  }
  if (zone.type === 'tab-insert' || zone.type === 'tab-append') {
    return findStackById(inst.state, zone.stackId);
  }
  if (zone.type === 'float-titlebar') {
    const f = findFloat(inst.state, zone.floatId);
    return f?.stack || null;
  }
  return null;
}

function teardownFloatDrag(inst) {
  const drag = inst.drag;
  if (!drag || drag.kind !== 'float') return;
  drag.scrim?.remove();
  drag.zoneEls?.forEach(el => el.remove());
  for (const p of inst.panels.values()) p.classList.remove('rails-dragging');
}

// ── float resize (8 handles) ──────────────────────────────────────────────

function onFloatResizeDown(inst, e, floatId, dir) {
  if (e.button !== 0) return;
  e.preventDefault();
  e.stopPropagation();

  const float = findFloat(inst.state, floatId);
  if (!float || float.maximized || float.minimized) return;

  const startX = e.clientX, startY = e.clientY;
  const origX = float.x, origY = float.y, origW = float.w, origH = float.h;
  const minW = inst.config.minFloatSize?.w ?? 200;
  const minH = inst.config.minFloatSize?.h ?? 120;

  raiseFloatInPlace(inst, floatId);

  for (const p of inst.panels.values()) p.classList.add('rails-dragging');
  const scrim = document.createElement('div');
  scrim.className = 'rails-scrim';
  inst.host.appendChild(scrim);

  inst.drag = { kind: 'float-resize', float, origBounds: { x: origX, y: origY, w: origW, h: origH }, scrim };

  const onMove = ev => {
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    let nx = origX, ny = origY, nw = origW, nh = origH;
    if (dir.includes('e')) nw = Math.max(minW, origW + dx);
    if (dir.includes('s')) nh = Math.max(minH, origH + dy);
    if (dir.includes('w')) {
      const newW = Math.max(minW, origW - dx);
      nx = origX + (origW - newW);
      nw = newW;
    }
    if (dir.includes('n')) {
      const newH = Math.max(minH, origH - dy);
      ny = origY + (origH - newH);
      nh = newH;
    }
    setFloatBoundsInPlace(inst, floatId, { x: nx, y: ny, w: nw, h: nh });
  };

  const cleanup = () => {
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', onUp);
    document.removeEventListener('keydown', onKey);
    scrim.remove();
    for (const p of inst.panels.values()) p.classList.remove('rails-dragging');
    inst.drag = null;
  };

  const onUp = () => {
    const from = { x: origX, y: origY, w: origW, h: origH };
    const to = { x: float.x, y: float.y, w: float.w, h: float.h };
    cleanup();
    inst._emit('float:resize', { float, from, to });
  };

  const onKey = ev => {
    if (ev.key !== 'Escape') return;
    ev.preventDefault();
    setFloatBoundsInPlace(inst, floatId, { x: origX, y: origY, w: origW, h: origH });
    cleanup();
  };

  document.addEventListener('pointermove', onMove);
  document.addEventListener('pointerup', onUp);
  document.addEventListener('keydown', onKey);
}

// ── tab drag internals ────────────────────────────────────────────────────

function beginTabDrag(inst, tab, pointerType) {
  for (const p of inst.panels.values()) p.classList.add('rails-dragging');

  const scrim = document.createElement('div');
  scrim.className = 'rails-scrim';
  inst.host.appendChild(scrim);

  const ghost = document.createElement('div');
  ghost.className = 'rails-ghost';
  const label = document.createElement('span');
  label.textContent = tab.title ?? tab.id;
  ghost.appendChild(label);
  inst.host.appendChild(ghost);

  const zones = computeZones(inst, tab, pointerType === 'touch');
  const zoneEls = zones.map(z => makeZoneEl(inst, z));

  inst.drag = {
    kind: 'tab',
    tab,
    ghost,
    scrim,
    zones,
    zoneEls,
    active: null,
  };
}

function updateTabDrag(inst, ev) {
  const drag = inst.drag;
  if (!drag || drag.kind !== 'tab') return;
  const wsRect = inst.host.getBoundingClientRect();
  const lx = ev.clientX - wsRect.left;
  const ly = ev.clientY - wsRect.top;
  drag.ghost.style.left = (lx + 14) + 'px';
  drag.ghost.style.top = (ly + 14) + 'px';

  let best = null, bestScore = Infinity;
  for (const z of drag.zones) {
    const r = z.rect;
    if (lx >= r.x && lx <= r.x + r.w && ly >= r.y && ly <= r.y + r.h) {
      const area = r.w * r.h;
      const score = z.priority === 'body-append' ? area + 1e9
                  : z.priority === 'new-float' ? area + 2e9
                  : area;
      if (score < bestScore) { best = z; bestScore = score; }
    }
  }
  drag.zoneEls.forEach((el, i) => el.classList.toggle('rails-active', drag.zones[i] === best));
  drag.active = best;
  // Stash cursor position for new-float targets (so tear-off places the float
  // at drop point, not at a static rect origin).
  if (best && best.type === 'new-float') {
    best._cursorX = lx - 60;
    best._cursorY = ly - 10;
  }

  maybeHoverActivate(inst, ev);
  maybeEdgeScroll(inst, ev);
}

// Hover-to-activate: if the cursor hovers over an inactive tab for
// HOVER_ACTIVATE_DELAY_MS, activate it. Lets users drop into a stack whose
// active tab is different from the target one.
function maybeHoverActivate(inst, ev) {
  const drag = inst.drag;
  if (!drag) return;
  // scrim covers the workspace — we need to see through it. Temporarily disable.
  if (drag.scrim) drag.scrim.style.pointerEvents = 'none';
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const tabEl = el?.closest?.('.rails-tab');
  const stripEl = tabEl?.closest?.('.rails-strip');
  const hoverTabId = tabEl?.dataset?.tabId;
  const hoverStackId = stripEl?.dataset?.stackId;

  if (!hoverTabId || !hoverStackId || hoverTabId === drag.tab.id) {
    // Cursor off any hoverable tab, or over the dragged tab itself — cancel.
    if (drag.hoverTimer) {
      clearTimeout(drag.hoverTimer);
      drag.hoverTimer = null;
      drag.hoverTabId = null;
    }
    return;
  }

  // Don't re-arm the timer if we're still over the same tab we already armed for.
  if (drag.hoverTabId === hoverTabId) return;

  if (drag.hoverTimer) clearTimeout(drag.hoverTimer);
  drag.hoverTabId = hoverTabId;
  drag.hoverTimer = setTimeout(() => {
    drag.hoverTimer = null;
    // Re-resolve stack from state (it might have changed since we armed).
    const stackHit = findStack(inst.state, hoverStackId);
    if (!stackHit) return;
    const stack = stackHit.stack;
    if (stack.active === hoverTabId) return; // already active
    activateInPlace(inst, stack, hoverTabId);
    // activateInPlace calls reposition, which may have changed slot rects.
    // Recompute drop zones so they stay correct against the new layout.
    for (const zel of drag.zoneEls) zel.remove();
    drag.zones = computeZones(inst, drag.tab);
    drag.zoneEls = drag.zones.map(z => makeZoneEl(inst, z));
  }, HOVER_ACTIVATE_DELAY_MS);
}

// Scroll an overflowing strip when the drag cursor nears its left or right
// edge. Runs a rAF loop for smooth scroll until the cursor moves away.
function maybeEdgeScroll(inst, ev) {
  const drag = inst.drag;
  if (!drag) return;

  if (drag.scrim) drag.scrim.style.pointerEvents = 'none';
  const el = document.elementFromPoint(ev.clientX, ev.clientY);
  const strip = el?.closest?.('.rails-strip');
  if (!strip || strip.scrollWidth <= strip.clientWidth + 1) {
    stopEdgeScroll(drag);
    return;
  }

  const sr = strip.getBoundingClientRect();
  let dir = 0;
  if (ev.clientX < sr.left + STRIP_EDGE_SCROLL_PX) dir = -1;
  else if (ev.clientX > sr.right - STRIP_EDGE_SCROLL_PX) dir = 1;

  if (dir === 0) {
    stopEdgeScroll(drag);
    return;
  }

  if (drag.edgeScroll?.strip === strip && drag.edgeScroll?.dir === dir) return;

  stopEdgeScroll(drag);
  const state = { strip, dir, raf: 0 };
  const tick = () => {
    state.strip.scrollLeft += state.dir * STRIP_EDGE_SCROLL_SPEED;
    // Recompute tab-insert zones against the new scroll position so drops
    // stay accurate.
    for (const zel of drag.zoneEls) zel.remove();
    drag.zones = computeZones(inst, drag.tab);
    drag.zoneEls = drag.zones.map(z => makeZoneEl(inst, z));
    state.raf = requestAnimationFrame(tick);
  };
  state.raf = requestAnimationFrame(tick);
  drag.edgeScroll = state;
}

function stopEdgeScroll(drag) {
  if (drag?.edgeScroll) {
    cancelAnimationFrame(drag.edgeScroll.raf);
    drag.edgeScroll = null;
  }
}

function endTabDrag(inst, ev) {
  const drag = inst.drag;
  if (!drag || drag.kind !== 'tab') return;
  const { tab, active } = drag;
  teardownTabDrag(inst);

  if (!active) {
    inst.drag = null;
    return;
  }

  const src = findTab(inst.state, tab.id);
  if (!src) { inst.drag = null; return; }

  const fromDesc = src.container === 'float'
    ? { floatId: src.float.id, at: src.idx }
    : { stackId: src.stack.id, at: src.idx };
  const toDesc = zoneToMoveTarget(active);

  if (active.type === 'new-float' && inst.callbacks.canCreateFloat) {
    if (!inst.callbacks.canCreateFloat(tab, { x: active.rect.x, y: active.rect.y })) {
      inst.drag = null;
      return;
    }
  }

  if (inst.callbacks.canMoveTab && !inst.callbacks.canMoveTab(tab, fromDesc, toDesc)) {
    inst.drag = null;
    return;
  }

  // Remove from source.
  src.stack.tabs.splice(src.idx, 1);
  if (src.stack.active === tab.id && src.stack.tabs.length) {
    src.stack.active = src.stack.tabs[Math.max(0, src.idx - 1)].id;
  }

  // Apply target.
  applyMoveTarget(inst, tab, active, src.stack);
  inst.drag = null;

  inst._cleanupAndRender();

  // If we tore off into a new float, emit float:create.
  if (active.type === 'new-float') {
    const newFloat = inst.state.floats[inst.state.floats.length - 1];
    if (newFloat) inst._emit('float:create', { float: newFloat, tab });
  }
  inst._emit('tab:move', { tab, from: fromDesc, to: toDesc });
}

function cancelTabDrag(inst) {
  teardownTabDrag(inst);
  inst.drag = null;
}

function teardownTabDrag(inst) {
  const drag = inst.drag;
  if (!drag || drag.kind !== 'tab') return;
  if (drag.hoverTimer) clearTimeout(drag.hoverTimer);
  stopEdgeScroll(drag);
  drag.ghost?.remove();
  drag.scrim?.remove();
  drag.zoneEls?.forEach(el => el.remove());
  for (const p of inst.panels.values()) p.classList.remove('rails-dragging');
}

// ── drop zone computation ─────────────────────────────────────────────────

function makeZoneEl(inst, z) {
  const el = document.createElement('div');
  el.className = 'rails-zone';
  if (z.type === 'tab-insert') el.classList.add('rails-zone-insert');
  if (z.type === 'new-float') el.classList.add('rails-zone-float');
  if (z.type === 'new-rail' || z.type === 'new-stack') el.classList.add('rails-zone-new');
  el.style.left = z.rect.x + 'px';
  el.style.top = z.rect.y + 'px';
  el.style.width = z.rect.w + 'px';
  el.style.height = z.rect.h + 'px';
  inst.host.appendChild(el);
  return el;
}

// Zones for a tab drag — includes new-float.
function computeZones(inst, tab, touch) {
  const zones = collectRailsZones(inst);
  collectFloatStackZones(inst, zones);
  collectFloatTitlebarZones(inst, zones);
  const dropZones = inst.config.dropZones || {};
  if (dropZones['new-float'] !== false) {
    const wsRect = inst.host.getBoundingClientRect();
    zones.push({
      type: 'new-float',
      rect: { x: 0, y: 0, w: wsRect.width, h: wsRect.height },
      priority: 'new-float',
    });
  }
  if (touch) inflateZonesForTouch(zones);
  return filterZones(inst, zones, tab);
}

// Expand narrow drop zones so they remain usable with finger-sized pointers.
function inflateZonesForTouch(zones) {
  for (const z of zones) {
    // tab-insert is narrowest (6px). Expand to ~20px.
    if (z.type === 'tab-insert') {
      z.rect.x -= 7;
      z.rect.w += 14;
    }
    // new-rail and new-stack gaps — widen from 18px to 30px.
    if (z.type === 'new-rail' || z.type === 'new-stack') {
      if (z.rect.w < 20) { z.rect.x -= 6; z.rect.w += 12; }
      if (z.rect.h < 20) { z.rect.y -= 6; z.rect.h += 12; }
    }
  }
}

// Zones for float redock (float titlebar dragged onto rails) — rails-only,
// no new-float (can't redock into another new float). excludeFloatId skips
// the dragging float's own titlebar / strip / body zones so self-drops don't
// happen.
function computeRedockZones(inst, tab, excludeFloatId) {
  const zones = collectRailsZones(inst);
  collectFloatStackZones(inst, zones, excludeFloatId);
  collectFloatTitlebarZones(inst, zones, excludeFloatId);
  return filterZones(inst, zones, tab);
}

function filterZones(inst, zones, tab) {
  if (inst.callbacks.canDropOn) {
    return zones.filter(z => inst.callbacks.canDropOn(z, tab));
  }
  return zones;
}

function collectRailsZones(inst) {
  const zones = [];
  const wsRect = inst.host.getBoundingClientRect();
  const dropZones = inst.config.dropZones || {};
  const enabled = (type) => dropZones[type] !== false;

  inst.state.rails.forEach((rail, ri) => {
    const railEl = inst.railsLayer.querySelector(`.rails-rail[data-rail-id="${cssEscape(rail.id)}"]`);
    if (!railEl) return;
    const rr = railEl.getBoundingClientRect();

    if (ri === 0 && enabled('new-rail')) {
      zones.push({ type: 'new-rail', at: 0,
        rect: { x: 0, y: 0, w: 12, h: wsRect.height } });
    }
    if (enabled('new-rail')) {
      const nextLeft = ri < inst.state.rails.length - 1
        ? inst.railsLayer.querySelector(`.rails-rail[data-rail-id="${cssEscape(inst.state.rails[ri + 1].id)}"]`).getBoundingClientRect().left
        : wsRect.right;
      const gx = (rr.right + nextLeft) / 2 - wsRect.left;
      zones.push({ type: 'new-rail', at: ri + 1,
        rect: { x: gx - 9, y: 0, w: 18, h: wsRect.height } });
    }

    rail.stacks.forEach((stack, si) => {
      const stackEl = inst.railsLayer.querySelector(`.rails-stack[data-stack-id="${cssEscape(stack.id)}"]`);
      if (!stackEl) return;
      const sr = stackEl.getBoundingClientRect();

      if (si === 0 && enabled('new-stack')) {
        zones.push({ type: 'new-stack', railId: rail.id, at: 0,
          rect: { x: rr.left - wsRect.left, y: rr.top - wsRect.top, w: rr.width, h: 12 } });
      }
      if (enabled('new-stack')) {
        const nextTop = si < rail.stacks.length - 1
          ? inst.railsLayer.querySelector(`.rails-stack[data-stack-id="${cssEscape(rail.stacks[si + 1].id)}"]`).getBoundingClientRect().top
          : rr.bottom;
        const gy = (sr.bottom + nextTop) / 2 - wsRect.top;
        zones.push({ type: 'new-stack', railId: rail.id, at: si + 1,
          rect: { x: rr.left - wsRect.left, y: gy - 9, w: rr.width, h: 18 } });
      }

      collectStackInternalZones(zones, stackEl, stack, wsRect, enabled);
    });
  });
  return zones;
}

// Push tab-insert / tab-append-strip / tab-append-body zones for a stack's
// rendered DOM. Used both for rail-stacks (via collectRailsZones) and for
// float-stacks (via collectFloatStackZones), so dropping into a float behaves
// the same as dropping into a docked stack — true mini-workspace semantics.
//
// A hidden strip (single-tab float, where rails.css collapses .rails-strip-wrap)
// reports a zero-area rect; we skip strip-derived zones in that case so we
// don't generate dead hit-targets. Body-append still applies — drops on the
// float's slot append to the existing stack rather than spawning a new float
// stacked on top.
function collectStackInternalZones(zones, stackEl, stack, wsRect, enabled) {
  const strip = stackEl.querySelector('.rails-strip');
  if (strip) {
    const stripRect = strip.getBoundingClientRect();
    const stripVisible = stripRect.width > 0 && stripRect.height > 0;

    if (stripVisible && enabled('tab-append-strip')) {
      zones.push({ type: 'tab-append', stackId: stack.id,
        rect: { x: stripRect.left - wsRect.left, y: stripRect.top - wsRect.top,
                w: stripRect.width, h: stripRect.height } });
    }

    if (stripVisible && enabled('tab-insert')) {
      const tabEls = strip.querySelectorAll('.rails-tab');
      const inserts = [];
      tabEls.forEach((t, ti) => {
        const r = t.getBoundingClientRect();
        inserts.push({ x: r.left, at: ti });
      });
      inserts.push({ x: stripRect.right, at: tabEls.length });
      inserts.forEach(ins => {
        zones.push({ type: 'tab-insert', stackId: stack.id, at: ins.at,
          rect: { x: ins.x - wsRect.left - 3, y: stripRect.top - wsRect.top,
                  w: 6, h: stripRect.height } });
      });
    }
  }

  if (enabled('tab-append-body')) {
    const slot = stackEl.querySelector('.rails-slot');
    if (slot) {
      const slotRect = slot.getBoundingClientRect();
      if (slotRect.width > 0 && slotRect.height > 0) {
        zones.push({ type: 'tab-append', stackId: stack.id,
          rect: { x: slotRect.left - wsRect.left, y: slotRect.top - wsRect.top,
                  w: slotRect.width, h: slotRect.height },
          priority: 'body-append' });
      }
    }
  }
}

// Per-stack drop zones for floats — same set as rail-stacks but sourced from
// the floats sublayer. Skips minimized/maximized floats (no usable strip/slot)
// and the dragging float's own zones (excludeFloatId) so a redock can't drop
// the float onto itself.
function collectFloatStackZones(inst, zones, excludeFloatId) {
  if (!Array.isArray(inst.state.floats)) return;
  const wsRect = inst.host.getBoundingClientRect();
  const dropZones = inst.config.dropZones || {};
  const enabled = (type) => dropZones[type] !== false;
  for (const float of inst.state.floats) {
    if (float.id === excludeFloatId) continue;
    if (float.minimized) continue;
    if (!float.stack) continue;
    const stackEl = inst.floatsLayer?.querySelector(
      `.rails-float[data-float-id="${cssEscape(float.id)}"] .rails-stack`
    );
    if (!stackEl) continue;
    collectStackInternalZones(zones, stackEl, float.stack, wsRect, enabled);
  }
}

function collectFloatTitlebarZones(inst, zones, excludeFloatId) {
  const wsRect = inst.host.getBoundingClientRect();
  const dropZones = inst.config.dropZones || {};
  if (dropZones['float-titlebar'] === false) return;
  for (const float of inst.state.floats || []) {
    if (float.id === excludeFloatId) continue;
    if (float.minimized || float.maximized) continue;
    const floatEl = inst.floatsLayer?.querySelector(`.rails-float[data-float-id="${cssEscape(float.id)}"]`);
    if (!floatEl) continue;
    const titlebar = floatEl.querySelector('.rails-titlebar');
    if (!titlebar) continue;
    const tr = titlebar.getBoundingClientRect();
    zones.push({
      type: 'float-titlebar',
      floatId: float.id,
      rect: { x: tr.left - wsRect.left, y: tr.top - wsRect.top,
              w: tr.width, h: tr.height },
    });
  }
}

function zoneToMoveTarget(zone) {
  switch (zone.type) {
    case 'new-rail':  return { to: 'new-rail', at: zone.at };
    case 'new-stack': return { to: 'new-stack', railId: zone.railId, at: zone.at };
    case 'tab-insert':return { to: 'stack', stackId: zone.stackId, at: zone.at };
    case 'tab-append':return { to: 'stack', stackId: zone.stackId };
    case 'new-float': return { to: 'new-float', x: zone._cursorX ?? 100, y: zone._cursorY ?? 100 };
    case 'float-titlebar': return { to: 'float', floatId: zone.floatId };
    default:          return null;
  }
}

function applyMoveTarget(inst, tab, zone, srcStack) {
  if (zone.type === 'new-rail') {
    const ns = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
    const nr = { id: inst._freshId('r'), flex: 1, stacks: [ns] };
    inst.state.rails.splice(zone.at, 0, nr);
  } else if (zone.type === 'new-stack') {
    const ns = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
    const rail = inst.state.rails.find(r => r.id === zone.railId);
    if (rail) rail.stacks.splice(zone.at, 0, ns);
  } else if (zone.type === 'tab-insert') {
    const target = findStackById(inst.state, zone.stackId);
    if (target) {
      let at = zone.at;
      if (target === srcStack) at = Math.min(at, target.tabs.length);
      target.tabs.splice(at, 0, tab);
      target.active = tab.id;
    }
  } else if (zone.type === 'tab-append') {
    const target = findStackById(inst.state, zone.stackId);
    if (target) {
      target.tabs.push(tab);
      target.active = tab.id;
    }
  } else if (zone.type === 'new-float') {
    const cx = zone._cursorX ?? 100;
    const cy = zone._cursorY ?? 100;
    const w = inst.config.defaultFloatSize?.w ?? 400;
    const h = inst.config.defaultFloatSize?.h ?? 300;
    const maxZ = Math.max(0, ...(inst.state.floats || []).map(f => f.z));
    const stack = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
    const float = {
      id: inst._freshId('f'),
      stack,
      x: cx, y: cy, w, h,
      z: maxZ + 1,
    };
    if (!Array.isArray(inst.state.floats)) inst.state.floats = [];
    inst.state.floats.push(float);
  } else if (zone.type === 'float-titlebar') {
    const float = findFloat(inst.state, zone.floatId);
    if (float && float.stack) {
      float.stack.tabs.push(tab);
      float.stack.active = tab.id;
    }
  }
}

function findStackById(state, stackId) {
  for (const rail of state.rails) {
    for (const stack of rail.stacks) {
      if (stack.id === stackId) return stack;
    }
  }
  for (const float of state.floats || []) {
    if (float.stack && float.stack.id === stackId) return float.stack;
  }
  return null;
}

// -- api.js --

// @gcu/rails — public API: createRails()
// Assembles an instance, wires event delegation, and returns the public surface.



function createRails(host, options = {}) {
  if (!host || !host.nodeType) {
    throw new Error('rails: host must be an HTMLElement');
  }
  if (typeof options.renderPanel !== 'function') {
    throw new Error('rails: options.renderPanel is required');
  }

  host.classList.add('rails-root');

  const chromeLayer = document.createElement('div');
  chromeLayer.className = 'rails-chrome';
  const contentLayer = document.createElement('div');
  contentLayer.className = 'rails-content';
  host.append(chromeLayer, contentLayer);

  const state = options.initialState
    ? JSON.parse(JSON.stringify(options.initialState))
    : emptyState();
  // Ensure floats is an array even if consumer omitted it.
  if (!Array.isArray(state.floats)) state.floats = [];

  // Validate only if non-empty — empty state skips per invariant 7.
  if (state.rails.length > 0) validateState(state);

  const callbacks = {
    renderPanel: options.renderPanel,
    renderEmpty: options.renderEmpty,
    onPanelDestroy: options.onPanelDestroy,
    canCloseTab: options.canCloseTab,
    canMoveTab: options.canMoveTab,
    canCreateFloat: options.canCreateFloat,
    canDropOn: options.canDropOn,
  };

  const config = {
    minFloatSize: options.minFloatSize ?? { w: 200, h: 120 },
    dragThreshold: options.dragThreshold ?? 4,
    tabPosition: options.tabPosition ?? 'top',
    dropZones: options.dropZones ?? {},
  };

  const events = new Map();

  const inst = {
    host,
    chromeLayer,
    contentLayer,
    state,
    panels: new Map(),
    // Panels preserved after close — keyed by tabId, value is the last-known
    // tab object. The panel itself stays in `panels` too, hidden via display:none.
    // Re-adding the same tab ID reuses the cached panel; releasePreservedPanel
    // forces destruction. See closeTab({ preserve: true }).
    preservedTabs: new Map(),
    callbacks,
    config,
    events,
    drag: null,
    batchDepth: 0,
    batchDirty: false,
    // Wired methods below for render.js/drag.js to call without circular imports.
    _emit: null,
    _reposition: null,
    _renderChrome: null,
    _activate: null,
    _onTabDown: null,
    _onSplitterDown: null,
    _cleanupAndRender: null,
  };

  inst._emit = (event, payload) => {
    // Shortcut handlers from options (onChange, onFloatMinimize, etc.)
    const shortcut = options['on' + capitalize(toCamel(event))];
    if (typeof shortcut === 'function') {
      try { shortcut(payload); } catch (e) { console.error('rails: event handler threw', e); }
    }
    const subs = events.get(event);
    if (subs) {
      for (const fn of subs) {
        try { fn(payload); } catch (e) { console.error('rails: event handler threw', e); }
      }
    }
    if (event === 'layout:change') {
      const onChange = options.onChange;
      if (typeof onChange === 'function') {
        try { onChange(inst.state); } catch (e) { console.error('rails: onChange threw', e); }
      }
    }
  };

  inst._reposition = () => reposition(inst);
  inst._renderChrome = () => {
    if (inst.batchDepth > 0) { inst.batchDirty = true; return; }
    renderChrome(inst);
  };
  inst._activate = (stack, tabId) => activateInPlace(inst, stack, tabId);
  inst._onTabDown = (e, tabId) => onTabDown(inst, e, tabId);
  inst._onSplitterDown = (e, kind, rail, idx) => onSplitterDown(inst, e, kind, rail, idx);
  inst._onFloatTitlebarDown = (e, floatId) => onFloatTitlebarDown(inst, e, floatId);
  inst._onFloatResizeDown = (e, floatId, dir) => onFloatResizeDown(inst, e, floatId, dir);
  inst._onStripKeyDown = (e, stack) => onStripKeyDown(inst, e, stack);
  inst._closeTab = (tabId) => closeTab(tabId);
  inst._toggleRailCollapsed = (railId) => toggleRailCollapsed(railId);
  inst._raiseFloat = (floatId) => raiseFloatInPlace(inst, floatId);
  inst._toggleFloatMinimized = (floatId) => toggleFloatMinimized(floatId);
  inst._toggleFloatMaximized = (floatId) => toggleFloatMaximized(floatId);
  inst._closeFloat = (floatId) => closeFloat(floatId);
  inst._freshId = (prefix) => freshId(inst.state, prefix);
  inst._cleanupAndRender = () => {
    cleanup(inst.state);
    reconcilePanels(inst);
    inst._renderChrome();
  };

  // Delegated click handler: close-× affordance. Routes through preserve if
  // the tab has preserveOnClose:true, otherwise destroys.
  host.addEventListener('click', e => {
    const tabId = e.target?.dataset?.closeTab;
    if (!tabId) return;
    const hit = findTab(inst.state, tabId);
    if (hit?.tab?.preserveOnClose) closeTab(tabId, { preserve: true });
    else closeTab(tabId);
  });

  // Pointerdown-to-raise for floats: hit-test against every float's screen
  // rect so clicks anywhere in a float's window (including its panel, which
  // lives in contentLayer, a separate DOM subtree) raise the float.
  host.addEventListener('pointerdown', e => {
    const floats = inst.state.floats;
    if (!floats || floats.length === 0) return;
    const wsRect = host.getBoundingClientRect();
    const x = e.clientX - wsRect.left;
    const y = e.clientY - wsRect.top;
    let top = null;
    for (const f of floats) {
      if (f.minimized) continue;
      if (x >= f.x && x <= f.x + f.w && y >= f.y && y <= f.y + f.h) {
        if (!top || f.z > top.z) top = f;
      }
    }
    if (top) raiseFloatInPlace(inst, top.id);
  }, true);

  // Global keyboard shortcuts (only when focus is inside host).
  host.addEventListener('keydown', e => {
    if (!host.contains(document.activeElement) && document.activeElement !== host) return;
    // Ctrl-W / Cmd-W: close active tab of the focused stack. Routes through
    // preserve if the tab has preserveOnClose:true.
    if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'w') {
      const stack = focusedStack(inst);
      if (stack && stack.active) {
        e.preventDefault();
        const activeTab = stack.tabs.find(t => t.id === stack.active);
        if (activeTab?.preserveOnClose) closeTab(stack.active, { preserve: true });
        else closeTab(stack.active);
      }
      return;
    }
    // Ctrl-Tab / Ctrl-Shift-Tab: cycle tabs within the focused stack.
    if (e.ctrlKey && e.key === 'Tab') {
      const stack = focusedStack(inst);
      if (stack && stack.tabs.length > 1) {
        e.preventDefault();
        const curIdx = Math.max(0, stack.tabs.findIndex(t => t.id === stack.active));
        const step = e.shiftKey ? -1 : 1;
        const nextIdx = (curIdx + step + stack.tabs.length) % stack.tabs.length;
        activateInPlace(inst, stack, stack.tabs[nextIdx].id);
      }
      return;
    }
  });

  // ResizeObserver syncs panel positions on host resize.
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => reposition(inst));
    ro.observe(host);
  }
  window.addEventListener('resize', inst._reposition);

  // ── public methods ──

  function render() { renderChrome(inst); }

  function batch(fn) {
    inst.batchDepth++;
    try {
      fn();
    } finally {
      inst.batchDepth--;
      if (inst.batchDepth === 0 && inst.batchDirty) {
        inst.batchDirty = false;
        renderChrome(inst);
      }
    }
  }

  function addTab(tab, target) {
    if (!tab || !tab.id) throw new Error('rails: addTab requires tab with id');
    if (findTab(inst.state, tab.id)) {
      throw new Error(`rails: duplicate tab id ${tab.id}`);
    }

    // If this tab was previously closed-with-preserve, the cached panel is
    // about to become visible again. Drop it from the preserved set — the
    // tab is now live again. The panel element itself is reused automatically
    // via the panels Map (renderPanel won't be called again).
    inst.preservedTabs.delete(tab.id);

    const t = target || defaultAddTarget(inst.state);
    insertAtTarget(inst, tab, t);
    inst._renderChrome();
    // Emit float:create for the new-float target so consumers see the same
    // event whether a float was created via floatTab(id) or addTab(tab,
    // {to:'new-float'}). insertAtTarget pushes the new float to the end of
    // state.floats, so it's the last entry.
    if (t.to === 'new-float') {
      const float = inst.state.floats[inst.state.floats.length - 1];
      if (float) inst._emit('float:create', { float, tab });
    }
  }

  function closeTab(tabId, opts = {}) {
    const hit = findTab(inst.state, tabId);
    if (!hit) return;
    if (hit.tab.closeable === false) return;
    if (inst.callbacks.canCloseTab && !inst.callbacks.canCloseTab(hit.tab)) return;

    const from = { stackId: hit.stack.id, at: hit.idx };
    const tab = hit.tab;
    removeTabFromStack(inst.state, tabId);

    if (opts.preserve) {
      // Keep the panel element alive but hide it. Re-adding with the same
      // tab id reuses the cached element — renderPanel is NOT called again.
      const panel = inst.panels.get(tabId);
      if (panel) panel.style.display = 'none';
      inst.preservedTabs.set(tabId, tab);
    } else {
      // Normal close: destroy panel + fire onPanelDestroy.
      destroyPanel(inst, tabId, tab);
    }

    cleanup(inst.state);
    inst._renderChrome();
    inst._emit('tab:close', { tab, from, preserved: !!opts.preserve });
  }

  function activateTab(tabId) {
    const hit = findTab(inst.state, tabId);
    if (!hit) return;
    activateInPlace(inst, hit.stack, tabId);
  }

  function moveTab(tabId, target) {
    const hit = findTab(inst.state, tabId);
    if (!hit) return;
    const from = { stackId: hit.stack.id, at: hit.idx };

    if (inst.callbacks.canMoveTab && !inst.callbacks.canMoveTab(hit.tab, from, target)) return;

    // Remove from source, insert at target, cleanup, re-render.
    const tab = hit.tab;
    hit.stack.tabs.splice(hit.idx, 1);
    if (hit.stack.active === tabId && hit.stack.tabs.length) {
      hit.stack.active = hit.stack.tabs[Math.max(0, hit.idx - 1)].id;
    }
    insertAtTarget(inst, tab, target);
    cleanup(inst.state);
    inst._renderChrome();
    inst._emit('tab:move', { tab, from, to: target });
  }

  function updateTab(tabId, patch) {
    const hit = findTab(inst.state, tabId);
    if (!hit) return;
    const { changed, chromeVisible } = patchTab(inst.state, tabId, patch);
    if (!changed) return;
    if (chromeVisible) {
      if (inst.batchDepth > 0) { inst.batchDirty = true; return; }
      rebuildStrip(inst, hit.stack.id);
    }
    // Non-chrome-visible: state mutated, no re-render. Consumer sees the change
    // in inst.state and is responsible for panel-side refresh if needed.
  }

  function floatTab(tabId, bounds) {
    const hit = findTab(inst.state, tabId);
    if (!hit) return;
    if (inst.callbacks.canCreateFloat && !inst.callbacks.canCreateFloat(hit.tab, bounds)) return;

    const tab = hit.tab;
    const from = hit.container === 'float'
      ? { floatId: hit.float.id, at: hit.idx }
      : { stackId: hit.stack.id, at: hit.idx };

    hit.stack.tabs.splice(hit.idx, 1);
    if (hit.stack.active === tabId && hit.stack.tabs.length) {
      hit.stack.active = hit.stack.tabs[Math.max(0, hit.idx - 1)].id;
    }

    const w = bounds?.w ?? inst.config.defaultFloatSize?.w ?? 400;
    const h = bounds?.h ?? inst.config.defaultFloatSize?.h ?? 300;
    const x = bounds?.x ?? 80;
    const y = bounds?.y ?? 80;
    const maxZ = Math.max(0, ...(inst.state.floats || []).map(f => f.z));
    const stack = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
    const float = {
      id: inst._freshId('f'),
      stack,
      x, y, w, h,
      z: maxZ + 1,
    };
    if (!Array.isArray(inst.state.floats)) inst.state.floats = [];
    inst.state.floats.push(float);

    cleanup(inst.state);
    inst._renderChrome();
    inst._emit('float:create', { float, tab });
    inst._emit('tab:move', { tab, from, to: { to: 'float', floatId: float.id } });
  }

  function redockTab(tabId, target) {
    moveTab(tabId, target);
  }

  function setFloatBounds(floatId, bounds) {
    const float = findFloat(inst.state, floatId);
    if (!float) return;
    const from = { x: float.x, y: float.y, w: float.w, h: float.h };
    setFloatBoundsInPlace(inst, floatId, bounds);
    const to = { x: float.x, y: float.y, w: float.w, h: float.h };
    // Emit move or resize depending on what changed.
    if ('w' in bounds || 'h' in bounds) inst._emit('float:resize', { float, from, to });
    else inst._emit('float:move', { float, from, to });
  }

  function raiseFloat(floatId) {
    raiseFloatInPlace(inst, floatId);
  }

  function toggleFloatMinimized(floatId) {
    const float = findFloat(inst.state, floatId);
    if (!float) return;
    float.minimized = !float.minimized;
    // Update DOM class + visibility in place on both the float and its
    // handles-overlay sibling; emit event.
    const el = inst.chromeLayer.querySelector(`.rails-float[data-float-id="${cssEscape(floatId)}"]`);
    if (el) el.classList.toggle('rails-minimized', !!float.minimized);
    const handlesEl = inst.chromeLayer.querySelector(
      `.rails-float-handles[data-handles-for="${cssEscape(floatId)}"]`
    );
    if (handlesEl) handlesEl.classList.toggle('rails-minimized', !!float.minimized);
    reposition(inst);
    inst._emit('float:minimize', { float });
  }

  function toggleFloatMaximized(floatId) {
    const float = findFloat(inst.state, floatId);
    if (!float) return;
    if (!float.maximized) {
      // Snapshot pre-max bounds, fill workspace.
      float._preMax = { x: float.x, y: float.y, w: float.w, h: float.h };
      const hostRect = host.getBoundingClientRect();
      float.maximized = true;
      setFloatBoundsInPlace(inst, floatId, { x: 0, y: 0, w: hostRect.width, h: hostRect.height });
    } else {
      // Restore.
      const snap = float._preMax || { x: 80, y: 80, w: 400, h: 300 };
      float.maximized = false;
      setFloatBoundsInPlace(inst, floatId, snap);
      delete float._preMax;
    }
    // Re-render chrome so max button glyph updates and maximize class is set.
    inst._renderChrome();
    inst._emit('float:maximize', {
      float,
      from: float.maximized ? null : float._preMax,
    });
  }

  function toggleRailCollapsed(railId) {
    const rail = findRail(inst.state, railId);
    if (!rail) return;
    rail.collapsed = !rail.collapsed;
    inst._renderChrome();
    inst._emit(rail.collapsed ? 'rail:collapse' : 'rail:expand', { rail });
  }

  function releasePreservedPanel(tabId) {
    if (!inst.preservedTabs.has(tabId)) return;
    const tab = inst.preservedTabs.get(tabId);
    inst.preservedTabs.delete(tabId);
    destroyPanel(inst, tabId, tab);
  }

  function listPreservedPanels() {
    return [...inst.preservedTabs.entries()].map(([id, tab]) => ({ id, tab }));
  }

  function closeFloat(floatId) {
    const float = findFloat(inst.state, floatId);
    if (!float) return;
    // Delegate each tab through closeTab so its preserveOnClose flag routes
    // to preserve instead of destroy (matching UI behavior for rail tabs).
    // canCloseTab / closeable:false checks and tab:close emission happen
    // inside closeTab. batch() collapses the repeated cleanups into one
    // chrome rebuild.
    const tabs = [...(float.stack?.tabs || [])];
    batch(() => {
      for (const tab of tabs) {
        closeTab(tab.id, { preserve: !!tab.preserveOnClose });
      }
    });
    // Only emit float:close if the float was actually removed (all tabs
    // closed or preserved; none refused via canCloseTab / closeable:false).
    if (!findFloat(inst.state, floatId)) {
      inst._emit('float:close', { float });
    }
  }

  function on(event, handler) {
    if (!events.has(event)) events.set(event, new Set());
    events.get(event).add(handler);
    return () => off(event, handler);
  }

  function off(event, handler) {
    events.get(event)?.delete(handler);
  }

  function serialize(replacer) {
    return serializeState(inst.state, replacer);
  }

  function deserialize(str) {
    const next = JSON.parse(str);
    if (!Array.isArray(next.floats)) next.floats = [];
    if (next.rails.length > 0) validateState(next);
    inst.state = next;
    // Deserialize evicts preserved panels whose ids aren't in the new state —
    // reconcilePanels handles the DOM + onPanelDestroy; we clear the preserved
    // bookkeeping for those too so it doesn't drift from the panel cache.
    const nextIds = liveTabIds(next);
    for (const [id] of inst.preservedTabs) {
      if (!nextIds.has(id)) inst.preservedTabs.delete(id);
    }
    reconcilePanels(inst);
    renderChrome(inst);
  }

  function destroy() {
    destroyAllPanels(inst);
    inst.preservedTabs.clear();
    ro?.disconnect();
    window.removeEventListener('resize', inst._reposition);
    host.classList.remove('rails-root');
    chromeLayer.remove();
    contentLayer.remove();
  }

  // Initial render.
  renderChrome(inst);

  return {
    get state() { return inst.state; },
    render,
    batch,
    addTab,
    closeTab,
    activateTab,
    moveTab,
    updateTab,
    floatTab,
    redockTab,
    setFloatBounds,
    raiseFloat,
    toggleFloatMinimized,
    toggleFloatMaximized,
    closeFloat,
    toggleRailCollapsed,
    releasePreservedPanel,
    listPreservedPanels,
    on,
    off,
    serialize,
    deserialize,
    destroy,
  };
}

// Keyboard navigation on a tab strip (arrow keys, home/end, delete).
function onStripKeyDown(inst, e, stack) {
  const tabs = stack.tabs;
  if (tabs.length === 0) return;
  const curIdx = Math.max(0, tabs.findIndex(t => t.id === stack.active));
  let nextIdx = null;
  if (e.key === 'ArrowRight' || e.key === 'ArrowDown') nextIdx = (curIdx + 1) % tabs.length;
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') nextIdx = (curIdx - 1 + tabs.length) % tabs.length;
  else if (e.key === 'Home') nextIdx = 0;
  else if (e.key === 'End') nextIdx = tabs.length - 1;
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    const active = tabs[curIdx];
    if (active && active.closeable !== false) {
      e.preventDefault();
      inst._closeTab?.(active.id);
    }
    return;
  }
  if (nextIdx != null && nextIdx !== curIdx) {
    e.preventDefault();
    activateInPlaceFromInst(inst, stack, tabs[nextIdx].id);
    // Move focus to the now-active tab element.
    const newActive = tabs[nextIdx];
    const tabEl = inst.chromeLayer.querySelector(
      `.rails-strip[data-stack-id="${cssEscape(stack.id)}"] .rails-tab[data-tab-id="${cssEscape(newActive.id)}"]`
    );
    tabEl?.focus?.();
  }
}

function activateInPlaceFromInst(inst, stack, tabId) {
  activateInPlace(inst, stack, tabId);
}

// Find the stack whose DOM tree contains document.activeElement. Used for
// keyboard-focused shortcuts (Ctrl-W, Ctrl-Tab).
function focusedStack(inst) {
  const active = document.activeElement;
  if (!active) return null;
  const stripEl = active.closest?.('.rails-strip, .rails-stack');
  const stackId = stripEl?.dataset?.stackId;
  if (!stackId) return null;
  for (const rail of inst.state.rails) {
    for (const stack of rail.stacks) {
      if (stack.id === stackId) return stack;
    }
  }
  for (const float of inst.state.floats || []) {
    if (float.stack?.id === stackId) return float.stack;
  }
  return null;
}

// ── helpers ───────────────────────────────────────────────────────────────

function defaultAddTarget(state) {
  if (state.rails.length === 0) {
    // Caller is asking us to auto-create the first rail/stack. Signal this
    // via a synthetic target that insertAtTarget understands.
    return { to: '__bootstrap' };
  }
  const firstStack = state.rails[0].stacks[0];
  return { to: 'stack', stackId: firstStack.id };
}

function insertAtTarget(inst, tab, target) {
  if (!target || typeof target !== 'object') {
    throw new Error('rails: invalid MoveTarget');
  }
  switch (target.to) {
    case '__bootstrap': {
      const stack = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
      const rail = { id: inst._freshId('r'), flex: 1, stacks: [stack] };
      inst.state.rails.push(rail);
      break;
    }
    case 'stack': {
      const stack = findStackByIdInState(inst.state, target.stackId);
      if (!stack) throw new Error(`rails: stack ${target.stackId} not found`);
      const at = target.at == null ? stack.tabs.length : target.at;
      stack.tabs.splice(at, 0, tab);
      stack.active = tab.id;
      break;
    }
    case 'new-rail': {
      const stack = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
      const rail = { id: inst._freshId('r'), flex: 1, stacks: [stack] };
      const at = target.at ?? inst.state.rails.length;
      inst.state.rails.splice(at, 0, rail);
      break;
    }
    case 'new-stack': {
      const rail = findRail(inst.state, target.railId);
      if (!rail) throw new Error(`rails: rail ${target.railId} not found`);
      const stack = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
      const at = target.at ?? rail.stacks.length;
      rail.stacks.splice(at, 0, stack);
      break;
    }
    case 'float': {
      const float = findFloat(inst.state, target.floatId);
      if (!float) throw new Error(`rails: float ${target.floatId} not found`);
      if (!float.stack) throw new Error(`rails: float ${target.floatId} missing stack`);
      const at = target.at == null ? float.stack.tabs.length : target.at;
      float.stack.tabs.splice(at, 0, tab);
      float.stack.active = tab.id;
      break;
    }
    case 'new-float': {
      const w = target.w ?? inst.config.defaultFloatSize?.w ?? 400;
      const h = target.h ?? inst.config.defaultFloatSize?.h ?? 300;
      const x = target.x ?? 80;
      const y = target.y ?? 80;
      const maxZ = Math.max(0, ...(inst.state.floats || []).map(f => f.z));
      const stack = { id: inst._freshId('s'), flex: 1, tabs: [tab], active: tab.id };
      const float = {
        id: inst._freshId('f'),
        stack,
        x, y, w, h,
        z: maxZ + 1,
      };
      if (!Array.isArray(inst.state.floats)) inst.state.floats = [];
      inst.state.floats.push(float);
      break;
    }
    default:
      throw new Error(`rails: unknown MoveTarget ${target.to}`);
  }
}

function findStackByIdInState(state, stackId) {
  for (const rail of state.rails) {
    for (const stack of rail.stacks) {
      if (stack.id === stackId) return stack;
    }
  }
  return null;
}

function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
function toCamel(s) {
  return s.replace(/[:-](.)/g, (_, c) => c.toUpperCase());
}

// -- main.js --

// @gcu/rails — concat build manifest.
// Import order below doubles as concat order for build.js.

export { createRails, findTab, findStack, findRail, emptyState, validateState, freshId };
