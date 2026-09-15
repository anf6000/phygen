// ─────────────────────────────────────────────────────────────────────────────
// index.mjs — choose the capture backend, and report which one is active.
// ─────────────────────────────────────────────────────────────────────────────
import { createDockerCapture, detectDocker } from './docker.mjs';
import { CaptureError } from './browser.mjs';
import { createLocalCapture, detectBrowser } from './local.mjs';

export { CaptureError };

export async function createCapture({ config, logger = () => {} }) {
  const local = createLocalCapture({ config, logger });
  const docker = createDockerCapture({ config, logger });
  const requested = config.capture.backend;

  if (requested === 'docker') return { ...docker, isolated: true };
  if (requested === 'local') return { ...local, isolated: false };

  const dockerStatus = await detectDocker({ config });
  if (dockerStatus.available && dockerStatus.image) return { ...docker, isolated: true };
  return { ...local, isolated: false };
}

/** One status object for the health endpoint and the run pre-flight. */
export async function captureStatus({ config }) {
  const [docker, browser] = await Promise.all([detectDocker({ config }), detectBrowser({ channel: config.capture.browserChannel })]);
  const isolated = docker.available && Boolean(docker.image);
  const backend = config.capture.backend === 'docker' ? 'docker' : config.capture.backend === 'local' ? 'local' : isolated ? 'docker' : 'local';
  return {
    backend,
    isolated,
    available: backend === 'docker' ? isolated : browser.available,
    detail: backend === 'docker' ? docker.detail : browser.detail,
    docker,
    browser,
  };
}

export const SOURCE_MODES = Object.freeze(['config-only', 'isolated', 'sandboxed-browser', 'blocked']);

/**
 * Decide how a candidate that changes source code may run.
 *
 *   isolated          a container ran the candidate. Strongest boundary.
 *   sandboxed-browser the local artwork page ran the candidate. The page sits
 *                     on a separate credential-free origin with a strict
 *                     content policy, no network, and no host access. It is a
 *                     weaker boundary than a container, and every record says so.
 *   blocked           the run may not execute candidate source.
 *
 * A host that is not the loopback address is treated as a server, and a server
 * must not run candidate source without a container.
 */
export function decideSourceMode({ status, touchesSource, requireIsolation, localOnly = true }) {
  if (!touchesSource) return 'config-only';
  if (status.isolated) return 'isolated';
  if (requireIsolation) return 'blocked';
  if (!localOnly) return 'blocked';
  return 'sandboxed-browser';
}

export function isLocalHost(host) {
  return ['127.0.0.1', 'localhost', '::1', '0:0:0:0:0:0:0:1'].includes(String(host));
}

export function assertSourceMode({ mode, status, touchesSource, localOnly }) {
  if (mode !== 'blocked') return mode;
  throw new CaptureError(
    'isolation_required',
    localOnly
      ? 'This candidate changes source code. PHYGEN_REQUIRE_ISOLATION=1 is set, and no container backend is available.'
      : 'This candidate changes source code, and the server is reachable beyond the loopback address. Set PHYGEN_CAPTURE=docker with a built image, or bind to 127.0.0.1.',
    { touchesSource, backend: status.backend, detail: status.detail },
  );
}
