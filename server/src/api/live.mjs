// ─────────────────────────────────────────────────────────────────────────────
// live.mjs — the artwork origin.
//
// This origin serves artwork code and NOTHING else. It has no API, no
// credentials, and no cookie. Artwork pages are sandboxed by their content
// security policy, so candidate code cannot reach the controller.
//
//   /v/runtime/…                  the trusted runtime
//   /v/<versionId>/node_modules/… approved pinned dependencies
//   /v/<versionId>/…              the version snapshot
//
// Every response carries a policy that allows scripts from this origin only,
// no network, and no inline script except the exact scripts the page carries.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';

import Fastify from 'fastify';

import { isInside } from '../artifacts.mjs';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
};

/** Hashes of the inline scripts in one HTML document, for the policy header. */
function inlineScriptHashes(html) {
  const hashes = [];
  const pattern = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
  let match = pattern.exec(html);
  while (match) {
    const body = match[1];
    if (body.trim().length > 0) {
      hashes.push(`'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`);
    }
    match = pattern.exec(html);
  }
  return hashes;
}

function policyFor({ html, frameAncestors, origin }) {
  const scriptHashes = html ? inlineScriptHashes(html) : [];
  // Absolute sources, not 'self': inside a sandboxed frame the document has an
  // opaque origin, so 'self' would match nothing and the artwork could not load
  // its own modules or its configuration.
  const directives = [
    "default-src 'none'",
    `script-src ${origin}${scriptHashes.length > 0 ? ` ${scriptHashes.join(' ')}` : ''}`,
    `style-src ${origin} 'unsafe-inline'`,
    `img-src ${origin} data:`,
    `connect-src ${origin}`,
    `font-src ${origin}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ];
  if (frameAncestors) directives.push(`frame-ancestors ${frameAncestors}`);
  return directives.join('; ');
}

export function createLiveServer({ store, config }) {
  const app = Fastify({ logger: false, bodyLimit: 1024 });
  const runtimeDir = resolve(join(config.repoRoot, 'runtime'));
  const origin = `http://${config.host}:${config.livePort}`;
  const frameAncestors = config.safety.liveFrameAncestors || `http://${config.host}:${config.port} http://localhost:${config.port}`;

  app.get('/*', async (request, reply) => {
    const path = decodeURIComponent(new URL(request.url, 'http://x').pathname);
    const parts = path.split('/').filter(Boolean);

    if (parts[0] !== 'v' || parts.length < 2) {
      reply.code(404).type('text/plain').send('not found');
      return;
    }

    if (parts[1] === 'runtime') {
      return serveFile({ reply, root: runtimeDir, relative: parts.slice(2).join('/'), frameAncestors });
    }

    const versionId = parts[1];
    const version = store.getVersion(versionId);
    if (!version) {
      reply.code(404).type('text/plain').send('unknown version');
      return;
    }

    const rest = parts.slice(2).join('/');
    if (rest.startsWith('node_modules/')) {
      const artwork = store.getArtwork(version.artworkId);
      const packageDir = resolve(config.repoRoot, artwork.packagePath);
      return serveFile({ reply, root: join(packageDir, 'node_modules'), relative: rest.slice('node_modules/'.length), frameAncestors });
    }

    const root = join(version.snapshotPath, 'files');
    return serveFile({ reply, root, relative: rest === '' ? 'index.html' : rest, frameAncestors });
  });

  async function serveFile({ reply, root, relative, frameAncestors }) {
    const target = normalize(join(resolve(root), relative));
    if (!isInside(root, target)) {
      reply.code(403).type('text/plain').send('forbidden');
      return;
    }
    let info;
    try {
      info = await stat(target);
    } catch {
      reply.code(404).type('text/plain').send('not found');
      return;
    }
    if (!info.isFile()) {
      reply.code(404).type('text/plain').send('not found');
      return;
    }
    const body = await readFile(target);
    const type = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
    const html = type.startsWith('text/html') ? body.toString('utf8') : null;
    reply
      .code(200)
      .type(type)
      .header('cache-control', 'no-store')
      .header('content-security-policy', policyFor({ html, frameAncestors, origin }))
      .header('x-content-type-options', 'nosniff')
      // The sandboxed embed runs in an opaque origin, so it needs this header to
      // read its own configuration files. The artwork bytes are not secret.
      .header('access-control-allow-origin', '*')
      .header('cross-origin-resource-policy', 'cross-origin')
      .send(body);
  }

  return {
    app,
    async listen() {
      await app.listen({ host: config.host, port: config.livePort });
      return `http://${config.host}:${config.livePort}`;
    },
    async close() {
      await app.close();
    },
  };
}
