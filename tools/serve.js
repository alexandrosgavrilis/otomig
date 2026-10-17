/**
 * The development server behind `npm start`. No dependencies.
 *
 * It replaces `python3 -m http.server`, which sends no cache headers. Without
 * them a browser may keep using a module it fetched earlier, and after an
 * update it can run a mix of old and new files: on Oct 17 2026 an import
 * failed with "ways is not iterable" because a new worker met a cached, older
 * data/overpass.js. Here every response says `Cache-Control: no-cache`, so
 * the browser asks each time — and an unchanged file still comes back as a
 * quick 304.
 *
 * Like Python's server it listens on every interface, so a tablet on the same
 * network can play at http://<this machine's address>:8000.
 *
 * Run: node tools/serve.js [port]
 */

import { createServer } from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PORT = Number(process.argv[2]) || 8000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

createServer((request, response) => {
  const path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
  let file = normalize(join(ROOT, path));
  // Never serve anything outside the project.
  if (file !== ROOT && !file.startsWith(ROOT + sep)) {
    response.writeHead(403).end();
    return;
  }

  let stats;
  try {
    stats = statSync(file);
    if (stats.isDirectory()) {
      file = join(file, 'index.html');
      stats = statSync(file);
    }
  } catch {
    response.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    return;
  }

  const modified = stats.mtime.toUTCString();
  const headers = {
    'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache',
    'Last-Modified': modified,
  };
  const since = request.headers['if-modified-since'];
  if (since && new Date(since) >= new Date(modified)) {
    response.writeHead(304, headers).end();
    return;
  }
  response.writeHead(200, { ...headers, 'Content-Length': stats.size });
  if (request.method === 'HEAD') { response.end(); return; }
  createReadStream(file).pipe(response);
}).listen(PORT, () => {
  console.log(`OTOMIG at http://localhost:${PORT} (no-cache, so updates always load)`);
});
