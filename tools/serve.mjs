// Zero-dep static server for local dev. Serving over http://localhost gives a
// stable (non-opaque) origin, so IndexedDB / navigator.storage.persist() /
// estimate() all work — unlike file://, where Chromium treats every file as a
// unique opaque origin and blocks persistent storage.
//
// Run: `node tools/serve.mjs` → open http://localhost:8017/
// (build first with `node build.js`).

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 8017;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
};

createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (p === '/') p = '/index.html';
    const fp = normalize(join(ROOT, p));
    if (fp !== ROOT && !fp.startsWith(ROOT + sep)) { res.writeHead(403).end('forbidden'); return; }
    const s = await stat(fp);
    if (s.isDirectory()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(fp).toLowerCase()] || 'application/octet-stream' });
    res.end(await readFile(fp));
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(PORT, () => console.log(`weir dev server → http://localhost:${PORT}/`));
