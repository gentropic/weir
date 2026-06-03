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

export const DEFAULT_STACKS_ROUTING = `// stacks-routing.js — rules run when a note/file ARRIVES without an explicit folder
// (a Telegram drop, a quick note, a file). An explicit path always wins; no match → inbox.
// Each rule: { name, when: (entry) => boolean, then: { folder, tag } | (entry) => actions }
// entry: { title, text, type: 'note' | 'file', source, name }
// Actions:
//   folder: 'specs'   file into /stacks/<folder>/   (first match wins)
//   tag: ['spec']     add tags
// Applied at intake — use "Re-file inbox" to sweep existing inbox entries through them.

export default [
  // { name: 'specs',  when: (e) => /\\bspec\\b/i.test(e.title),            then: { folder: 'specs', tag: ['spec'] } },
  // { name: 'papers', when: (e) => /arxiv\\.org|\\bdoi\\b/i.test(e.text),   then: { folder: 'papers' } },
  // { name: 'tg drops', when: (e) => e.source === 'telegram' && e.type === 'file', then: { folder: 'drops' } },
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
  constructor() { this.rules = []; this.error = null; this.stacksRules = []; this.stacksError = null; }

  // Recompile from source. On error, keep no rules and record the message so the
  // editor can surface it — one broken file never silently drops the pipeline.
  load(src) {
    try { this.rules = compileRules(src); this.error = null; }
    catch (e) { this.rules = []; this.error = e.message; }
    return this.error;
  }

  // The stacks filing ruleset — same engine, a separate list (different inflow +
  // effect vocabulary; STACKS.md §4). Recompiled from /stacks-routing.js.
  loadStacks(src) {
    try { this.stacksRules = compileRules(src); this.stacksError = null; }
    catch (e) { this.stacksRules = []; this.stacksError = e.message; }
    return this.stacksError;
  }

  // Decide a stacks entry's folder (+ tags) from the stacks rules. First match wins
  // for `folder`; tags accumulate. entry = { title, text, type, source, name }.
  // Returns { folder?, tags: [] } — caller falls back to inbox when no folder.
  fileStacks(entry) {
    const out = { tags: [] };
    for (const rule of (this.stacksRules || [])) {
      if (!rule || rule.enabled === false || typeof rule.when !== 'function') continue;
      let hit; try { hit = rule.when(entry); } catch (e) { console.warn(`stacks rule "${rule.name || '?'}" predicate error:`, e.message); continue; }
      if (!hit) continue;
      let action; try { action = typeof rule.then === 'function' ? rule.then(entry) : rule.then; } catch (e) { console.warn(`stacks rule "${rule.name || '?'}" action error:`, e.message); continue; }
      if (!action) continue;
      if (action.tag) for (const t of [].concat(action.tag)) if (t && !out.tags.includes(t)) out.tags.push(t);
      if (action.folder && out.folder === undefined) out.folder = action.folder;
    }
    return out;
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
