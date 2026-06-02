// Catalog card storage: bucketed-shard persistence + legacy per-file migration.
// Run: node tools/smoke-cards.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';

// ── sharded persistence round-trip (two Stores share one vfs = "reload") ──
const vfs = await VFS.create();
const s1 = new Store(vfs); await s1._hydrate();
await s1.putFeed({ id: 'f', name: 'F', adapter: 'feed', url: 'http://x/f' });
await s1.upsertItems([{ id: 'i1', feed_id: 'f', type: 'article', title: 'T1' }, { id: 'i2', feed_id: 'f', type: 'article', title: 'T2' }]);
const g1 = await s1.writeCard({ glass: { document_ref: 'i1', cataloged: '2026-06-02' }, facets: { domain: ['x'] }, dublin_core: {} });
const g2 = await s1.writeCard({ glass: { document_ref: 'i2', cataloged: '2026-06-02' }, facets: { domain: ['y'] }, dublin_core: {} });
assert.notEqual(g1, g2, 'two cards same day get distinct glass_ids (in-memory seq)');
assert.equal(await s1.catalogCount(), 2);
await s1.flush();

const catFiles = await vfs.readdir('/catalog');
assert.ok(catFiles.length > 0 && catFiles.every((f) => /^cards-[0-9a-f]{2}\.ndjson$/.test(f)), 'only bucketed shards, NO per-card json: ' + catFiles.join(','));

// "reload" — a new Store on the same vfs hydrates cards from the shards
const s2 = new Store(vfs); await s2._hydrate();
assert.equal(await s2.catalogCount(), 2, 'cards survive reload');
assert.deepEqual((await s2.getCard(g1)).facets.domain, ['x'], 'card content survives reload');
assert.equal(s2.getItem('i1').glass_id, g1, 'item glass_id stamp persisted');
// seq continues across reload (scans the hydrated cards) — no collision
await s2.upsertItems([{ id: 'i3', feed_id: 'f', type: 'article', title: 'T3' }]);
const g3 = await s2.writeCard({ glass: { document_ref: 'i3', cataloged: '2026-06-02' }, facets: {}, dublin_core: {} });
assert.ok(g3 !== g1 && g3 !== g2, `post-reload card gets a fresh seq (got ${g3})`);
// markCardReviewed persists
await s2.markCardReviewed(g1, { facets: { domain: ['reviewed'] } });
await s2.flush();
const s3 = new Store(vfs); await s3._hydrate();
assert.equal((await s3.getCard(g1)).glass.reviewer, 'human', 'review persisted across reload');
assert.deepEqual((await s3.getCard(g1)).facets.domain, ['reviewed'], 'reviewed facet persisted');

// ── legacy per-file migration (your existing /catalog/glass-*.json files) ──
const v2 = await VFS.create();
const seed = new Store(v2); await seed._hydrate();   // ensures /catalog exists
await v2.writeFile('/catalog/glass-20260601-001.json', JSON.stringify({ glass: { glass_id: 'glass-20260601-001', document_ref: 'a' }, facets: { domain: ['old1'] }, dublin_core: {} }));
await v2.writeFile('/catalog/glass-20260601-002.json', JSON.stringify({ glass: { glass_id: 'glass-20260601-002', document_ref: 'b' }, facets: { domain: ['old2'] }, dublin_core: {} }));
const mig = new Store(v2); await mig._hydrate();   // migrates on hydrate
assert.equal(await mig.catalogCount(), 2, 'legacy cards loaded into the index');
assert.deepEqual((await mig.getCard('glass-20260601-002')).facets.domain, ['old2'], 'legacy card content preserved');
const after = await v2.readdir('/catalog');
assert.ok(!after.some((f) => /^glass-.*\.json$/.test(f)), 'legacy per-file cards removed AFTER packing: ' + after.join(','));
assert.ok(after.some((f) => /^cards-[0-9a-f]{2}\.ndjson$/.test(f)), 'shards written');
// idempotent — re-hydrating again is safe + lossless
const mig2 = new Store(v2); await mig2._hydrate();
assert.equal(await mig2.catalogCount(), 2, 're-hydrate is idempotent');

console.log('cards smoke ok:', JSON.stringify({ shards: catFiles.length, reloadCount: 2, migrated: 2 }));
