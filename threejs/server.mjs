// ─────────────────────────────────────────────────────────────────────────────
// server.mjs — tiny static server for the artwork package.
//   http://localhost:8138/                 → index.html (the artwork)
//   http://localhost:8138/node_modules/…   → three.js
//   http://localhost:8138/runtime/…        → the trusted runtime contract
//
// The runtime is served from outside the package, exactly as a controller would
// provide it. Artwork packages import it through a relative path.
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const RUNTIME_ROOT = fileURLToPath(new URL('../runtime/', import.meta.url));
const PORT = process.env.PORT || 8138;

/** Longest prefix wins, so the runtime mount is listed first. */
const MOUNTS = [
  { prefix: '/runtime/', root: RUNTIME_ROOT },
  { prefix: '/', root: ROOT },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.wasm': 'application/wasm',
};

/** Map a request path to a file inside a mount, or null when it escapes. */
function resolveRequest(urlPath) {
  const mount = MOUNTS.find((candidate) => candidate.prefix === '/' || urlPath.startsWith(candidate.prefix));
  const relative = mount.prefix === '/' ? urlPath.slice(1) : urlPath.slice(mount.prefix.length);
  const target = normalize(join(mount.root, relative));
  return target.startsWith(mount.root) ? target : null;
}

createServer(async (req, res) => {
  try {
    let url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (url === '/') url = '/index.html';
    const path = resolveRequest(url);
    if (!path) { res.writeHead(403); res.end(); return; }
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': MIME[extname(path).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}).listen(PORT, () => {
  console.log(`phyvolution (three.js) serving at http://localhost:${PORT}/`);
});
