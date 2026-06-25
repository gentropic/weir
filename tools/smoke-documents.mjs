// addDocument (SPEC-documents §2a) against the in-memory backend (node). Verifies the STORAGE path:
// content-addressed blob file, the `document` item, searchable text round-trip, the page-offset map,
// the synthetic source, and idempotent re-ingest. PDF extraction (pdf.js) is browser-only — proven
// via `__weir.testPdf` / the documents.js spike, not here. Run: `node tools/smoke-documents.mjs`.
import assert from 'node:assert';
import { VFS } from '../vendor/vfs.js';
import { Store } from '../src/js/store/store.js';

const vfs = await VFS.create();
const store = new Store(vfs);
await store._hydrate();

const bytes = new TextEncoder().encode('%PDF-1.4 ' + 'x'.repeat(300));
const text = 'kriging and variography over change-of-support';
const id = await store.addDocument({ bytes, ext: 'pdf', title: 'Variography Primer', text, pageCount: 3, pageOffsets: [{ page: 1, start: 0 }] });

assert.match(id, /^document:[0-9a-f]{64}$/, 'content-addressed id (document:<sha256>)');
const sha = id.split(':')[1];

const item = store.getItem(id);
assert.ok(item, 'item created');
assert.equal(item.type, 'document', 'type is document (in ITEM_TYPES, not coerced to article)');
assert.equal(item.title, 'Variography Primer', 'title kept');
assert.equal(item.has_content, true, 'has content');
assert.equal(item.structured.blob.sha256, sha, 'blob sha recorded in structured');
assert.equal(item.structured.blob.pages, 3, 'page count recorded');
assert.equal(item.structured.doc_kind, 'pdf', 'doc_kind recorded');
assert.deepEqual(item.structured.pageOffsets, [{ page: 1, start: 0 }], 'page-offset map kept (weir_quote seed)');

assert.equal(await store.getContent(id), text, 'extracted text round-trips (searchable body)');

const blob = await store.getDocumentBlob(sha, 'pdf');
assert.equal(blob.length, bytes.length, 'binary stored as a VFS file + readable, same byte length');

assert.ok(store.getFeed('documents'), 'synthetic "documents" source created');

// idempotent: re-ingesting the same bytes returns the same id and does not duplicate the item
const before = store.items.size;
const id2 = await store.addDocument({ bytes, ext: 'pdf', title: 'Variography Primer', text, pageCount: 3 });
assert.equal(id2, id, 'idempotent re-ingest → same id (content-addressed)');
assert.equal(store.items.size, before, 'no duplicate item on re-ingest');

// empty input is rejected (no silent empty document)
await assert.rejects(store.addDocument({ bytes: new Uint8Array(), text: 'x' }), /no bytes/, 'empty bytes rejected');

console.log('documents (addDocument storage path) smoke ok');
