// Router tests: compile, apply (tags/mark/retain/route/notify, error tolerance),
// and store integration. Run: node tools/smoke-router.mjs

import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { Router, compileRules } from '../src/js/router.js';

// ── compile ──
assert.deepEqual(compileRules(''), [], 'empty → []');
assert.equal(compileRules('export default [{name:"a",when:()=>true,then:{tag:["x"]}}]').length, 1, 'export default form');
assert.equal(compileRules('[{name:"b",when:()=>true,then:{}}]').length, 1, 'bare array form');

// ── apply ──
const router = new Router();
router.load(`export default [
  { name: 'tag work', when: (i) => /kriging/i.test(i.title), then: { tag: ['work'], retain: 'forever' } },
  { name: 'also geo', when: (i) => i.type === 'paper', then: { tag: ['geo'] } },
  { name: 'mute ads', when: (i) => /sponsored/i.test(i.title), then: { mark: ['read'] } },
  { name: 'route news', when: (i) => i.feed_id === 'news', then: { route: 'later', notify: true } },
  { name: 'boom', when: () => { throw new Error('bad predicate'); }, then: {} },
]`);
assert.equal(router.error, null, 'compiled without error');

const a = { title: 'Kriging variograms', type: 'paper', feed_id: 'arxiv', tags: [], read: false, saved: false };
const fxa = router.apply(a);
assert.deepEqual(a.tags, ['work', 'geo'], 'tags accumulate across rules');
assert.equal(fxa.retain, 'forever', 'first retain wins');
assert.ok(fxa.matched.includes('tag work') && fxa.matched.includes('also geo'), 'matched names');

const b = { title: 'Sponsored thing', type: 'article', feed_id: 'news', tags: [], read: false, saved: false };
const fxb = router.apply(b);
assert.equal(b.read, true, 'mark read applied');
assert.equal(fxb.route, 'later', 'route set');
assert.equal(fxb.notify, true, 'notify set');
// the throwing rule was skipped, not fatal — apply returned normally above.

// ── store integration ──
const store = new Store(await VFS.create());
await store._hydrate();
store.router = router;
await store.putFeed({ id: 'news', name: 'News', adapter: 'feed', url: 'http://n' });
await store.putFeed({ id: 'arxiv', name: 'arXiv', adapter: 'feed', url: 'http://a' });
await store.upsertItems([
  { id: 'arxiv:1', feed_id: 'arxiv', title: 'Kriging study', type: 'paper', published_at: 2000 },
  { id: 'news:1', feed_id: 'news', title: 'Sponsored post', type: 'article', published_at: 1000 },
]);

assert.deepEqual(store.getItem('arxiv:1').tags, ['work', 'geo'], 'rules tagged on insert');
assert.equal(store.getItem('arxiv:1').expires_at, null, "retain:'forever' → no expiry");
assert.equal(store.getItem('news:1').route, 'later', 'item routed');
assert.equal(store.getItem('news:1').read, true, 'item marked read by rule');
assert.equal(store.query({ view: 'inbox' }).length, 1, 'routed item left the inbox');
assert.equal(store.query({ route: 'later' }).length, 1, 'routed item in its route view');
assert.equal(store.counts().routes.later, 1, 'route count');
assert.equal(store.notifications.length, 1, 'notification collected');

// ── rerun over history (additive) ──
store.router.load(`export default [{ name: 'tag all', when: () => true, then: { tag: ['seen'] } }]`);
const rr = store.rerunRules();
assert.equal(rr.matched, 2, 'rerun matched all stored items');
assert.ok(store.getItem('arxiv:1').tags.includes('seen'), 'rerun applied new tag');

console.log('router smoke ok:', JSON.stringify(store.counts().routes));
