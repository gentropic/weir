// Command-palette fuzzy ranking (pure; DOM-free). Run: node tools/smoke-palette.mjs
import assert from 'node:assert';
import { filterActions, parseScoped } from '../src/js/ui/palette.js';

const A = [
  { label: 'Inbox', kind: 'View' },
  { label: 'Saved', kind: 'View' },
  { label: 'Settings', kind: 'Command' },
  { label: 'Hacker News', kind: 'Source', hint: 'tech' },
  { label: 'Catalog all items with AI', kind: 'Command' },
  { label: 'Cassidy’s Blog', kind: 'Source' },
  { label: 'Reading', kind: 'Route' },
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

// ── scope sigils ──
assert.deepEqual(parseScoped('>cat'), { kind: 'Command', q: 'cat' }, '> → Command scope');
assert.deepEqual(parseScoped('@cass'), { kind: 'Source', q: 'cass' }, '@ → Source scope');
assert.deepEqual(parseScoped('#read'), { kind: 'Route', q: 'read' }, '# → Route scope');
assert.deepEqual(parseScoped('plain'), { kind: null, q: 'plain' }, 'no sigil → no scope');

// > scopes to commands only — a source named "Cassidy" never appears
const cmds = filterActions(A, '>cat');
assert.ok(cmds.length && cmds.every((a) => a.kind === 'Command'), '>cat returns only commands');
assert.equal(cmds[0].label, 'Catalog all items with AI', '>cat → the catalog command');

// @ scopes to sources; bare "ca" (no sigil) would also surface the command
assert.ok(filterActions(A, '@ca').every((a) => a.kind === 'Source'), '@ca returns only sources');
assert.ok(filterActions(A, 'ca').some((a) => a.kind === 'Command'), 'ca (unscoped) still mixes kinds');

// a lone sigil lists everything of that kind
assert.deepEqual(filterActions(A, '>').map((a) => a.label).sort(), ['Catalog all items with AI', 'Settings'], '> alone → all commands');
assert.equal(filterActions(A, '#')[0].label, 'Reading', '# alone → routes');

console.log('palette smoke ok:', JSON.stringify({ all: filterActions(A, '').length, cmds: cmds.length, sources: filterActions(A, '@').length }));
