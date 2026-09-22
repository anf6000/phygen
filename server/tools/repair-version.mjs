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
//   node tools/repair-version.mjs --version <versionId> --kill-strobe
//     Copy the version, edit its display shader to stop the frame-to-frame
//     flashing, and keep the result as a NEW child step. No model runs.
//
// The tool builds the same runtime as the server, so the records it writes are
// the same records the server writes.
// ─────────────────────────────────────────────────────────────────────────────
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createRuntime } from '../src/index.mjs';
import { SETTLE_SHARE, injectSettle } from '../src/artwork/calm.mjs';

/**
 * The display made the frame flash: it chose the ink from the PARITY of the
 * posterisation level, so every time the trail crossed a level boundary a pixel
 * jumped between a dark ink and a bright one. The whole image flickered.
 *
 * This removes the parity term, so the quilt ink follows the smooth poster level
 * instead, and it softens the halftone dot edge, which popped on and off.
 * The engraved lines, the weave, and the palette stay exactly as they are.
 */
const STROBE_PATCHES = [
  {
    from: `    float ppar = mod(pfl, 2.0);
    col = mix(col, ramp(uPalette2, 0.34 + 0.6 * pq), ppar * uDot * 0.65);
    col = mix(col, ramp(uPalette, 0.97), (1.0 - ppar) * uDot * 0.28);`,
    to: `    col = mix(col, ramp(uPalette2, 0.34 + 0.6 * pq), uDot * 0.45);`,
  },
  {
    from: `    col *= mix(1.0, 0.40 + 0.60 * step(length(pc), prad), uDot);`,
    to: `    float pd = smoothstep(prad + 0.06, prad - 0.06, length(pc));
    col *= mix(1.0, 0.40 + 0.60 * pd, uDot);`,
  },
];

/**
 * The thick lines of the artwork hold still. The agents keep them, and every
 * agent moves, but the trail memory never moves, so the veins stay pinned to
 * one place. This adds one whole-field pass: the trail drifts a fraction of a
 * pixel per step along a direction that itself turns slowly, and the agents
 * follow their own trail, so the lines glide. The drift is deterministic from
 * the iteration count, so a capture stays repeatable.
 */
const DRIFT_METHOD = `  _driftField() {
    if (this.iteration === 0) {
      this.driftAccX = 0;
      this.driftAccY = 0;
    }
    const { W, H, trail } = this;
    const ang = this.iteration * 0.0007;
    const vx = Math.cos(ang) * 0.2;
    const vy = Math.sin(ang) * 0.2;
    this.driftAccX += vx;
    this.driftAccY += vy;
    const sx = Math.trunc(this.driftAccX);
    const sy = Math.trunc(this.driftAccY);
    if (sx === 0 && sy === 0) return;
    this.driftAccX -= sx;
    this.driftAccY -= sy;
    if (!this.driftBuf || this.driftBuf.length !== trail.length) {
      this.driftBuf = new Uint8Array(trail.length);
    }
    const wx = ((sx % W) + W) % W;
    const wy = ((sy % H) + H) % H;
    const buf = this.driftBuf;
    for (let y = 0; y < H; y++) {
      const srcRow = ((y + wy) % H) * W;
      const row = y * W;
      for (let x = 0; x < W; x++) {
        buf[row + x] = trail[srcRow + ((x + wx) % W)];
      }
    }
    trail.set(buf);
  }

`;

const DRIFT_CALL_ANCHOR = `    this.iteration++;
  }`;
const DRIFT_METHOD_ANCHOR = `  _prepare(F) {`;

function argument(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : null;
}

/**
 * The simulation rewrote most of its own trail every step, so the frame jumped
 * between steps. Thirty-nine mechanisms each run whole-field passes, and several
 * of them alternate with the parity of the step count, which swings the field
 * back and forth.
 *
 * This settles the trail towards what the mechanisms produced instead of jumping
 * to it: one step may move the trail only a share of the way. The artwork keeps
 * its structure and its mechanisms, and the frame stops flickering. Nothing in
 * the display changes, and the frame rate is untouched.
 */
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
const killStrobe = process.argv.includes('--kill-strobe');
const calmSteps = process.argv.includes('--calm-steps');
const driftLines = process.argv.includes('--drift-lines');

if (!versionId) {
  process.stderr.write('Usage: node tools/repair-version.mjs --version <versionId> [--capture-only | --refactor | --revive | --kill-strobe | --calm-steps | --drift-lines]\n');
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
  } else if (killStrobe) {
    logger('info', `Removing the flash from ${versionId} (${version.title})`);
    const result = await controller.applyEditVersion({
      versionId,
      title: 'Stop the frame flashing',
      apply: async ({ workspaceDir }) => {
        const file = join(workspaceDir, 'src', 'renderer.js');
        let source = await readFile(file, 'utf8');
        for (const patch of STROBE_PATCHES) {
          if (!source.includes(patch.from)) {
            // A silent miss would publish an unchanged shader and call it a fix.
            const error = new Error(`The shader does not hold the text this patch removes:\n${patch.from}`);
            error.code = 'patch_not_found';
            throw error;
          }
          source = source.replace(patch.from, patch.to);
        }
        await writeFile(file, source, 'utf8');
        logger('info', 'The display shader is patched: no parity flip, and a soft dot edge');
      },
    });
    if (result.ok) {
      logger('info', `The flash is removed: ${result.version.id} is step ${result.version.generation}, kept with a frame`);
    } else {
      logger('error', `The edit of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (calmSteps) {
    logger('info', `Calming the step change of ${versionId} (${version.title})`);
    const result = await controller.applyEditVersion({
      versionId,
      title: 'Settle the trail so the frame stops flickering',
      apply: async ({ workspaceDir }) => {
        const file = join(workspaceDir, 'src', 'physarum.js');
        const source = await readFile(file, 'utf8');
        const patched = injectSettle(source);
        if (!patched.injected) {
          const error = new Error(`The settle was not added: ${patched.reason}`);
          error.code = 'patch_not_found';
          throw error;
        }
        await writeFile(file, patched.source, 'utf8');
        logger('info', `The simulation now settles its trail, at a share of ${SETTLE_SHARE}`);
      },
    });
    if (result.ok) {
      logger('info', `The flicker fix is in: ${result.version.id} is step ${result.version.generation}, kept with a frame`);
    } else {
      logger('error', `The edit of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (driftLines) {
    logger('info', `Adding the slow trail drift to ${versionId} (${version.title})`);
    const result = await controller.applyEditVersion({
      versionId,
      title: 'Drift the trail slowly so the lines move',
      apply: async ({ workspaceDir }) => {
        const file = join(workspaceDir, 'src', 'physarum.js');
        let source = await readFile(file, 'utf8');
        if (source.includes('_driftField')) {
          const error = new Error('The drift is already in place');
          error.code = 'patch_not_found';
          throw error;
        }
        for (const [name, anchor] of [['call', DRIFT_CALL_ANCHOR], ['method', DRIFT_METHOD_ANCHOR]]) {
          if (!source.includes(anchor)) {
            const error = new Error(`The simulation does not hold the ${name} anchor:\n${anchor}`);
            error.code = 'patch_not_found';
            throw error;
          }
        }
        source = source.replace(DRIFT_CALL_ANCHOR, `    this._driftField();\n${DRIFT_CALL_ANCHOR}`);
        source = source.replace(DRIFT_METHOD_ANCHOR, `${DRIFT_METHOD}${DRIFT_METHOD_ANCHOR}`);
        await writeFile(file, source, 'utf8');
        logger('info', 'The trail now drifts a fraction of a pixel per step along a turning direction');
      },
    });
    if (result.ok) {
      logger('info', `The drift is in: ${result.version.id} is step ${result.version.generation}, kept with a frame`);
    } else {
      logger('error', `The drift edit of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
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
