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
//   node tools/repair-version.mjs --version <versionId> --fix-blend
//     Fix a kept version IN PLACE: the trail accumulates (no fade per step) and
//     every deposit blends with the trail like normal alpha-over, instead of
//     the brightest-wins rule. The frame is captured again. No model runs.
//
//   node tools/repair-version.mjs --version <versionId> --fix-aa
//     Fix a kept version IN PLACE: the soft feathered brushes become hard
//     squares, so the strokes lose their anti-aliased edge. Sizes, streaks,
//     weights, and blending stay as they are. The frame is captured again.
//
//   node tools/repair-version.mjs --version <versionId> --remove-settle
//     Fix a kept version IN PLACE: remove the injected frame settle, so a step
//     moves its trail the whole way again. No model runs. Note: the step
//     pipeline adds the settle back into every child, so a later step carries
//     it again unless that behavior changes.
//
//   node tools/repair-version.mjs --version <versionId> --soften-clear <decay>
//     Fix a kept version IN PLACE: set config.json's decay to <decay> (0…255,
//     default 2). A smaller decay clears more softly, so trails stay longer.
//     The frame is captured again. No model runs.
//
//   node tools/repair-version.mjs --version <versionId> --calm-forces
//     Fix a kept version IN PLACE: halve the base motion (MOTION 0.55) and
//     clamp the net steering to MAX_TURN degrees per step (2.2), so strong
//     forces shape smooth arcs instead of whipping the agents into a jittery
//     blur. Wall steering and the scribe lock stay unclamped. The frame is
//     captured again. No model runs.
//
//   node tools/repair-version.mjs --version <versionId> --sharpen
//     Fix a kept version IN PLACE, after --calm-forces: relax the net steering
//     clamp to 5 degrees so the sensing loop can form a network again, and cut
//     the trail diffusion (DIFFUSE 0.34 to 0.06) that smears every line into a
//     blur. Pair it with --soften-clear for longer trails. No model runs.
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

/**
 * The soften-clear operator edit: config.json's decay is the clearing strength
 * of the fade pass. A smaller number clears more softly, so trails stay longer.
 */
function decayArgument() {
  const index = process.argv.indexOf('--soften-clear');
  if (index < 0) return null;
  const raw = process.argv[index + 1];
  const value = raw === undefined || raw.startsWith('--') ? 2 : Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    const error = new Error(`--soften-clear needs an integer decay from 0 to 255 (got ${raw})`);
    error.code = 'argument_invalid';
    throw error;
  }
  return value;
}

/**
 * The operator fix for the blend direction: the trail must accumulate instead
 * of fading, and a deposit must blend with the trail like normal alpha-over
 * instead of keeping only the brightest channel. The fade is switched off in
 * config.json (the schema names 0 as "keeps the trail"), and the deposit loop
 * takes the alpha-over form.
 */
const BLEND_DEPOSIT_FROM = `        const r = (r0 * w) | 0;
        const g = (g0 * w) | 0;
        const b = (b0 * w) | 0;
        if (trail[o] < r) trail[o] = r;
        if (trail[o + 1] < g) trail[o + 1] = g;
        if (trail[o + 2] < b) trail[o + 2] = b;`;
const BLEND_DEPOSIT_TO = `        const inv = 1 - w;
        trail[o] = Math.min(255, (r0 * w + trail[o] * inv + 0.5) | 0);
        trail[o + 1] = Math.min(255, (g0 * w + trail[o + 1] * inv + 0.5) | 0);
        trail[o + 2] = Math.min(255, (b0 * w + trail[o + 2] * inv + 0.5) | 0);`;

/**
 * The operator fix for anti-aliasing: the feathered brush weights are the soft
 * edge on every stroke. This replaces the 3×3 soft cross and the 5×5 Gaussian
 * with hard squares of the same size, so a stamp is solid inside its edge. The
 * per-agent strength and the streak taps stay as they are.
 */
const AA_BRUSH_DOC_FROM = `/** Deposit weight per cell of a 3×3 brush: centre, edge, corner. */`;
const AA_BRUSH_DOC_TO = `/** Deposit weight per cell of a hard-edged 3×3 brush. */`;
const AA_BRUSH_FROM = `const BRUSH = new Float32Array([0.4, 0.65, 0.4, 0.65, 1, 0.65, 0.4, 0.65, 0.4]);`;
const AA_BRUSH_TO = `const BRUSH = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]);`;
const AA_BRUSH5_FROM = `const BRUSH5 = (() => {
  const b = new Float32Array(25);
  let sum = 0;
  for (let j = -2; j <= 2; j++) {
    for (let k = -2; k <= 2; k++) {
      const v = Math.exp(-(k * k + j * j) / 2.4);
      b[(j + 2) * 5 + (k + 2)] = v;
      sum += v;
    }
  }
  const norm = 3.4 / sum;
  for (let i = 0; i < 25; i++) b[i] *= norm;
  return b;
})();`;
const AA_BRUSH5_TO = `const BRUSH5 = (() => {
  const b = new Float32Array(25);
  for (let i = 0; i < 25; i++) b[i] = 1;
  return b;
})();`;

/**
 * The operator fix for the injected frame settle: the block the calm system
 * adds makes every step move its trail only a share of the way. This removes
 * the whole block, so the trail takes each step's field directly. The anchor
 * runs through `this.iteration++`, so the removal also drops the blank line
 * that injectSettle leaves when the publish reformats the file.
 */
const SETTLE_BLOCK_FROM = `    {
      const settleTrail = this.trail;
      const settleN = settleTrail.length;
      let settlePrev = this.settlePrev;
      if (this.iteration === 0 || !settlePrev || settlePrev.length !== settleN) {
        this.settlePrev = new Uint8Array(settleN);
        this.settlePrev.set(settleTrail);
      } else {
        for (let settleI = 0; settleI < settleN; settleI++) {
          const settleWas = settlePrev[settleI];
          settleTrail[settleI] = (settleWas + (settleTrail[settleI] - settleWas) * 0.22 + 0.5) | 0;
        }
        settlePrev.set(settleTrail);
      }
    }
    this.iteration++;`;
const SETTLE_BLOCK_TO = `    this.iteration++;`;

/**
 * The calm-forces operator edit: many steering forces sum into one heading per
 * step, and each can contribute several degrees, so the agents whip around and
 * the frame reads as a jittery blur. Two bounds calm the motion without
 * removing any mechanism:
 *
 *   MOTION scales the base displacement (the pace stays, the step is shorter).
 *   MAX_TURN clamps the NET steering per step, after the wall bounce and before
 *   the wall margin and the scribe lock, so those two stay unclamped.
 */
const FORCE_CONSTS_FROM = `const BRUSH = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]);`;
const FORCE_CONSTS_TO = `${FORCE_CONSTS_FROM}
const MOTION = 0.55;
const MAX_TURN = 2.2;`;
const FORCE_PACE_FROM = `      let px = x[i] + Math.cos(a) * pace - dy * k;
      let py = y[i] + Math.sin(a) * pace + dx * k;`;
const FORCE_PACE_TO = `      let px = x[i] + Math.cos(a) * pace * MOTION - dy * k;
      let py = y[i] + Math.sin(a) * pace * MOTION + dx * k;`;
const FORCE_HBASE_FROM = `      if (py < 0 || py >= H) {
        py = py < 0 ? -py : H + H - py;
        py = py < 0 ? 0 : py >= H ? H - 1e-3 : py;
        h = -h;
      }`;
const FORCE_HBASE_TO = `${FORCE_HBASE_FROM}
      const hBase = h;`;
const FORCE_CLAMP_FROM = `      const wall = WALL_MARGIN * (W < H ? W : H);`;
const FORCE_CLAMP_TO = `      const turnNet = h - hBase;
      if (turnNet > MAX_TURN) h = hBase + MAX_TURN;
      else if (turnNet < -MAX_TURN) h = hBase - MAX_TURN;
      const wall = WALL_MARGIN * (W < H ? W : H);`;

/**
 * The sharpen operator edit, for a source that --calm-forces already patched:
 * the 2.2-degree clamp also throttles the sensing loop that forms the network,
 * and the diffusion pass smears every line into a blur. Relax the clamp, cut
 * the diffusion, and the trail keeps its lines.
 */
const SHARPEN_TURN_FROM = `const MAX_TURN = 2.2;`;
const SHARPEN_TURN_TO = `const MAX_TURN = 5;`;
const SHARPEN_DIFFUSE_FROM = `const DIFFUSE = 0.34;`;
const SHARPEN_DIFFUSE_TO = `const DIFFUSE = 0.06;`;

/**
 * The solo-sensing operator edit, for a source that --calm-forces patched:
 * dozens of steering fields each speak every step, so the trail-sensing loop
 * that forms the physarum network cannot dominate and the frame reads as
 * static. The steering splits in two: everything up to the wind (the sensing
 * loop, the currents, the crowd) is clamped to MAX_TURN from the step's start,
 * and every later field together may bend the heading only NOISE_TURN degrees
 * away from that. The network forms; the fields stay as gentle texture.
 */
const SOLO_NOISE_CONST_FROM = `const MAX_TURN = 5;`;
const SOLO_NOISE_CONST_TO = `const MAX_TURN = 5;
const NOISE_TURN = 2;`;
const SOLO_WIND_FROM = `      h += (w - 0.5) * WIND_TURN;`;
const SOLO_WIND_TO = `      h += (w - 0.5) * WIND_TURN;
      if (h - hBase > MAX_TURN) h = hBase + MAX_TURN;
      else if (h - hBase < -MAX_TURN) h = hBase - MAX_TURN;
      const hSensed = h;`;
const SOLO_NOISE_CLAMP_FROM = `      const turnNet = h - hBase;
      if (turnNet > MAX_TURN) h = hBase + MAX_TURN;
      else if (turnNet < -MAX_TURN) h = hBase - MAX_TURN;`;
const SOLO_NOISE_CLAMP_TO = `      const turnNet = h - hSensed;
      if (turnNet > NOISE_TURN) h = hSensed + NOISE_TURN;
      else if (turnNet < -NOISE_TURN) h = hSensed - NOISE_TURN;`;

/**
 * The sense-lead operator edit, for a source that --solo-sensing patched:
 * the 5-degree budget before the wind also throttles the trail-sensing table,
 * whose turn toward a trail is up to 36 degrees, so no network can form and
 * the frame stays a dim haze. The sensing section gets a real budget; the
 * later fields keep the 2-degree clamp. The deposit also stops splitting the
 * red, green and blue channels across three pixels, which turned every stroke
 * into colored speckle.
 */
const SENSE_TURN_FROM = `const MAX_TURN = 5;`;
const SENSE_TURN_TO = `const MAX_TURN = 30;`;
const SENSE_CHROMA_FROM = `const DISP_BLUE = 0.72;`;
const SENSE_CHROMA_TO = `const DISP_BLUE = 0;`;

/**
 * The unify-color operator edit: the frame reads as colored speckle because
 * each particle samples its color from an 18-term hue sum, half the particles
 * draw from a clashing rival image, and five provinces rotate every color
 * again. The color becomes spatial: one color image, sampled at the particle
 * position, with only a slight offset along the heading for the trail color.
 * Neighboring particles then share a color, and the structures read as
 * colored strokes instead of static.
 */
const UNIFY_IMG_FROM = `      const img = hue[i] < 0.5 ? rivalImage : colorImage;`;
const UNIFY_IMG_TO = `      const img = colorImage;`;
const UNIFY_ROT_SPAWN_FROM = `      this._hueRot(i, this._c);\n`;
const UNIFY_PLATE_FROM = `      const plateImg = (plateIdx & 1) === 0 ? colorImage : rivalImage;`;
const UNIFY_PLATE_TO = `      const plateImg = colorImage;`;
const UNIFY_MAIN_FROM = `      const c = sampleColor(plateImg, COLOR_IMG, hu, hv, this._c);
      this._hueRot(i, c);`;
const UNIFY_MAIN_TO = `      const c = sampleColor(plateImg, COLOR_IMG, px / W, py / H, this._c);`;
const UNIFY_TAIL_FROM = `      const tc = sampleColor(
        (plate[i] & 1) === 0 ? colorImage : rivalImage,
        COLOR_IMG,
        hu + hx * rib,
        hv + hy * rib,
        this._c,
      );
      this._hueRot(i, tc);`;
const UNIFY_TAIL_TO = `      const tc = sampleColor(
        plateImg,
        COLOR_IMG,
        px / W + hx * rib * 0.08,
        py / H + hy * rib * 0.08,
        this._c,
      );`;

/**
 * The align-channels operator edit, for a source that --unify-color patched:
 * the deposit paints the red channel on two rails up to 4 pixels away from
 * the green and blue channels. Dim deposits then leave green and blue dots
 * with no red, and the frame reads as colored static again. All three
 * channels land on the same pixel, so every stroke keeps its own color.
 */
const ALIGN_RAIL_FROM = `        const dxr = Math.round(-ay * psp);
        const dyr = Math.round(ax * psp);`;
const ALIGN_RAIL_TO = `        const dxr = 0;
        const dyr = 0;`;

/**
 * The sim-palette operator edit: the adapter builds the simulation without a
 * palette, so the simulation always runs its default inferno hue window. That
 * window ends past 1.0, and the part that wraps lands on green, which is why
 * green and violet speckle keeps appearing in the frame. The default becomes
 * ember, the palette the configuration and the display already use, so the
 * generated color map stays inside the warm window.
 */
const PALETTE_SIM_FROM = `  palette: 'inferno',`;
const PALETTE_SIM_TO = `  palette: 'ember',`;

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
const fixBlend = process.argv.includes('--fix-blend');
const fixAa = process.argv.includes('--fix-aa');
const removeSettle = process.argv.includes('--remove-settle');
const softenClear = process.argv.includes('--soften-clear');
const softenDecay = softenClear ? decayArgument() : null;
const calmForces = process.argv.includes('--calm-forces');
const sharpen = process.argv.includes('--sharpen');
const soloSensing = process.argv.includes('--solo-sensing');
const senseLead = process.argv.includes('--sense-lead');
const unifyColor = process.argv.includes('--unify-color');
const alignChannels = process.argv.includes('--align-channels');
const configPalette = process.argv.includes('--sim-palette');

if (!versionId) {
  process.stderr.write('Usage: node tools/repair-version.mjs --version <versionId> [--capture-only | --refactor | --revive | --kill-strobe | --calm-steps | --drift-lines | --fix-blend | --fix-aa | --remove-settle | --soften-clear <decay> | --calm-forces | --sharpen | --solo-sensing | --sense-lead | --unify-color | --align-channels | --sim-palette]\n');
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
  } else if (fixBlend) {
    logger('info', `Fixing the blend of ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: the trail accumulates (no fade per step), and every deposit blends with the trail like normal alpha-over.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        if (!sim.includes(BLEND_DEPOSIT_FROM)) {
          const error = new Error(`The deposit does not hold the text this fix replaces:\n${BLEND_DEPOSIT_FROM}`);
          error.code = 'patch_not_found';
          throw error;
        }
        sim = sim.replace(BLEND_DEPOSIT_FROM, BLEND_DEPOSIT_TO);
        await writeFile(simFile, sim, 'utf8');

        const configFile = join(workspaceDir, 'config.json');
        const config = JSON.parse(await readFile(configFile, 'utf8'));
        config.decay = 0;
        await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        logger('info', 'The trail now accumulates (decay 0), and a deposit blends like normal alpha-over');
      },
    });
    if (result.ok) {
      logger('info', `The blend fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The blend fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (fixAa) {
    logger('info', `Removing the soft brush edges of ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: the feathered 3×3 and 5×5 brushes became hard squares, so the strokes no longer carry an anti-aliased edge.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        for (const [name, from, to] of [
          ['brush note', AA_BRUSH_DOC_FROM, AA_BRUSH_DOC_TO],
          ['3×3 brush', AA_BRUSH_FROM, AA_BRUSH_TO],
          ['5×5 brush', AA_BRUSH5_FROM, AA_BRUSH5_TO],
        ]) {
          if (!sim.includes(from)) {
            const error = new Error(`The ${name} does not hold the text this fix replaces:\n${from}`);
            error.code = 'patch_not_found';
            throw error;
          }
          sim = sim.replace(from, to);
        }
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'The brushes are hard squares now: same sizes, no feathered edge');
      },
    });
    if (result.ok) {
      logger('info', `The anti-aliasing fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The anti-aliasing fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (removeSettle) {
    logger('info', `Removing the frame settle of ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: the injected frame settle is removed, so a step moves its trail the whole way again.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        if (!sim.includes(SETTLE_BLOCK_FROM)) {
          const error = new Error(`The step pipeline does not hold the settle block this fix removes:\n${SETTLE_BLOCK_FROM}`);
          error.code = 'patch_not_found';
          throw error;
        }
        sim = sim.replace(SETTLE_BLOCK_FROM, SETTLE_BLOCK_TO);
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'The settle block is gone: the trail now takes each step directly');
      },
    });
    if (result.ok) {
      logger('info', `The settle removal is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The settle removal of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (softenClear) {
    logger('info', `Softening the clearing of ${versionId} (${version.title}) to decay ${softenDecay}`);
    const result = await controller.fixVersion({
      versionId,
      note: `An operator fixed this step in place: the clearing is softer now (decay ${softenDecay}), so the trails stay longer.`,
      apply: async ({ workspaceDir }) => {
        const configFile = join(workspaceDir, 'config.json');
        const config = JSON.parse(await readFile(configFile, 'utf8'));
        config.decay = softenDecay;
        await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        logger('info', `The clearing now keeps ${Math.round((255 - softenDecay) / 255 * 10000) / 100}% of the trail per step`);
      },
    });
    if (result.ok) {
      logger('info', `The clearing fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The clearing fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (calmForces) {
    logger('info', `Calming the forces of ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: the base motion is scaled down (MOTION 0.55) and the net steering is clamped to 2.2 degrees per step, so the forces shape smooth arcs instead of a jittery blur.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        for (const [name, from, to] of [
          ['motion constants', FORCE_CONSTS_FROM, FORCE_CONSTS_TO],
          ['pace', FORCE_PACE_FROM, FORCE_PACE_TO],
          ['turn base', FORCE_HBASE_FROM, FORCE_HBASE_TO],
          ['turn clamp', FORCE_CLAMP_FROM, FORCE_CLAMP_TO],
        ]) {
          if (!sim.includes(from)) {
            const error = new Error(`The ${name} does not hold the text this fix replaces:\n${from}`);
            error.code = 'patch_not_found';
            throw error;
          }
          sim = sim.replace(from, to);
        }
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'The base motion is scaled by 0.55, and the net steering is clamped to 2.2 degrees per step');
      },
    });
    if (result.ok) {
      logger('info', `The calm-forces fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The calm-forces fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (sharpen) {
    logger('info', `Sharpening ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: the net steering clamp is relaxed to 5 degrees so the sensing loop can form a network, and the trail diffusion is cut from 0.34 to 0.06 so lines stay sharp.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        for (const [name, from, to] of [
          ['turn clamp', SHARPEN_TURN_FROM, SHARPEN_TURN_TO],
          ['diffusion', SHARPEN_DIFFUSE_FROM, SHARPEN_DIFFUSE_TO],
        ]) {
          if (!sim.includes(from)) {
            const error = new Error(`The ${name} does not hold the text this fix replaces:\n${from}`);
            error.code = 'patch_not_found';
            throw error;
          }
          sim = sim.replace(from, to);
        }
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'The steering clamp is 5 degrees now, and the diffusion is 0.06');
      },
    });
    if (result.ok) {
      logger('info', `The sharpen fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The sharpen fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (soloSensing) {
    logger('info', `Letting the sensing loop lead ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: the steering up to the wind is clamped to 5 degrees per step, and every later force field together may bend the heading only 2 degrees more, so the trail-sensing loop forms the network and the other fields stay as gentle texture.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        for (const [name, from, to] of [
          ['noise constant', SOLO_NOISE_CONST_FROM, SOLO_NOISE_CONST_TO],
          ['sensing clamp', SOLO_WIND_FROM, SOLO_WIND_TO],
          ['noise clamp', SOLO_NOISE_CLAMP_FROM, SOLO_NOISE_CLAMP_TO],
        ]) {
          if (!sim.includes(from)) {
            const error = new Error(`The ${name} does not hold the text this fix replaces:\n${from}`);
            error.code = 'patch_not_found';
            throw error;
          }
          sim = sim.replace(from, to);
        }
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'The sensing loop is clamped to 5 degrees, and the later fields to 2 degrees together');
      },
    });
    if (result.ok) {
      logger('info', `The solo-sensing fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The solo-sensing fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (senseLead) {
    logger('info', `Letting the sensing table lead ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: the steering up to the wind now has a 30 degree budget, so the sensing table can turn onto trails and weave the network. The later fields stay clamped to 2 degrees together. The deposit no longer splits the color channels across three pixels.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        for (const [name, from, to] of [
          ['sensing budget', SENSE_TURN_FROM, SENSE_TURN_TO],
          ['channel split', SENSE_CHROMA_FROM, SENSE_CHROMA_TO],
        ]) {
          if (!sim.includes(from)) {
            const error = new Error(`The ${name} does not hold the text this fix replaces:\n${from}`);
            error.code = 'patch_not_found';
            throw error;
          }
          sim = sim.replace(from, to);
        }
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'The sensing section turns up to 30 degrees, and the channels deposit on one pixel');
      },
    });
    if (result.ok) {
      logger('info', `The sense-lead fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The sense-lead fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (unifyColor) {
    logger('info', `Anchoring the color to position on ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: every particle samples its color from one generated color image at its position. The province color rotations are gone, and the clashing rival image is gone. The trail color follows the heading only slightly. Neighboring particles now share a color.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        const single = [
          ['spawn image choice', UNIFY_IMG_FROM, UNIFY_IMG_TO],
          ['plate image choice', UNIFY_PLATE_FROM, UNIFY_PLATE_TO],
          ['main color sample', UNIFY_MAIN_FROM, UNIFY_MAIN_TO],
          ['trail color sample', UNIFY_TAIL_FROM, UNIFY_TAIL_TO],
        ];
        for (const [name, from, to] of single) {
          if (!sim.includes(from)) {
            const error = new Error(`The ${name} does not hold the text this fix replaces:\n${from}`);
            error.code = 'patch_not_found';
            throw error;
          }
          sim = sim.replace(from, to);
        }
        while (sim.includes(UNIFY_ROT_SPAWN_FROM)) sim = sim.replace(UNIFY_ROT_SPAWN_FROM, '');
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'The color comes from one image at the particle position now');
      },
    });
    if (result.ok) {
      logger('info', `The unify-color fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The unify-color fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (alignChannels) {
    logger('info', `Aligning the deposit channels on ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: the deposit paints the red channel on rails up to 4 pixels away from the green and blue channels, and dim deposits leave green and blue dots with no red. All three channels land on the same pixel now.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        for (const [name, from, to] of [
          ['rail offset', ALIGN_RAIL_FROM, ALIGN_RAIL_TO],
        ]) {
          if (!sim.includes(from)) {
            const error = new Error(`The ${name} does not hold the text this fix replaces:\n${from}`);
            error.code = 'patch_not_found';
            throw error;
          }
          sim = sim.replace(from, to);
        }
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'The three channels deposit on the same pixel now');
      },
    });
    if (result.ok) {
      logger('info', `The align-channels fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The align-channels fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (configPalette) {
    logger('info', `Pointing the simulation palette at the configured window on ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: the adapter builds the simulation without a palette, so the simulation always ran the default inferno hue window whose last band wraps past red into green. The simulation default is now ember, the palette the configuration and the display already use, so the generated color map stays inside the warm window.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        if (!sim.includes(PALETTE_SIM_FROM)) {
          const error = new Error(`The palette default does not hold the text this fix replaces:\n${PALETTE_SIM_FROM}`);
          error.code = 'patch_not_found';
          throw error;
        }
        sim = sim.replace(PALETTE_SIM_FROM, PALETTE_SIM_TO);
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'The simulation color map uses the ember window now');
      },
    });
    if (result.ok) {
      logger('info', `The sim-palette fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The sim-palette fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
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
