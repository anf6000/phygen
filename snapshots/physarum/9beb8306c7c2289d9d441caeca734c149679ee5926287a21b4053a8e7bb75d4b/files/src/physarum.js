// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — faithful CPU port of the p5 sketch (../p5js/physarum.js).
//
// The reference sketch, ported line-for-line:
//
//   setup()   createCanvas(windowWidth, windowHeight); angleMode(DEGREES)
//             num = 4000 molds, spawned in a 40×40 px box at the canvas centre
//   draw()    background(0, 5)                       → fade the trail
//             loadPixels()                           → snapshot the trail
//             for each mold: update() ; display()    → sense snapshot, steer,
//                                                      move, deposit a white dot
//
// The p5 *canvas* (which doubled as the trail buffer) is replaced by a plain
// Uint8Array `trail`, and agents are held in typed arrays instead of 4000
// objects. The steering table, the wrap-around lookup of each trail tap and
// the 8-bit fade are the same maths, in the same order, so a seeded run is
// reproducible. A mould marks the pixel it leaves and the pixel it enters, so
// every path stays a continuous line that later moulds can sense.
//
// One p5 detail that is easy to get wrong is preserved here:
//
//  1. Agents move *before* they sense. update() integrates the position first
//     and only then calls getSensorPos(), so the sensors read from the new
//     position but the old heading.
// ─────────────────────────────────────────────────────────────────────────────

/** p5 angleMode(DEGREES) — every angle in this file is in degrees. */
export const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;

/** Defaults = the literal constants of the p5 sketch. */
export const DEFAULTS = {
  // simulation (same names/units as the sketch)
  num: 4000, //            4000 molds
  sensorAngle: 45, //      this.sensorAngle
  sensorDist: 10, //       this.sensorDist
  rotAngle: 45, //         this.rotAngle
  decay: 5, //             background(0, decay) alpha, 0…255
  spawnRadius: 20, //      random(w/2 - 20, w/2 + 20)
  seed: 1337,
};

/**
 * p5's `random()` is Math.random(); we want reproducible runs, so the sketch's
 * RNG is replaced by a seeded one. mulberry32 — small, fast, good enough.
 */
export function makeRng(seed = 0) {
  let a = (Math.floor(seed) || 0) >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An 8-bit "multiply by (1 - alpha/255)" table.
 * Equivalent to compositing rgba(0,0,0,alpha) over the trail once per frame,
 * i.e. p5's `background(0, decay)`.
 */
export function buildDecayLUT(alpha) {
  const a = Math.max(0, Math.min(255, Math.round(alpha)));
  const lut = new Uint8Array(256);
  const keep = (255 - a) / 255;
  for (let i = 0; i < 256; i++) lut[i] = Math.round(i * keep);
  return lut;
}

/**
 * The colony grows from three separate launch sites instead of one. Each site
 * leaves a short bar across its launch direction. Every mould on a bar shares
 * one narrow heading window. A site therefore leaves as one coherent front
 * and weaves its own lobe around it. Each lobe also pushes a tail into the
 * open ground between the sites. Where two tails meet, the moulds sense the
 * trail of the other site, turn onto it and merge. The union is a web of
 * three unequal lobes, joined by filaments, with large open cells between
 * them. A distributed mesh replaces the single hot knot of the parent. The
 * dominant lobe keeps the place of that knot, so the chain stays readable.
 * `weight` is the share of the moulds that starts in the patch. `x` and `y`
 * are the patch centre as a fraction of the trail. `angle` is the launch
 * direction in the sketch's degrees (0 = +x, y grows down). `spread` is the
 * half-width of the heading window. `along` and `across` are the half-axes of
 * the patch as a fraction of the larger trail dimension. `bias` is how much
 * the seed concentrates toward the middle of that patch.
 */
export const SEED_PATCHES = [
  { weight: 0.30, x: 0.27, y: 0.68, angle: -32, spread: 18, along: 0.009, across: 0.014, bias: 0.90 },
  { weight: 0.14, x: 0.31, y: 0.74, angle: -32, spread: 25, along: 0.009, across: 0.014, bias: 0.90 },
  { weight: 0.22, x: 0.72, y: 0.30, angle: 160, spread: 20, along: 0.008, across: 0.013, bias: 0.90 },
  { weight: 0.12, x: 0.69, y: 0.24, angle: 160, spread: 26, along: 0.008, across: 0.013, bias: 0.90 },
  { weight: 0.14, x: 0.70, y: 0.76, angle: 208, spread: 24, along: 0.007, across: 0.012, bias: 0.90 },
  { weight: 0.08, x: 0.75, y: 0.72, angle: 208, spread: 30, along: 0.007, across: 0.012, bias: 0.90 },
];

/**
 * Pace in trail pixels per step, and the per-mould variation of it. WANDER is
 * the seeded turn a mould takes when all three sensors read the same value, as
 * a fraction of rotAngle. PACE_OPEN is the extra pace a mould gains when the
 * forward sensor reads bare trail, so open ground is crossed faster than woven
 * ground and the colony migrates instead of knotting where it started.
 * DENSE_RELIEF is the share of that turn a mould gives up as the forward
 * sensor turns solid, so a woven trunk is crossed at a wide angle instead of
 * being circled, and the colony does not fold into one cord. TURN_SPREAD gives
 * every mould its own share of the turn, so one colony holds long straight
 * veins and fine curling twigs together and the network carries several scales
 * at once. EDGE_PAD is the quiet border, as a fraction of the smaller trail
 * dimension, where a mould reflects back into the trail. The border holds the
 * colony away from the frame edge, so the frame keeps a quiet margin.
 * WALL_KEEP scales how much of a grazing hit a mould keeps after it reflects.
 * The border therefore takes the sliding component away and no mould rides the
 * edge on a long rope.
 *
 * SENSE_REACH is the change of this step. A sensor reads a short ray of
 * SENSE_REACH.length 3×3 averages, spaced by these fractions of sensorDist,
 * instead of one point. A ray meets a vein that a point sample misses, so a
 * mould feels the colony from farther away, joins the nearest route and reuses
 * it. Reuse thickens the trunk. Only the thin frontier keeps enough contrast
 * to steer, so the tips stay fine and the branching happens there.
 */
export const PACE = { step: 1.05, spread: 0.20 };
export const WANDER = 0.38;
export const PACE_OPEN = 0.20;
export const DENSE_RELIEF = 0.85;
export const TURN_SPREAD = { low: 0.45, range: 1.25, curve: 1.7 };
export const EDGE_PAD = 0.10;
export const WALL_KEEP = 0.55;
export const SENSE_REACH = [0.55, 1.05, 1.7];

/** The inset reflection border for a trail of this size, in pixels. */
function edgePad(W, H) {
  const span = Math.min(W, H);
  return Math.max(0, Math.min(Math.round(EDGE_PAD * span), Math.floor(span / 2) - 1));
}

export class Physarum {
  constructor(opts = {}) {
    const o = { ...DEFAULTS, ...opts };

    this.W = Math.max(1, Math.round(o.width ?? 800));
    this.H = Math.max(1, Math.round(o.height ?? 600));
    this.num = Math.max(1, Math.round(o.num));

    this.sensorAngle = o.sensorAngle;
    this.sensorDist = o.sensorDist;
    this.rotAngle = o.rotAngle;
    this.decay = o.decay;
    this.spawnRadius = o.spawnRadius;
    this.seed = o.seed;

    this.rng = makeRng(o.seed);
    this.decayLUT = buildDecayLUT(o.decay);
    this.pad = edgePad(this.W, this.H);

    /** the trail map — replaces the p5 canvas pixels */
    this.trail = new Uint8Array(this.W * this.H);

    this.x = new Float32Array(this.num);
    this.y = new Float32Array(this.num);
    this.heading = new Float32Array(this.num); // degrees
    this.pacing = new Float32Array(this.num);
    this.paceGain = new Float32Array(this.num);
    this.turnScale = new Float32Array(this.num);

    this.iteration = 0;
    this.spawn();
  }

  spawn() {
    const { W, H, num, rng, spawnRadius } = this;
    const span = Math.max(W, H);
    const share = SEED_PATCHES.map((patch) => Math.round(patch.weight * num));
    let i = 0;
    for (let k = 0; k < SEED_PATCHES.length && i < num; k++) {
      const patch = SEED_PATCHES[k];
      const count = k === SEED_PATCHES.length - 1
        ? num - i
        : Math.max(0, Math.min(num - i, share[k]));
      if (count === 0) continue;
      const ca = Math.cos(patch.angle * DEG2RAD);
      const sa = Math.sin(patch.angle * DEG2RAD);
      const along = patch.along * span;
      const across = patch.across * span;
      const cx = W * patch.x;
      const cy = H * patch.y;
      for (let n = 0; n < count; n++) {
        const th = rng() * TAU;
        const r = Math.pow(rng(), patch.bias);
        const u = Math.cos(th) * r * along;
        const v = Math.sin(th) * r * across;
        const px = cx + u * ca - v * sa + (rng() * 2 - 1) * spawnRadius;
        const py = cy + u * sa + v * ca + (rng() * 2 - 1) * spawnRadius;
        this.x[i] = ((px % W) + W) % W;
        this.y[i] = ((py % H) + H) % H;
        this.heading[i] = patch.angle + (rng() * 2 - 1) * patch.spread;
        this.pacing[i] = 1 + (rng() * 2 - 1) * PACE.spread;
        this.turnScale[i] = TURN_SPREAD.low + TURN_SPREAD.range * Math.pow(rng(), TURN_SPREAD.curve);
        this.paceGain[i] = 1;
        i++;
      }
    }
  }

  /** clear the trail and respawn the agents (new RNG stream if seed given) */
  reset(opts = {}) {
    if (opts.seed !== undefined) {
      this.seed = opts.seed;
      this.rng = makeRng(opts.seed);
    }
    if (opts.num !== undefined) {
      this.num = Math.max(1, Math.round(opts.num));
      this.x = new Float32Array(this.num);
      this.y = new Float32Array(this.num);
      this.heading = new Float32Array(this.num);
      this.pacing = new Float32Array(this.num);
      this.paceGain = new Float32Array(this.num);
      this.turnScale = new Float32Array(this.num);
    }
    this.trail.fill(0);
    this.iteration = 0;
    this.spawn();
  }

  /** rebuild the trail map at a new size, keeping the overlapping region */
  resize(W, H) {
    W = Math.max(1, Math.round(W));
    H = Math.max(1, Math.round(H));
    if (W === this.W && H === this.H) return false;
    const next = new Uint8Array(W * H);
    const cw = Math.min(W, this.W);
    const ch = Math.min(H, this.H);
    for (let y = 0; y < ch; y++) {
      next.set(this.trail.subarray(y * this.W, y * this.W + cw), y * W);
    }
    this.trail = next;
    this.W = W;
    this.H = H;
    this.pad = edgePad(W, H);
    for (let i = 0; i < this.num; i++) {
      this.x[i] = ((this.x[i] % W) + W) % W;
      this.y[i] = ((this.y[i] % H) + H) % H;
    }
    return true;
  }

  /** one 3×3 average of `pixels[index]`, at a wrapped trail cell */
  _tap(sx, sy) {
    const W = this.W;
    const H = this.H;
    const t = this.trail;
    let ix = Math.floor(sx) % W;
    let iy = Math.floor(sy) % H;
    if (ix < 0) ix += W;
    if (iy < 0) iy += H;
    const xm = ix === 0 ? W - 1 : ix - 1;
    const xp = ix === W - 1 ? 0 : ix + 1;
    const rowM = (iy === 0 ? H - 1 : iy - 1) * W;
    const row0 = iy * W;
    const rowP = (iy === H - 1 ? 0 : iy + 1) * W;
    return (t[rowM + xm] + t[rowM + ix] + t[rowM + xp]
      + t[row0 + xm] + t[row0 + ix] + t[row0 + xp]
      + t[rowP + xm] + t[rowP + ix] + t[rowP + xp]) / 9;
  }

  /** getSensorPos() and a ray of 3×3 taps along it. Degrees in, 0…255 out. */
  _sense(px, py, deg, dist) {
    const a = deg * DEG2RAD;
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    let sum = 0;
    for (let k = 0; k < SENSE_REACH.length; k++) {
      const d = dist * SENSE_REACH[k];
      sum += this._tap(px + d * ca, py + d * sa);
    }
    return sum / SENSE_REACH.length;
  }

  /** one draw() of the sketch: fade, then every mold senses/steers/moves/deposits */
  step() {
    const { W, H, num, trail, x, y, heading, pacing, paceGain, turnScale, decayLUT } = this;
    const sensorAngle = this.sensorAngle;
    const rotAngle = this.rotAngle;
    const sensorDist = this.sensorDist;
    const wander = rotAngle * WANDER;
    const rng = this.rng;
    const pad = this.pad;
    const hiX = W - 1 - pad;
    const hiY = H - 1 - pad;

    // ── background(0, decay) ────────────────────────────────────────────────
    if (this.decay > 0) {
      const n = trail.length;
      if (this.decay >= 255) {
        trail.fill(0);
      } else {
        for (let i = 0; i < n; i++) trail[i] = decayLUT[trail[i]];
      }
    }

    // ── update() and display() in one pass: move, sense, steer, mark ────────
    for (let i = 0; i < num; i++) {
      let h = heading[i];
      const fromX = x[i] | 0;
      const fromY = y[i] | 0;
      const reach = sensorDist;

      const c = Math.cos(h * DEG2RAD);
      const s = Math.sin(h * DEG2RAD);
      const pace = pacing[i] * paceGain[i];
      let px = x[i] + c * pace;
      let py = y[i] + s * pace;
      let wallX = 0;
      let wallY = 0;
      if (px < pad) { px = pad + (pad - px); wallX = -1; }
      else if (px > hiX) { px = hiX - (px - hiX); wallX = 1; }
      if (py < pad) { py = pad + (pad - py); wallY = -1; }
      else if (py > hiY) { py = hiY - (py - hiY); wallY = 1; }
      if (px < 0) px = 0; else if (px > W - 1) px = W - 1;
      if (py < 0) py = 0; else if (py > H - 1) py = H - 1;

      x[i] = px;
      y[i] = py;

      // getSensorPos(r|f|l) — note the sensors are placed along the *old*
      // heading, from the *new* position
      const r = this._sense(px, py, h + sensorAngle, reach);
      const f = this._sense(px, py, h, reach);
      const l = this._sense(px, py, h - sensorAngle, reach);

      const relief = 1 - DENSE_RELIEF * (f / 255);
      const grip = rotAngle * relief * turnScale[i];

      // the sketch's steering table
      if (f > l && f > r) {
        // keep heading
      } else if (f < l && f < r) {
        h += rng() < 0.5 ? grip : -grip;
      } else if (l > r) {
        h -= grip;
      } else if (r > l) {
        h += grip;
      } else {
        const drift = wander * relief * turnScale[i];
        h += rng() < 0.5 ? drift : -drift;
      }

      if (wallX) h = 180 - h;
      if (wallY) h = -h;
      if (wallX || wallY) {
        const inward = wallX ? (wallX < 0 ? 0 : 180) : (wallY < 0 ? 90 : 270);
        let dev = (h - inward + 180) % 360;
        if (dev < 0) dev += 360;
        h = inward + (dev - 180) * WALL_KEEP;
      }
      heading[i] = h;

      paceGain[i] = 1 + PACE_OPEN * (1 - f / 255);

      const dx = px - fromX;
      const dy = py - fromY;
      const span = Math.abs(dx) > Math.abs(dy) ? Math.abs(dx) : Math.abs(dy);
      const marks = Math.max(1, Math.min(24, Math.round(span)));
      trail[fromY * W + fromX] = 255;
      for (let n = 1; n <= marks; n++) {
        const t = n / marks;
        trail[((fromY + dy * t) | 0) * W + ((fromX + dx * t) | 0)] = 255;
      }
    }

    this.iteration++;
  }

  /** cheap run signature (useful for tests / headless checks) */
  checksum() {
    const t = this.trail;
    let h = 2166136261;
    for (let i = 0; i < t.length; i += 7) {
      h ^= t[i];
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
}

/** the p5 sketch's numbers, for reference in the docs */
export const REFERENCE = { num: 4000, sensorAngle: 45, sensorDist: 10, rotAngle: 45, decay: 5 };
export { TAU };