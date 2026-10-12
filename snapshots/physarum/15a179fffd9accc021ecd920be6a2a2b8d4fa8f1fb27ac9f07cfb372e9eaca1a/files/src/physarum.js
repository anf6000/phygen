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
// objects. The sensor offsets and their wrap-around lookup, the steering table
// and the 8-bit fade are the same maths, in the same order, so a seeded run is
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
 * The colony is seeded loose across one broad patch in the lower left, so the
 * mesh is woven where the moulds start instead of at one point. `angle` is the
 * launch direction in the sketch's degrees (0 = +x, y grows down), `spread`
 * the half-width of the heading window, `along` and `across` the half-axes of
 * the patch as a fraction of the larger trail dimension, and `bias` how much
 * the seed concentrates toward the middle of that patch.
 */
export const SEED_PATCH = {
  x: 0.34,
  y: 0.66,
  angle: -36,
  spread: 32,
  along: 0.28,
  across: 0.13,
  bias: 1.25,
};

/**
 * Pace in trail pixels per step, and the per-mould variation of it. WANDER is
 * the seeded turn a mould takes when all three sensors read the same value, as
 * a fraction of rotAngle.
 */
export const PACE = { step: 1.05, spread: 0.10 };
export const WANDER = 0.30;

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

    /** the trail map — replaces the p5 canvas pixels */
    this.trail = new Uint8Array(this.W * this.H);

    this.x = new Float32Array(this.num);
    this.y = new Float32Array(this.num);
    this.heading = new Float32Array(this.num); // degrees
    this.pacing = new Float32Array(this.num);

    this.iteration = 0;
    this.spawn();
  }

  spawn() {
    const { W, H, num, rng, spawnRadius } = this;
    const span = Math.max(W, H);
    const patch = SEED_PATCH;
    const ca = Math.cos(patch.angle * DEG2RAD);
    const sa = Math.sin(patch.angle * DEG2RAD);
    const along = patch.along * span;
    const across = patch.across * span;
    const cx = W * patch.x;
    const cy = H * patch.y;
    for (let i = 0; i < num; i++) {
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
    for (let i = 0; i < this.num; i++) {
      this.x[i] = ((this.x[i] % W) + W) % W;
      this.y[i] = ((this.y[i] % H) + H) % H;
    }
    return true;
  }

  /** getSensorPos() + `pixels[index]` in one go. Degrees in, 0…255 out. */
  _sense(px, py, deg, dist) {
    const a = deg * DEG2RAD;
    const W = this.W;
    const H = this.H;
    const t = this.trail;
    let ix = Math.floor(px + dist * Math.cos(a)) % W;
    let iy = Math.floor(py + dist * Math.sin(a)) % H;
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

  /** one draw() of the sketch: fade, then every mold senses/steers/moves/deposits */
  step() {
    const { W, H, num, trail, x, y, heading, pacing, decayLUT } = this;
    const sensorAngle = this.sensorAngle;
    const rotAngle = this.rotAngle;
    const sensorDist = this.sensorDist;
    const wander = rotAngle * WANDER;
    const rng = this.rng;

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
      const grip = rotAngle;

      const c = Math.cos(h * DEG2RAD);
      const s = Math.sin(h * DEG2RAD);
      const pace = pacing[i];
      let px = x[i] + c * pace;
      let py = y[i] + s * pace;
      let hitX = false;
      let hitY = false;
      if (px < 0) { px += W; hitX = true; }
      else if (px >= W) { px -= W; hitX = true; }
      if (py < 0) { py += H; hitY = true; }
      else if (py >= H) { py -= H; hitY = true; }

      x[i] = px;
      y[i] = py;

      // getSensorPos(r|f|l) — note the sensors are placed along the *old*
      // heading, from the *new* position
      const r = this._sense(px, py, h + sensorAngle, reach);
      const f = this._sense(px, py, h, reach);
      const l = this._sense(px, py, h - sensorAngle, reach);

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
        h += rng() < 0.5 ? wander : -wander;
      }

      if (hitX) h = 180 - h;
      if (hitY) h = -h;
      heading[i] = h;

      trail[fromY * W + fromX] = 255;
      trail[(py | 0) * W + (px | 0)] = 255;
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