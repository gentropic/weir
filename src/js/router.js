// Router — evaluates plain-JS routing rules on each NEW item at insert (SPEC §6).
// Rules live in routing.js (a string in the store, eval'd here). Trust posture:
// rules are your own JS with full page power — same as your browser console.
// Don't paste rules from strangers.

export const DEFAULT_ROUTING = `// routing.js — rules run on each NEW item at insert time.
// Each rule: { name, when: (item) => boolean, then: { ...actions } | (item) => actions }
// Actions:
//   tag: ['work']            add tags (accumulate across all matching rules)
//   mark: ['read','saved']   mark read and/or saved on arrival
//   retain: 'forever' | 30   override retention (days, or never expire)
//   route: 'work'            move out of Inbox into a named view
//   notify: true             surface in the in-app notifications count
// First match wins for retain/route. A throwing rule is logged and skipped.

export default [
  // {
  //   name: 'arxiv geo → work',
  //   when: (item) => item.feed_id.includes('arxiv') && /kriging|variogram/i.test(item.title),
  //   then: { tag: ['work'], retain: 'forever' },
  // },
  // {
  //   name: 'mute sponsored',
  //   when: (item) => /sponsored|\\[ad\\]/i.test(item.title),
  //   then: { mark: ['read'] },
  // },
];
`;

// Compile the routing.js string into a rules array. Accepts `export default […]`,
// a bare array expression, or an empty string. Throws on a syntax error.
export function compileRules(src) {
  const s = String(src || '').trim();
  if (!s) return [];
  const body = s.replace(/export\s+default\s+/, 'return ');
  const code = /\breturn\b/.test(body) ? body : `return (${body})`;
  const rules = new Function(code)();   // eslint-disable-line no-new-func
  return Array.isArray(rules) ? rules : [];
}

export class Router {
  constructor() { this.rules = []; this.error = null; }

  // Recompile from source. On error, keep no rules and record the message so the
  // editor can surface it — one broken file never silently drops the pipeline.
  load(src) {
    try { this.rules = compileRules(src); this.error = null; }
    catch (e) { this.rules = []; this.error = e.message; }
    return this.error;
  }

  // Apply rules to one item: mutates item.tags / read / saved in place and
  // returns scalar side-effects { retain, route, notify, matched: [names] } for
  // the store to act on. Predicate/action errors are caught per-rule.
  apply(item) {
    const out = { matched: [] };
    for (const rule of this.rules) {
      if (!rule || rule.enabled === false || typeof rule.when !== 'function') continue;
      let hit;
      try { hit = rule.when(item); } catch (e) { console.warn(`routing rule "${rule.name || '?'}" predicate error:`, e.message); continue; }
      if (!hit) continue;
      out.matched.push(rule.name || '(unnamed)');

      let action;
      try { action = typeof rule.then === 'function' ? rule.then(item) : rule.then; }
      catch (e) { console.warn(`routing rule "${rule.name || '?'}" action error:`, e.message); continue; }
      if (!action) continue;

      if (action.tag) for (const t of [].concat(action.tag)) if (t && !item.tags.includes(t)) { item.tags.push(t); (item.tag_src ||= {})[t] = 'rule'; }
      if (action.mark) for (const m of [].concat(action.mark)) { if (m === 'read') item.read = true; if (m === 'saved') item.saved = true; }
      if (action.retain !== undefined && out.retain === undefined) out.retain = action.retain;
      if (action.route && out.route === undefined) out.route = action.route;
      if (action.notify) out.notify = true;
    }
    return out;
  }
}
