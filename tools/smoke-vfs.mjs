// Smoke test for the vendored VFS bundle — runs in Node against the in-memory
// backend (IndexedDB/OPFS/FSA need a browser). Confirms vendor/vfs.js loads as
// an ES module and round-trips a write/read. Run: `node tools/smoke-vfs.mjs`.

import { VFS } from '../vendor/vfs.js';

const vfs = await VFS.create();              // default: memory mounted at /
await vfs.mkdir('/feeds', { recursive: true });
await vfs.writeFile('/feeds/hello.txt', 'hi weir');
const back = await vfs.readFile('/feeds/hello.txt', 'utf8');

if (back !== 'hi weir') {
  console.error('FAIL: round-trip mismatch:', JSON.stringify(back));
  process.exit(1);
}

const entries = await vfs.readdir('/feeds');
console.log('VFS memory round-trip ok:', JSON.stringify(back));
console.log('mounts:', JSON.stringify(vfs.mounts()));
console.log('readdir /feeds:', JSON.stringify(entries));
