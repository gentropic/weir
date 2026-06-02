// Command-palette fuzzy ranking (pure; DOM-free). Run: node tools/smoke-palette.mjs
import assert from 'node:assert';
import { filterActions } from '../src/js/ui/palette.js';

const A = [
  { label: 'Inbox', kind: 'View' },
  { label: 'Saved', kind: 'View' },
  { label: 'Settings', kind: 'Command' },
  { label: 'Hacker News', kind: 'Source', hint: 'tech' },
  { label: 'Catalog all items with AI', kind: 'Command' },
];

// empty query → everything, original order (groups intact)
assert.deepEqual(filterActions(A, '').map((a) => a.label), A.map((a) => a.label), 'empty query keeps order');

// contiguous substring ranks first
assert.equal(filterActions(A, 'inb')[0].label, 'Inbox', 'inb → Inbox');
assert.equal(filterActions(A, 'cat')[0].label, 'Catalog all items with AI', 'cat → Catalog');

// non-contiguous subsequence still matches
assert.ok(filterActions(A, 'stg').some((a) => a.label === 'Settings'), 'stg → Settings (subsequence)');

// a query that only hits the hint still surfaces (demoted, but found)
assert.equal(filterActions(A, 'tech')[0].label, 'Hacker News', 'hint-only match found');

// no match → empty
assert.equal(filterActions(A, 'zzzz').length, 0, 'no matches → empty');

// label match outranks hint-only match: "saved" is a label, never a hint
assert.equal(filterActions(A, 'saved')[0].label, 'Saved', 'label beats hint');

console.log('palette smoke ok:', JSON.stringify({ all: filterActions(A, '').length, inb: filterActions(A, 'inb').length }));
