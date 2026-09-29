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

/**
 * The sharp-warm operator edit: the frame reads as a full rainbow with blurred
 * lines and an axial mirror. The palette window no longer wraps into green,
 * and the clashing rival image is gone, so the color stays inside the warm
 * window and follows the particle position. The trail keeps every deposit
 * (config.json decay 0). The diffusion smear and the display glow are off, so
 * the lines stay sharp. The mirror deposit is off, and the resonance field
 * carries a fixed tilt phase, so the picture is no longer axially symmetric.
 */
const SW_PALETTE_FROM = `  palette: 'inferno',`;
const SW_PALETTE_TO = `  palette: 'ember',`;
const SW_IMG_FROM = `      const img = hue[i] < 0.5 ? rivalImage : colorImage;`;
const SW_IMG_TO = `      const img = colorImage;`;
const SW_MAIN_FROM = `      const c = sampleColor(sp ? rivalImage : colorImage, COLOR_IMG, hu, hv, this._c);`;
const SW_MAIN_TO = `      const c = sampleColor(colorImage, COLOR_IMG, px / W, py / H, this._c);`;
const SW_TAIL_FROM = `      const tc = sampleColor(
        sp ? rivalImage : colorImage,
        COLOR_IMG,
        hu + hx * rib,
        hv + hy * rib,
        this._c,
      );`;
const SW_TAIL_TO = `      const tc = sampleColor(
        colorImage,
        COLOR_IMG,
        px / W + hx * rib * 0.08,
        py / H + hy * rib * 0.08,
        this._c,
      );`;
const SW_DIFFUSE_FROM = `const DIFFUSE = 0.18;`;
const SW_DIFFUSE_TO = `const DIFFUSE = 0;`;
const SW_MIRROR_FROM = `const MIRROR_BASE = 0.82;`;
const SW_MIRROR_TO = `const MIRROR_BASE = 0;`;
const SW_TILT_CONST_FROM = `const CYM_HUE = 0.24;`;
const SW_TILT_CONST_TO = `const CYM_HUE = 0.24;
const CYM_TILT = 0.7;`;
const SW_C1V_FROM = `      const c1v = Math.cos(CYM_M * Math.PI * vCym);`;
const SW_C1V_TO = `      const c1v = Math.cos(CYM_M * Math.PI * vCym + CYM_TILT);`;
const SW_S1V_FROM = `      const s1v = Math.sin(CYM_M * Math.PI * vCym);`;
const SW_S1V_TO = `      const s1v = Math.sin(CYM_M * Math.PI * vCym + CYM_TILT);`;
const SW_C2V_FROM = `      const c2v = Math.cos(CYM_N * Math.PI * vCym + cymPhi);`;
const SW_C2V_TO = `      const c2v = Math.cos(CYM_N * Math.PI * vCym + cymPhi + CYM_TILT);`;
const SW_S2V_FROM = `      const s2v = Math.sin(CYM_N * Math.PI * vCym + cymPhi);`;
const SW_S2V_TO = `      const s2v = Math.sin(CYM_N * Math.PI * vCym + cymPhi + CYM_TILT);`;
const SW_GLOW_FROM = `        uGlow: { value: 0.38 },`;
const SW_GLOW_TO = `        uGlow: { value: 0 },`;

/**
 * The single-ramp operator edit, for a source that --sharp-warm already
 * patched: half the particles still blend the rival color ramp into their
 * color, and that ramp opens the opposite half of the color wheel, so the
 * frame keeps its cool greens and blues. Every particle reads the one warm
 * ramp now.
 */
const SR_MAP_FROM = `      const map = sp ? this.rivalMap : this.colorMap;`;
const SR_MAP_TO = `      const map = this.colorMap;`;

/**
 * The hard-pixel operator edit: every particle becomes one hard pixel that is
 * 100 percent opaque. The brush stays 1x1, the rail offset and the second rail
 * are gone, and the streak leaves one tap at the particle position, so one
 * deposit lands on one pixel per step. The deposit weight is forced to 1, so
 * the pixel takes the particle color exactly, and the channel offsets are
 * zero, so the three channels land on the same pixel.
 */
const HP_RADIUS_FROM = `      radius[i] = grainT < HAIRLINE_MAX ? 0 : grainT < RIBBON_MIN ? 1 : 2;`;
const HP_RADIUS_TO = `      radius[i] = 0;`;
const HP_RESONANCE_FROM = `      if (resSmooth > 0.65 && radius[i] < 2) radius[i] = 2;`;
const HP_RESONANCE_TO = `      if (resSmooth > 0.65 && radius[i] < 2) radius[i] = 0;`;
const HP_SEP_FROM = `      const sep = rail[i] * (0.6 + 0.4 * Math.cos(cphase[i] + spinT * BRAID_SPIN));`;
const HP_SEP_TO = `      const sep = 0;`;
const HP_DXR_FROM = `      const dxr = Math.round(-ay * psp);`;
const HP_DXR_TO = `      const dxr = 0;`;
const HP_DYR_FROM = `      const dyr = Math.round(ax * psp);`;
const HP_DYR_TO = `      const dyr = 0;`;
const HP_RAIL_LOOP_FROM = `      for (let rl = 0; rl < 2; rl++) {`;
const HP_RAIL_LOOP_TO = `      for (let rl = 0; rl < 1; rl++) {`;
const HP_TAP_LOOP_FROM = `        for (let s = 0; s < STREAK_TAPS; s++) {`;
const HP_TAP_LOOP_TO = `        for (let s = 0; s < 1; s++) {`;
const HP_TAP_F_FROM = `          const f = s / (STREAK_TAPS - 1);`;
const HP_TAP_F_TO = `          const f = 0;`;
const HP_WEIGHT_FROM = `            const w = (brush ? brush[m] : 1) * strength;`;
const HP_WEIGHT_TO = `            const w = 1;`;

/**
 * The lean-step operator edit: with decay 0 and no diffusion the per-pixel
 * trail pass has nothing to do that the frame wants — its only effects are a
 * bilinear resample that softens lines and a decay that the configuration
 * already turned off. The pass runs a whole-field loop over every pixel every
 * step, and it is the largest single cost of a step. When diffusion is off
 * and decay is 0 the loop is skipped, so the step is faster and the trail
 * keeps every deposit exactly. A later step that raises decay or diffusion
 * brings the pass back on its own.
 */
const LS_LOOP_FROM = `      for (let y = 0; y < H; y++) {`;
const LS_LOOP_TO = `      if (DIFFUSE > 0 || this.decay > 0) for (let y = 0; y < H; y++) {`;

/**
 * The noise-color operator edit: the color map is one radial ramp with no
 * noise and no change over time. The color becomes a mix of colored value
 * noise at four scales, so the coarse octaves carry the broad color regions
 * and the fine octaves carry the texture. Every particle still reads its own
 * color from the map, and a bounded sine drift turns the hue slowly over time,
 * so the accumulated image shows the color history without a flicker.
 */
const NC_HELPERS_FROM = `function hsvToRgb(h, s, v, out) {`;
const NC_HELPERS_TO = `const HUE_SWING = 0.14;
const HUE_RATE = TAU / 1300;

function noiseAt(field, g, u, v) {
  const fx = u * g - 0.5;
  const fy = v * g - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const xa = ((x0 % g) + g) % g;
  const ya = ((y0 % g) + g) % g;
  const xb = (xa + 1) % g;
  const yb = (ya + 1) % g;
  const v00 = field[ya * g + xa];
  const v10 = field[ya * g + xb];
  const v01 = field[yb * g + xa];
  const v11 = field[yb * g + xb];
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

function clampByte(v) {
  const r = Math.round(v);
  return r < 0 ? 0 : r > 255 ? 255 : r;
}

function hsvToRgb(h, s, v, out) {`;
const NC_BUILD_FROM = `export function buildColorImage(rng, n, from, to, p1 = 0) {
  const img = new Uint8Array(n * n * 3);
  const rgb = [0, 0, 0];
  const cx = COLONY_UV[0] * n - 0.5;
  const cy = COLONY_UV[1] * n - 0.5;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const dx = x - cx;
      const dy = y - cy;
      let t = Math.sqrt(dx * dx + dy * dy) / (MAP_REACH * n);
      if (t > 1) t = 1;
      const hue = from + (to - from) * (1 - t);
      const sat = 0.88 - 0.2 * t;
      const val = 0.66 - 0.46 * t;
      hsvToRgb(hue, sat, val, rgb);
      const o = (y * n + x) * 3;
      img[o] = Math.round(rgb[0]);
      img[o + 1] = Math.round(rgb[1]);
      img[o + 2] = Math.round(rgb[2]);
    }
  }
  return img;
}`;
const NC_BUILD_TO = `export function buildColorImage(rng, n, from, to, p1 = 0) {
  const img = new Uint8Array(n * n * 3);
  const rgb = [0, 0, 0];
  const cx = COLONY_UV[0] * n - 0.5;
  const cy = COLONY_UV[1] * n - 0.5;
  const grids = [3, 7, 17, 41];
  const nrng = makeRng(Math.floor(p1 * 1000000007));
  const fields = grids.map((g) => {
    const f = new Float32Array(g * g);
    for (let i = 0; i < f.length; i++) f[i] = nrng();
    return f;
  });
  for (let y = 0; y < n; y++) {
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const a1 = noiseAt(fields[0], grids[0], u, v);
      const a2 = noiseAt(fields[1], grids[1], u, v);
      const a3 = noiseAt(fields[2], grids[2], u, v);
      const a4 = noiseAt(fields[3], grids[3], u, v);
      const mix = a1 * 0.5 + a2 * 0.28 + a3 * 0.15 + a4 * 0.07;
      const dx = x - cx;
      const dy = y - cy;
      let t = Math.sqrt(dx * dx + dy * dy) / (MAP_REACH * n);
      if (t > 1) t = 1;
      const hue = from + (to - from) * mix;
      const sat = 0.82 + 0.14 * (a3 - 0.5);
      const val = (0.4 + 0.6 * (a2 * 0.4 + a3 * 0.35 + a4 * 0.25)) * (1 - 0.55 * t);
      hsvToRgb(hue, sat, val, rgb);
      const o = (y * n + x) * 3;
      img[o] = Math.round(rgb[0]);
      img[o + 1] = Math.round(rgb[1]);
      img[o + 2] = Math.round(rgb[2]);
    }
  }
  return img;
}`;
const NC_MATRIX_FROM = `    const pace = this.speed ?? 1;`;
const NC_MATRIX_TO = `    const pace = this.speed ?? 1;
    const hshift = HUE_SWING * TAU * Math.sin(this.iteration * HUE_RATE);
    const hcos = Math.cos(hshift);
    const hsin = Math.sin(hshift);
    const m00 = 0.213 + hcos * 0.787 - hsin * 0.213;
    const m01 = 0.715 - hcos * 0.715 - hsin * 0.715;
    const m02 = 0.072 - hcos * 0.072 + hsin * 0.928;
    const m10 = 0.213 - hcos * 0.213 + hsin * 0.143;
    const m11 = 0.715 + hcos * 0.285 + hsin * 0.14;
    const m12 = 0.072 - hcos * 0.072 - hsin * 0.283;
    const m20 = 0.213 - hcos * 0.213 - hsin * 0.787;
    const m21 = 0.715 - hcos * 0.715 + hsin * 0.715;
    const m22 = 0.072 + hcos * 0.928 + hsin * 0.072;`;
const NC_COLOR_FROM = `      y[i] = (((y[i] + Math.sin(a) * pace) % H) + H) % H;

      sampleColor(colorImage, COLOR_IMG, x[i] / W, y[i] / H, this._c);
      cr[i] = Math.min(255, Math.round(this._c[0]));
      cg[i] = Math.min(255, Math.round(this._c[1]));
      cb[i] = Math.min(255, Math.round(this._c[2]));`;
const NC_COLOR_TO = `      y[i] = (((y[i] + Math.sin(a) * pace) % H) + H) % H;

      sampleColor(colorImage, COLOR_IMG, x[i] / W, y[i] / H, this._c);
      const c0 = this._c[0];
      const c1 = this._c[1];
      const c2 = this._c[2];
      cr[i] = clampByte(c0 * m00 + c1 * m01 + c2 * m02);
      cg[i] = clampByte(c0 * m10 + c1 * m11 + c2 * m12);
      cb[i] = clampByte(c0 * m20 + c1 * m21 + c2 * m22);`;

/**
 * The noise-color-rng operator edit, for a source that --noise-color already
 * patched with the shared random stream: the noise map reads the same stream
 * that places the particles, so the color change also moved the particles and
 * reshaped the composition. The map reads its own stream, derived from the
 * seed, so the particles keep their positions and only the color changes.
 */
const NC_RNG_FROM = `  const grids = [3, 7, 17, 41];
  const fields = grids.map((g) => {
    const f = new Float32Array(g * g);
    for (let i = 0; i < f.length; i++) f[i] = rng();
    return f;
  });`;
const NC_RNG_TO = `  const grids = [3, 7, 17, 41];
  const nrng = makeRng(Math.floor(p1 * 1000000007));
  const fields = grids.map((g) => {
    const f = new Float32Array(g * g);
    for (let i = 0; i < f.length; i++) f[i] = nrng();
    return f;
  });`;

/**
 * The hue-swing operator edit: the slow hue drift is wider than the color
 * window, so at the far end the hue wraps past yellow into olive-green and the
 * frame loses its color family. The swing value sets how far the drift turns,
 * so the palette stays inside the warm window.
 */
const HUE_SWING_PATTERN = /const HUE_SWING = [0-9.]+;/;

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
const sharpWarm = process.argv.includes('--sharp-warm');
const singleRamp = process.argv.includes('--single-ramp');
const hardPixel = process.argv.includes('--hard-pixel');
const leanStep = process.argv.includes('--lean-step');
const noiseColor = process.argv.includes('--noise-color');
const noiseColorRng = process.argv.includes('--noise-color-rng');
const hueSwingIndex = process.argv.indexOf('--hue-swing');
const hueSwing = hueSwingIndex >= 0 ? Number(process.argv[hueSwingIndex + 1]) : null;

if (!versionId) {
  process.stderr.write('Usage: node tools/repair-version.mjs --version <versionId> [--capture-only | --refactor | --revive | --kill-strobe | --calm-steps | --drift-lines | --fix-blend | --fix-aa | --remove-settle | --soften-clear <decay> | --calm-forces | --sharpen | --solo-sensing | --sense-lead | --unify-color | --align-channels | --sim-palette | --sharp-warm | --single-ramp | --hard-pixel | --lean-step | --noise-color | --noise-color-rng | --hue-swing <value>]\n');
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
  } else if (sharpWarm) {
    logger('info', `Warm color, sharp lines, and no mirror on ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: the color map window no longer wraps into green, and the clashing rival image is gone. Particles sample the color map at their position, so neighbors share a color. The trail keeps every deposit, because config.json decay is now 0. The diffusion smear and the display glow are off, so the lines stay sharp. The mirror deposit is off, and the resonance field carries a fixed tilt, so the picture is asymmetric.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        const simPatches = [
          ['palette default', SW_PALETTE_FROM, SW_PALETTE_TO],
          ['spawn image choice', SW_IMG_FROM, SW_IMG_TO],
          ['main color sample', SW_MAIN_FROM, SW_MAIN_TO],
          ['trail color sample', SW_TAIL_FROM, SW_TAIL_TO],
          ['diffusion', SW_DIFFUSE_FROM, SW_DIFFUSE_TO],
          ['mirror deposit', SW_MIRROR_FROM, SW_MIRROR_TO],
          ['tilt constant', SW_TILT_CONST_FROM, SW_TILT_CONST_TO],
          ['field cosine v', SW_C1V_FROM, SW_C1V_TO],
          ['field sine v', SW_S1V_FROM, SW_S1V_TO],
          ['second cosine v', SW_C2V_FROM, SW_C2V_TO],
          ['second sine v', SW_S2V_FROM, SW_S2V_TO],
        ];
        for (const [name, from, to] of simPatches) {
          if (!sim.includes(from)) {
            const error = new Error(`The ${name} does not hold the text this fix replaces:\n${from}`);
            error.code = 'patch_not_found';
            throw error;
          }
          sim = sim.replace(from, to);
        }
        await writeFile(simFile, sim, 'utf8');

        const rendererFile = join(workspaceDir, 'src', 'renderer.js');
        let renderer = await readFile(rendererFile, 'utf8');
        if (!renderer.includes(SW_GLOW_FROM)) {
          const error = new Error(`The display glow does not hold the text this fix replaces:\n${SW_GLOW_FROM}`);
          error.code = 'patch_not_found';
          throw error;
        }
        renderer = renderer.replace(SW_GLOW_FROM, SW_GLOW_TO);
        await writeFile(rendererFile, renderer, 'utf8');

        const configFile = join(workspaceDir, 'config.json');
        const config = JSON.parse(await readFile(configFile, 'utf8'));
        config.decay = 0;
        await writeFile(configFile, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
        logger('info', 'The color is warm and positional, the trail accumulates, the lines are sharp, and the mirror is off');
      },
    });
    if (result.ok) {
      logger('info', `The sharp-warm fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The sharp-warm fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (singleRamp) {
    logger('info', `Pointing every particle at the one warm ramp on ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: half the particles still blended the rival color ramp, which opens the opposite half of the color wheel, so the frame kept its cool greens and blues. Every particle reads the one warm ramp now.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        if (!sim.includes(SR_MAP_FROM)) {
          const error = new Error(`The map choice does not hold the text this fix replaces:\n${SR_MAP_FROM}`);
          error.code = 'patch_not_found';
          throw error;
        }
        sim = sim.replace(SR_MAP_FROM, SR_MAP_TO);
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'Every particle reads the one warm ramp now');
      },
    });
    if (result.ok) {
      logger('info', `The single-ramp fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The single-ramp fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (hardPixel) {
    logger('info', `Making every particle one hard opaque pixel on ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: every particle is now one hard pixel that is 100 percent opaque. The brush stays 1x1, the rail offset and the second rail are gone, and the streak leaves one tap at the particle position. The deposit weight is 1, so the pixel takes the particle color exactly, and the three channels land on the same pixel.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        for (const [name, from, to] of [
          ['brush radius', HP_RADIUS_FROM, HP_RADIUS_TO],
          ['resonance brush', HP_RESONANCE_FROM, HP_RESONANCE_TO],
          ['rail offset', HP_SEP_FROM, HP_SEP_TO],
          ['red channel offset', HP_DXR_FROM, HP_DXR_TO],
          ['channel y offset', HP_DYR_FROM, HP_DYR_TO],
          ['rail loop', HP_RAIL_LOOP_FROM, HP_RAIL_LOOP_TO],
          ['tap loop', HP_TAP_LOOP_FROM, HP_TAP_LOOP_TO],
          ['tap blend', HP_TAP_F_FROM, HP_TAP_F_TO],
          ['deposit weight', HP_WEIGHT_FROM, HP_WEIGHT_TO],
        ]) {
          if (!sim.includes(from)) {
            const error = new Error(`The ${name} does not hold the text this fix replaces:\n${from}`);
            error.code = 'patch_not_found';
            throw error;
          }
          sim = sim.replace(from, to);
        }
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'Every particle deposits one opaque pixel per step now');
      },
    });
    if (result.ok) {
      logger('info', `The hard-pixel fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The hard-pixel fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (leanStep) {
    logger('info', `Skipping the idle trail pass on ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: with decay 0 and no diffusion, the whole-field trail pass had no wanted effect — only a bilinear resample that softened lines and a decay the configuration already turned off. The pass is skipped when diffusion is off and decay is 0, so a step is faster and the trail keeps every deposit exactly.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        if (!sim.includes(LS_LOOP_FROM)) {
          const error = new Error(`The trail pass does not hold the text this fix replaces:\n${LS_LOOP_FROM}`);
          error.code = 'patch_not_found';
          throw error;
        }
        sim = sim.replace(LS_LOOP_FROM, LS_LOOP_TO);
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'The trail pass is skipped while diffusion is off and decay is 0');
      },
    });
    if (result.ok) {
      logger('info', `The lean-step fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The lean-step fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (noiseColor) {
    logger('info', `Mixing colored noise at several scales on ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: the color map was one radial ramp with no noise. The color is now a mix of colored value noise at four scales, so the coarse octaves carry the broad color regions and the fine octaves carry the texture. Every particle still reads its own color from the map, and a bounded sine drift turns the hue slowly over time, so the accumulated image shows the color history without a flicker.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        for (const [name, from, to] of [
          ['noise helpers', NC_HELPERS_FROM, NC_HELPERS_TO],
          ['color map', NC_BUILD_FROM, NC_BUILD_TO],
          ['hue matrix', NC_MATRIX_FROM, NC_MATRIX_TO],
          ['particle color', NC_COLOR_FROM, NC_COLOR_TO],
        ]) {
          if (!sim.includes(from)) {
            const error = new Error(`The ${name} does not hold the text this fix replaces:\n${from}`);
            error.code = 'patch_not_found';
            throw error;
          }
          sim = sim.replace(from, to);
        }
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'The color mixes four noise scales, and the hue drifts slowly over time');
      },
    });
    if (result.ok) {
      logger('info', `The noise-color fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The noise-color fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (noiseColorRng) {
    logger('info', `Giving the noise map its own random stream on ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: 'An operator fixed this step in place: the noise color map read the same random stream that places the particles, so the color change also moved the particles and reshaped the composition. The map reads its own stream, derived from the seed, so the particles keep their positions and only the color changes.',
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        if (!sim.includes(NC_RNG_FROM)) {
          const error = new Error(`The noise map does not hold the text this fix replaces:\n${NC_RNG_FROM}`);
          error.code = 'patch_not_found';
          throw error;
        }
        sim = sim.replace(NC_RNG_FROM, NC_RNG_TO);
        await writeFile(simFile, sim, 'utf8');
        logger('info', 'The noise map reads its own stream now');
      },
    });
    if (result.ok) {
      logger('info', `The noise-color-rng fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The noise-color-rng fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
      process.exitCode = 1;
    }
  } else if (hueSwing !== null) {
    if (!Number.isFinite(hueSwing) || hueSwing < 0 || hueSwing > 0.5) {
      console.error('--hue-swing needs a value between 0 and 0.5, in turns of the color wheel.');
      process.exit(1);
    }
    logger('info', `Setting the hue drift to ${hueSwing} turn on ${versionId} (${version.title}) in place`);
    const result = await controller.fixVersion({
      versionId,
      note: `An operator fixed this step in place: the slow hue drift turned ${hueSwing} of the color wheel, so the far end of the drift stayed inside the warm color window instead of wrapping past yellow into olive-green.`,
      apply: async ({ workspaceDir }) => {
        const simFile = join(workspaceDir, 'src', 'physarum.js');
        let sim = await readFile(simFile, 'utf8');
        if (!HUE_SWING_PATTERN.test(sim)) {
          const error = new Error('The hue drift constant is not in this source.');
          error.code = 'patch_not_found';
          throw error;
        }
        sim = sim.replace(HUE_SWING_PATTERN, `const HUE_SWING = ${hueSwing};`);
        await writeFile(simFile, sim, 'utf8');
        logger('info', `The hue drift turns ${hueSwing} of the wheel now`);
      },
    });
    if (result.ok) {
      logger('info', `The hue-swing fix is in: ${result.version.id} keeps its place at step ${result.version.generation} with a new frame`);
    } else {
      logger('error', `The hue-swing fix of ${versionId} failed: ${result.error?.code} ${result.error?.message}`);
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
