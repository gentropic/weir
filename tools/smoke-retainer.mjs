// Retainer test — retention ARCHIVES expired items (never deletes), respects
// saved/off-switch. Run: node tools/smoke-retainer.mjs

import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { Retainer } from '../src/js/retainer.js';

const store = new Store(await VFS.create());
await store._hydrate();
await store.putFeed({ id: 'f', name: 'F', adapter: 'feed', url: 'http://f' });

const OLD = 1000, NOW = 10_000_000;
await store.upsertItems([
  { id: 'f:old', feed_id: 'f', title: 'old', type: 'article', published_at: OLD },
  { id: 'f:fresh', feed_id: 'f', title: 'fresh', type: 'article', published_at: NOW },
  { id: 'f:savedold', feed_id: 'f', title: 'saved old', type: 'article', published_at: OLD },
]);
// Force expiry relative to the real clock: old/saved expired long ago; fresh far future.
store.getItem('f:old').expires_at = 1;
store.getItem('f:fresh').expires_at = Date.now() + 1e10;
store.setState('f:savedold', { saved: true });   // saved → never expires
store.getItem('f:savedold').expires_at = 1;

// Off by default → nothing happens.
assert.equal(store.getSettings().retention_enabled, false, 'retention off by default');
const r = new Retainer(store);
assert.deepEqual(r.sweep(), { archived: 0 }, 'no-op while disabled');
assert.equal(store.getItem('f:old').archived, false, 'nothing archived while off');

// Enable → expired non-saved item is ARCHIVED, not deleted.
await store.setSettings({ retention_enabled: true });
assert.deepEqual(r.sweep(), { archived: 1 }, 'one expired item archived');
assert.equal(store.getItem('f:old') != null, true, 'expired item still EXISTS (not deleted)');
assert.equal(store.getItem('f:old').archived, true, 'expired item is archived (cold)');
assert.equal(store.getItem('f:fresh').archived, false, 'fresh item untouched');
assert.equal(store.getItem('f:savedold').archived, false, 'saved item exempt from expiry');

// It moved out of the inbox but is readable in the archived view.
assert.equal(store.query({ view: 'inbox' }).some((x) => x.id === 'f:old'), false, 'archived item left the inbox');
assert.equal(store.query({ view: 'archived' }).some((x) => x.id === 'f:old'), true, 'archived item visible in archived view');

// Idempotent — already-archived not re-counted.
assert.deepEqual(r.sweep(), { archived: 0 }, 'second sweep is a no-op');

// unarchiveAll restores everything + clears expiry, so it can't be re-shelved.
assert.equal(store.unarchiveAll(), 1, 'one archived item restored');
assert.equal(store.getItem('f:old').archived, false, 'back to active');
assert.equal(store.getItem('f:old').expires_at, null, 'expiry cleared → keep forever');
assert.deepEqual(r.sweep(), { archived: 0 }, 'retention does NOT re-shelve the restored item');
assert.equal(store.query({ view: 'inbox' }).some((x) => x.id === 'f:old'), true, 'restored item is back in the inbox');

console.log('retainer smoke ok:', JSON.stringify(store.counts()));
