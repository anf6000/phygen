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
// The only structural change is that the p5 *canvas* (which doubled as the
// trail buffer) is replaced by a plain Uint8Array `trail`, and agents are held
// in typed arrays instead of 4000 objects. Everything else — the sensor
// offsets and their wrap-around lookup, the steering table, the 8-bit fade —
// is the same maths, in the same order, so a seeded run is reproducible.
//
// Two p5 details that are easy to get wrong and are preserved here:
//
//  1. `pixels` is a *snapshot* taken after the fade and before any mold is
//     drawn. Deposits made during a frame are therefore not visible to other
//     molds until the next frame. step() reproduces this with a two-pass loop
//     (sense/steer/move for everyone, then deposit for everyone).
//  2. Agents move *before* they sense. update() integrates the position first
//     and only then calls getSensorPos(), so the sensors read from the new
//     position but the old heading.
// ─────────────────────────────────────────────────────────────────────────────

/** p5 angleMode(DEGREES) — every angle in this file is in degrees. */
export const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;

/** per-step fade of the transient seed field */
const SOIL_FADE = 0.9765;

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

    this.sourceDepth = Math.max(1, 2 * this.spawnRadius);
    this.spread = 45;
    this.soil = null;
    this.soilAmp = 0;

    this.rng = makeRng(o.seed);
    this.decayLUT = buildDecayLUT(o.decay);

    /** the trail map — replaces the p5 canvas pixels */
    this.trail = new Uint8Array(this.W * this.H);

    this.x = new Float32Array(this.num);
    this.y = new Float32Array(this.num);
    this.heading = new Float32Array(this.num); // degrees

    this.iteration = 0;
    this.spawn();
  }

  /** source band: 2*spawnRadius wide at the left edge, headings inside the cone */
  spawn() {
    const { W, H, num, rng } = this;
    const depth = Math.max(1, Math.min(this.sourceDepth, W));
    for (let i = 0; i < num; i++) {
      this.x[i] = rng() * depth;
      this.y[i] = rng() * H;
      this.heading[i] = (rng() * 2 - 1) * this.spread;
    }
    this.seedSoil();
  }

  /**
   * A weak low-frequency field, sampled by the sensors before the first
   * deposits exist. It fades out over a few hundred steps and is never
   * re-applied; after that the trail alone steers the molds.
   */
  seedSoil() {
    const { W, H, rng } = this;
    const spec = [
      [48, 34],
      [17, 16],
    ];
    const octaves = [];
    for (let k = 0; k < spec.length; k++) {
      const cell = spec[k][0];
      const gw = Math.ceil(W / cell) + 2;
      const gh = Math.ceil(H / cell) + 2;
      const data = new Float32Array(gw * gh);
      for (let i = 0; i < data.length; i++) data[i] = rng() * 2 - 1;
      octaves.push({ cell, gw, gh, data, amp: spec[k][1] });
    }
    this.soil = octaves;
    this.soilAmp = 1;
  }

  /** bilinear sample of the seed field, in trail units */
  _soilAt(xi, yi) {
    const octaves = this.soil;
    let sum = 0;
    for (let k = 0; k < octaves.length; k++) {
      const o = octaves[k];
      const gx = Math.min(xi / o.cell, o.gw - 2.001);
      const gy = Math.min(yi / o.cell, o.gh - 2.001);
      const x0 = gx | 0;
      const y0 = gy | 0;
      const tx = gx - x0;
      const ty = gy - y0;
      const r0 = y0 * o.gw + x0;
      const r1 = r0 + o.gw;
      const d = o.data;
      sum +=
        ((d[r0] * (1 - tx) + d[r0 + 1] * tx) * (1 - ty) +
          (d[r1] * (1 - tx) + d[r1 + 1] * tx) * ty) * o.amp;
    }
    return sum * this.soilAmp;
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

  /** trail value at a pixel index (after p5's `%` wrap) */
  _at(px, py) {
    return this.trail[py * this.W + px];
  }

  /** getSensorPos() + `pixels[index]` in one go. Degrees in, 0…255 out. */
  _sense(px, py, deg) {
    const a = deg * DEG2RAD;
    const W = this.W;
    const H = this.H;
    let sx = (px + this.sensorDist * Math.cos(a) + W) % W;
    let sy = (py + this.sensorDist * Math.sin(a) + H) % H;
    if (sx < 0) sx += W; // (only reachable when W < sensorDist)
    if (sy < 0) sy += H;
    const xi = sx | 0;
    const yi = sy | 0;
    const base = this.trail[yi * W + xi];
    if (this.soilAmp <= 0) return base;
    const v = base + this._soilAt(xi, yi);
    return v > 255 ? 255 : v;
  }

  /** one draw() of the sketch: fade, then every mold senses/steers/moves/deposits */
  step() {
    const { W, H, num, trail, x, y, heading, decayLUT } = this;
    const sensorAngle = this.sensorAngle;
    const rotAngle = this.rotAngle;
    const rng = this.rng;
    const depth = Math.min(this.sourceDepth, W);
    const spread = this.spread;

    if (this.soilAmp > 0) {
      this.soilAmp *= SOIL_FADE;
      if (this.soilAmp < 0.02) this.soilAmp = 0;
    }

    // ── background(0, decay) ────────────────────────────────────────────────
    if (this.decay > 0) {
      const n = trail.length;
      if (this.decay >= 255) {
        trail.fill(0);
      } else {
        for (let i = 0; i < n; i++) trail[i] = decayLUT[trail[i]];
      }
    }

    // ── pass 1: update() — move first, then sense, then steer ───────────────
    // (all sensors read the same post-fade / pre-deposit snapshot, exactly
    //  like p5's loadPixels() + `pixels[]`)
    for (let i = 0; i < num; i++) {
      let h = heading[i];

      // this.vx = cos(heading); this.x = x + vx
      const vx = Math.cos(h * DEG2RAD);
      const vy = Math.sin(h * DEG2RAD);
      const px = x[i] + vx;
      const py = y[i] + vy;

      // an agent that leaves the frame re-enters at the source band, so the
      // colony feeds its own growth front instead of raking the frame in
      // straight lines
      if (px < 0 || px >= W || py < 0 || py >= H) {
        x[i] = rng() * depth;
        y[i] = rng() * H;
        heading[i] = (rng() * 2 - 1) * spread;
        continue;
      }

      x[i] = px;
      y[i] = py;

      // getSensorPos(r|f|l) — note the sensors are placed along the *old*
      // heading, from the *new* position
      const r = this._sense(px, py, h + sensorAngle);
      const f = this._sense(px, py, h);
      const l = this._sense(px, py, h - sensorAngle);

      // the sketch's steering table, verbatim
      if (f > l && f > r) {
        // keep heading
      } else if (f < l && f < r) {
        h += rng() < 0.5 ? rotAngle : -rotAngle;
      } else if (l > r) {
        h -= rotAngle;
      } else if (r > l) {
        h += rotAngle;
      }
      heading[i] = h;
    }

    // ── pass 2: display() — fill(255); ellipse(x, y, 1, 1) ─────────────────
    for (let i = 0; i < num; i++) {
      trail[(y[i] | 0) * W + (x[i] | 0)] = 255;
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
