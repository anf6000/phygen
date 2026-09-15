// ─────────────────────────────────────────────────────────────────────────────
// static.mjs — a tiny read-only file server for one artwork version.
//
// It is used inside the capture container, where the host API is unavailable.
// It serves three roots and nothing else:
//
//   /runtime/…          the trusted runtime
//   /node_modules/…     the approved pinned dependencies
//   <versionPath>/…     the version snapshot
//
// Every path is resolved inside its root. A traversal leaves as 403.
// ─────────────────────────────────────────────────────────────────────────────
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.wasm': 'application/wasm',
};

/**
 * @param {object} options
 * @param {string} options.snapshotDir      the version snapshot root
 * @param {string} options.runtimeDir       the trusted runtime
 * @param {string} [options.nodeModulesDir] the approved dependency root
 * @returns {Promise<{url: string, close: Function}>}
 */
export async function startArtifactServer({ snapshotDir, runtimeDir, nodeModulesDir }) {
  const mounts = [
    { prefix: '/runtime/', root: resolve(runtimeDir) },
    { prefix: '/node_modules/', root: nodeModulesDir ? resolve(nodeModulesDir) : null },
    { prefix: '/', root: resolve(snapshotDir) },
  ].filter((mount) => mount.root);

  // The runtime and the dependency mounts never change during a capture. Keep
  // them in memory so the six sample loads do not re-read them from disk.
  const cache = new Map();
  const cacheable = (mount) => mount.prefix === '/runtime/' || mount.prefix === '/node_modules/';

  const server = createServer(async (request, response) => {
    try {
      let path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
      if (path === '/') path = '/index.html';
      const mount = mounts.find((candidate) => candidate.prefix === '/' || path.startsWith(candidate.prefix));
      const relativePath = mount.prefix === '/' ? path.slice(1) : path.slice(mount.prefix.length);
      const target = normalize(join(mount.root, relativePath));
      if (!target.startsWith(mount.root)) {
        response.writeHead(403);
        response.end('forbidden');
        return;
      }
      const useCache = cacheable(mount);
      let body = useCache ? cache.get(target) : null;
      if (!body) {
        const info = await stat(target);
        if (!info.isFile()) {
          response.writeHead(404);
          response.end('not found');
          return;
        }
        body = await readFile(target);
        if (useCache) cache.set(target, body);
      }
      response.writeHead(200, {
        'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
        'cache-control': useCache ? 'public, max-age=3600' : 'no-store',
        'content-security-policy':
          "default-src 'none'; img-src 'self' data:; connect-src 'none'; base-uri 'none'; form-action 'none'",
      });
      response.end(body);
    } catch {
      response.writeHead(404);
      response.end('not found');
    }
  });

  await new Promise((resolve_) => server.listen(0, '127.0.0.1', resolve_));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () =>
      new Promise((resolve_) => {
        server.close(() => resolve_());
      }),
  };
}
