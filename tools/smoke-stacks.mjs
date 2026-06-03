// Stacks store tests (STACKS.md) — uid identity, scan/stamp, move-keeps-state,
// missing/forget, telegram-stash ingest, reload stability, markdown render.
// Run: node tools/smoke-stacks.mjs
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';
import { StacksStore } from '../src/js/stacks.js';
import { renderMarkdown } from '../src/js/ui/markdown.js';
import { Router } from '../src/js/router.js';

const fresh = async () => { const s = new Store(await VFS.create()); await s._hydrate(); return s; };

// ── ensure(): synthetic feed + dirs ──
let store = await fresh();
let stacks = new StacksStore(store);
await stacks.ensure();
assert.ok(store.getFeed('stacks'), 'stacks feed registered');
assert.equal(store.getFeed('stacks').adapter, 'stacks');

// ── writeNote: item shape, content_path, body round-trip ──
const note = await stacks.writeNote({ title: 'Huffman coding', markdown: '# Huffman coding\n\nA *greedy* prefix code.', tags: ['cs', 'algorithms'] });
assert.ok(note.id.startsWith('stacks:'), 'id is stacks:<uid>');
assert.equal(note.id, `stacks:${note.uid}`, 'id pairs to uid');
assert.equal(note.type, 'note');
assert.equal(note.feed_id, 'stacks');
assert.equal(note.path, 'inbox/huffman-coding.md', 'filed into inbox, slugified');
assert.ok(note.content_path === '/stacks/inbox/huffman-coding.md', 'content_path = real tree path');
assert.ok(note.has_content);
assert.deepEqual(note.tags, ['cs', 'algorithms']);
const rawFile = await store.getContent(note.id);
assert.ok(rawFile.startsWith('---\n'), 'file carries frontmatter');
const body = await stacks.readNote(note);
assert.ok(body.startsWith('# Huffman'), 'readNote strips frontmatter');
assert.ok(!body.includes('uid'), 'body has no frontmatter leakage');

// frontmatter parses back (strict @gcu/yaml round-trip) with our identity fields
const { data } = stacks._splitFm(rawFile);
assert.equal(data.uid, note.uid, 'uid persisted to frontmatter');
assert.equal(data.title, 'Huffman coding');
assert.deepEqual(data.tags, ['cs', 'algorithms']);
assert.ok(data.created, 'created stamped');

// ── scan stamps uid into a plain (frontmatter-less) note, then is stable ──
await store.vfs.mkdir('/stacks/papers', { recursive: true });
await store.vfs.writeFile('/stacks/papers/raw.md', '# Raw note\n\nNo frontmatter here.');
let r1 = await stacks.scan();
assert.ok(r1.stamped >= 1, 'plain note got a uid stamped');
const rawNote = stacks.entries().find((e) => e.path === 'papers/raw.md');
assert.ok(rawNote && rawNote.uid, 'plain note now indexed with a uid');
const stampedFile = await store.vfs.readFile('/stacks/papers/raw.md', 'utf8');
assert.ok(stampedFile.startsWith('---\n') && stampedFile.includes(rawNote.uid), 'uid written into the file');
const uidBefore = rawNote.uid;
const r2 = await stacks.scan();
assert.equal(r2.stamped, 0, 're-scan does not re-stamp');
assert.equal(stacks.entries().find((e) => e.path === 'papers/raw.md').uid, uidBefore, 'uid stable across scans');

// ── identity survives a move: same uid/id, human state preserved ──
store.setState(note.id, { read: true });
store.addTag(note.id, 'keep', 'human');
const moved = await stacks.move(note, 'papers');
assert.equal(moved.id, note.id, 'move keeps the same item id');
assert.equal(moved.uid, note.uid, 'uid unchanged');
assert.equal(moved.path, 'papers/huffman-coding.md', 'path updated to new folder');
assert.equal(store.getItem(note.id).read, true, 'read-state rode along the move');
assert.ok(store.getItem(note.id).tags.includes('keep'), 'human tag rode along');
assert.equal(await store.vfs.exists('/stacks/inbox/huffman-coding.md'), false, 'old path gone');
assert.equal(await store.vfs.exists('/stacks/papers/huffman-coding.md'), true, 'new path present');

// ── addFile: binary + sidecar, indexed as a file entry ──
const fileRec = await stacks.addFile({ name: 'paper.pdf', bytes: new Uint8Array([1, 2, 3, 4]), tags: ['ref'] });
assert.equal(fileRec.type, 'file');
assert.equal(fileRec.mime, 'application/pdf', 'mime from extension');
assert.equal(await store.vfs.exists('/stacks/inbox/paper.pdf.meta.json'), true, 'sidecar written');
const bytes = await stacks.readBytes(fileRec);
assert.ok(bytes && bytes.length === 4, 'file bytes read back');

// ── missing → forget (never auto-delete) ──
await store.vfs.unlink('/stacks/papers/raw.md');
const r3 = await stacks.scan();
assert.ok(r3.missing >= 1, 'vanished file flagged missing');
assert.equal(store.getItem(`stacks:${uidBefore}`).missing, true, 'item marked missing, not deleted');
const forgot = stacks.forgetMissing();
assert.ok(forgot >= 1, 'forgetMissing cleared the ghost');
assert.equal(store.getItem(`stacks:${uidBefore}`), null, 'ghost gone after forget');

// ── telegram stash ingest ──
await store.vfs.writeFile('/telegram-notes.ndjson',
  JSON.stringify({ at: Date.now(), text: 'first thought', from: 'me' }) + '\n' +
  JSON.stringify({ at: Date.now(), text: 'second thought\nwith detail', from: 'me' }));
const ingested = await stacks.ingestStash();
assert.equal(ingested, 2, 'two stashed notes ingested');
assert.equal((await store.vfs.readFile('/telegram-notes.ndjson', 'utf8')).trim(), '', 'stash cleared after consume');
const tgNotes = stacks.entries().filter((e) => (e.tags || []).includes('telegram'));
assert.equal(tgNotes.length, 2, 'both telegram notes are stacks entries');
assert.ok(tgNotes.every((e) => e.path.startsWith('inbox/')), 'telegram notes land in inbox');

// ── filing rules (Stage B): rule → folder; explicit wins; re-file inbox ──
{
  const router = new Router();
  router.loadStacks(`export default [{ name: 'specs', when: (e) => /\\bspec\\b/i.test(e.title), then: { folder: 'specs', tag: ['spec'] } }]`);
  store.router = router;
  const filed = await stacks.writeNote({ title: 'Big Spec', markdown: 'x' });   // no folder → rule decides
  assert.ok(filed.path.startsWith('specs/'), 'rule filed the note into specs/');
  assert.ok(filed.tags.includes('spec'), 'rule tag merged onto the entry');
  const plain = await stacks.writeNote({ title: 'a random thought', markdown: 'y' });
  assert.ok(plain.path.startsWith('inbox/'), 'no rule match → inbox');
  const pinned = await stacks.writeNote({ folder: 'notes', title: 'Spec but pinned', markdown: 'z' });
  assert.ok(pinned.path.startsWith('notes/'), 'explicit folder beats the rule');
  // re-file: a matching note forced into inbox is swept out by refileInbox
  const late = await stacks.writeNote({ folder: 'inbox', title: 'Late Spec', markdown: 'q' });
  assert.ok(late.path.startsWith('inbox/'), 'forced into inbox first');
  const swept = await stacks.refileInbox();
  assert.ok(swept.moved >= 1, 'refileInbox moved the matching inbox note');
  assert.ok(store.getItem(late.id).path.startsWith('specs/'), 'late spec re-filed to specs/ (uid kept)');
  store.router = null;   // don't affect the reload section below
}

// ── wiki-links: [[ref]] targets extracted onto item.links (the backlinks source) ──
{
  const a = await stacks.writeNote({ title: 'Linker', markdown: 'see [[zzz]] and [[notes/about.md|the doc]] and [[zzz]] again' });
  assert.deepEqual(store.getItem(a.id).links, ['zzz', 'notes/about.md'], 'links extracted, deduped, label-stripped');
  const b = await stacks.writeNote({ title: 'No links', markdown: 'plain text' });
  assert.deepEqual(store.getItem(b.id).links, [], 'no [[refs]] → empty links');
  // editing the body updates links
  await stacks.saveNote(store.getItem(b.id), 'now links [[xyz]]');
  assert.deepEqual(store.getItem(b.id).links, ['xyz'], 'saveNote re-extracts links');
}

// ── reload stability: uids + state survive a re-hydrate ──
await store.flush();
const re = new Store(store.vfs); await re._hydrate();
const reStacks = new StacksStore(re);
await reStacks.ensure();
await reStacks.scan();
const reNote = re.getItem(note.id);
assert.ok(reNote, 'note survived reload by id');
assert.equal(reNote.uid, note.uid, 'uid survived reload');
assert.equal(reNote.read, true, 'read-state survived reload');
assert.ok(reNote.tags.includes('keep'), 'tag survived reload');

// ── markdown render ──
const html = renderMarkdown('# Title\n\nA **bold** and *italic* and `code` line with a [link](https://x.y) and a [[abc123|wiki]].\n\n- one\n- two\n\n> quoted\n\n```js\nlet x = 1 < 2;\n```');
assert.ok(html.includes('<h1>Title</h1>'), 'heading');
assert.ok(html.includes('<strong>bold</strong>'), 'bold');
assert.ok(html.includes('<em>italic</em>'), 'italic');
assert.ok(html.includes('<code>code</code>'), 'code span');
assert.ok(html.includes('<a href="https://x.y">link</a>'), 'link');
assert.ok(html.includes('class="wikilink" data-uid="abc123"') && html.includes('>wiki<'), 'wiki-link reserved + labelled');
assert.ok(html.includes('<ul><li>one</li><li>two</li></ul>'), 'list');
assert.ok(html.includes('<blockquote>'), 'blockquote');
assert.ok(html.includes('let x = 1 &lt; 2;') && html.includes('language-js'), 'fenced code escaped + lang');
// a bare number in prose must NOT be eaten by the code-span restore
assert.ok(renderMarkdown('I have 3 apples').includes('I have 3 apples'), 'prose number survives');

console.log('stacks smoke ok:', JSON.stringify({ entries: stacks.entries().length, ...r1 }));
