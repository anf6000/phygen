// ─────────────────────────────────────────────────────────────────────────────
// repair-version.mjs — three operator actions on one version.
//
//   node tools/repair-version.mjs --version <versionId>
//     Repair a failed step: one repair session fixes the code of the failed
//     candidate, then the package is validated, published, captured, and kept.
//
//   node tools/repair-version.mjs --version <versionId> --capture-only
//     Capture one frame for a version that has none, for example the imported
//     root, so its card shows a real frame.
//
//   node tools/repair-version.mjs --version <versionId> --refactor
//     Refactor a kept version: the code changes shape, the artwork does not. A
//     frame is captured before and after, and the refactor is kept only when the
//     trail checksum is unchanged.
//
//   node tools/repair-version.mjs --version <versionId> --revive
//     Revive a version that a rule refused, after that rule was corrected. The
//     snapshot is captured again and the step is kept when the frame passes. No
//     session runs, so a revive costs nothing.
//
// The tool builds the same runtime as the server, so the records it writes are
// the same records the server writes.
// ─────────────────────────────────────────────────────────────────────────────
import { createRuntime } from '../src/index.mjs';

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

/** True when something already serves the artwork origin. */
async function liveOriginIsUp(host, port) {
  try {
    const response = await fetch(`http://${host}:${port}/`, { signal: AbortSignal.timeout(3000) });
    return response.status < 500;
  } catch {
    return false;
  }
}

const versionId = argument('version');
const captureOnly = process.argv.includes('--capture-only');
const refactor = process.argv.includes('--refactor');
const revive = process.argv.includes('--revive');

if (!versionId) {
  process.stderr.write('Usage: node tools/repair-version.mjs --version <versionId> [--capture-only | --refactor | --revive]\n');
  process.exit(1);
}

// A running server already serves the artwork origin, and two processes must
// not write the same database. Use the running one when it answers.
const probe = (await import('../src/config.mjs')).loadConfig();
const served = await liveOriginIsUp(probe.host, probe.livePort);

const runtime = await createRuntime({}, { withLive: !served, withApp: false });
const { controller, store, live, logger } = runtime;

try {
  const version = store.getVersion(versionId);
  if (!version) {
    logger('error', `No version ${versionId}`);
    process.exitCode = 1;
  } else if (captureOnly) {
    const captures = await controller.captureFrame({ versionId });
    logger('info', `Captured ${captures.length} frame(s) for ${versionId}`);
  } else if (refactor) {
    logger('info', `Refactoring ${versionId} (${version.title}, ${version.status})`);
    const result = await controller.refactorVersion({ versionId });
    if (result.ok) {
      logger('info', `Refactored ${versionId}: the image is unchanged (trail checksum ${result.after?.trailChecksum}), ${result.version.changes.length} file(s) changed`);
    } else {
      logger('error', `The refactor of ${versionId} was rejected: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (revive) {
    logger('info', `Reviving ${versionId} (${version.title}, refused with ${version.errorCode})`);
    const result = await controller.reviveVersion({ versionId });
    if (result.ok) logger('info', `Revived ${versionId}: the frame passes, so the step is kept`);
    else {
      logger('error', `The revive of ${versionId} was refused again: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else {
    logger('info', `Repairing ${versionId} (${version.title}, ${version.status}${version.errorCode ? `, ${version.errorCode}` : ''})`);
    const result = await controller.repairVersion({ versionId });
    if (result.ok) logger('info', `Repaired ${versionId}: ${result.version.status}, ${result.version.changes.length} file(s) changed`);
    else {
      logger('error', `The repair of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  }
} finally {
  await live?.close().catch(() => {});
  store.close();
}
