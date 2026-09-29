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
// offsets, the steering table, the wrap-around modulo, the 8-bit fade — is the
// same maths, in the same order, so a seeded run is reproducible.
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

/** Defaults = the literal constants of the p5 sketch. */
export const DEFAULTS = {
  // simulation (same names/units as the sketch)
  num: 4000, //            4000 molds
  sensorAngle: 45, //      this.sensorAngle
  sensorDist: 10, //       this.sensorDist
  rotAngle: 45, //         this.rotAngle
  decay: 6, //             background(0, decay) alpha, 0…255
  spawnRadius: 20, //      random(w/2 - 20, w/2 + 20)
  seed: 1337,
  palette: 'inferno',
  swirl: 0.8, //           tangential speed at the frame edge, px per step
};

/** Number of entries in the generated color map. */
const COLOR_BINS = 128;

/** Deposit weight per cell of a 3×3 brush: centre, edge, corner. */
const BRUSH = new Float32Array([0.4, 0.65, 0.4, 0.65, 1, 0.65, 0.4, 0.65, 0.4]);

const BRUSH5 = (() => {
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
})();

const FLOW_GRID = 24;
const WIND_TURN = 2.6;
const COLOR_DRIFT = 0.06;
const COLOR_IMG = 40;
const COLOR_LATTICE = 6;
const COLOR_BANDS = 5;
const VALUE_BANDS = 2;
const PIGMENT_GRID = 9;
const WEIGHT_FLOOR = 0.6;
const HAIRLINE_MAX = 0.4;
const RIBBON_MIN = 0.82;
const WELL_COUNT = 7;
const WELL_MIN = 0.12;
const WELL_MAX = 0.34;
const WELL_TURN = 4;
const WELL_PULL = 0.9;

/** Hue window (0…1 of the wheel) that each palette name opens. */
const HUE_WINDOWS = {
  white: [0, 1],
  bone: [0.06, 0.2],
  ice: [0.44, 0.68],
  ember: [0.86, 1.12],
  viridis: [0.24, 0.62],
  inferno: [0.74, 1.24],
  magma: [0.72, 1.06],
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
 * Generate a color map: `bins` saturated samples inside the hue window
 * [from, to], with three brightness bands across the map for contrast.
 * Every agent samples one entry, so the color is per particle.
 */
export function buildColorMap(bins, from, to) {
  const map = new Uint8Array(bins * 3);
  const rgb = [0, 0, 0];
  for (let i = 0; i < bins; i++) {
    const t = i / bins;
    const band = 0.5 + 0.5 * Math.cos(t * Math.PI * 6);
    const s = 0.92 + 0.08 * (1 - band);
    const v = 0.72 + 0.28 * band;
    hsvToRgb(from + (to - from) * t, s, v, rgb);
    map[i * 3] = Math.round(rgb[0]);
    map[i * 3 + 1] = Math.round(rgb[1]);
    map[i * 3 + 2] = Math.round(rgb[2]);
  }
  return map;
}

function hsvToRgb(h, s, v, out) {
  h = ((((h % 1) + 1) % 1) * 6);
  const c = v * s;
  const x = c * (1 - Math.abs((h % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 1) {
    r = c;
    g = x;
  } else if (h < 2) {
    r = x;
    g = c;
  } else if (h < 3) {
    g = c;
    b = x;
  } else if (h < 4) {
    g = x;
    b = c;
  } else if (h < 5) {
    r = x;
    b = c;
  } else {
    r = c;
    b = x;
  }
  out[0] = (r + m) * 255;
  out[1] = (g + m) * 255;
  out[2] = (b + m) * 255;
  return out;
}

function latticeAt(lat, off, g, u, v) {
  const fx = u * g;
  const fy = v * g;
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
  const v00 = lat[off + ya * g + xa];
  const v10 = lat[off + ya * g + xb];
  const v01 = lat[off + yb * g + xa];
  const v11 = lat[off + yb * g + xb];
  const a = v00 + (v10 - v00) * sx;
  const b = v01 + (v11 - v01) * sx;
  return a + (b - a) * sy;
}

function sampleColor(img, n, u, v, out) {
  const fx = u * n - 0.5;
  const fy = v * n - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const xa = ((x0 % n) + n) % n;
  const ya = ((y0 % n) + n) % n;
  const xb = (xa + 1) % n;
  const yb = (ya + 1) % n;
  const o00 = (ya * n + xa) * 3;
  const o10 = (ya * n + xb) * 3;
  const o01 = (yb * n + xa) * 3;
  const o11 = (yb * n + xb) * 3;
  for (let c = 0; c < 3; c++) {
    const a = img[o00 + c] + (img[o10 + c] - img[o00 + c]) * tx;
    const b = img[o01 + c] + (img[o11 + c] - img[o01 + c]) * tx;
    out[c] = a + (b - a) * ty;
  }
  return out;
}

export function buildColorImage(rng, n, from, to) {
  const g = COLOR_LATTICE;
  const lat = new Float32Array(g * g * 2);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  const img = new Uint8Array(n * n * 3);
  const rgb = [0, 0, 0];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const u = latticeAt(lat, 0, g, x / n, y / n);
      const v = latticeAt(lat, g * g, g, x / n, y / n);
      const hue = Math.min(COLOR_BANDS - 1, (u * COLOR_BANDS) | 0) / (COLOR_BANDS - 1);
      const step = Math.min(VALUE_BANDS - 1, (v * VALUE_BANDS) | 0) / (VALUE_BANDS - 1);
      hsvToRgb(from + (to - from) * hue, 0.98, 0.62 + 0.38 * step, rgb);
      const o = (y * n + x) * 3;
      img[o] = Math.round(rgb[0]);
      img[o + 1] = Math.round(rgb[1]);
      img[o + 2] = Math.round(rgb[2]);
    }
  }
  return img;
}

export function buildFlowField(rng, g = FLOW_GRID) {
  const lat = new Float32Array(g * g);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();
  return lat;
}

/**
 * Orbit wells: one seeded centre and one seeded orbit radius per colony.
 * A well steers its agents along a circle, so the colony grows as a ring.
 */
export function buildWells(rng, W, H, n) {
  const wells = new Float32Array(n * 3);
  const min = Math.min(W, H);
  const cx = W / 2;
  const cy = H / 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng() * 0.9;
    const r = min * (0.08 + 0.26 * rng());
    wells[i * 3] = cx + Math.cos(a) * r;
    wells[i * 3 + 1] = cy + Math.sin(a) * r;
    wells[i * 3 + 2] = min * (WELL_MIN + (WELL_MAX - WELL_MIN) * rng());
  }
  return wells;
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

    this.swirl = o.swirl;
    this.cx = this.W / 2;
    this.cy = this.H / 2;
    this.swirlK = this.swirl / (Math.min(this.W, this.H) * 0.5);
    const win = HUE_WINDOWS[o.palette] || HUE_WINDOWS.white;
    this.hueWindow = win;
    this.colorImage = buildColorImage(this.rng, COLOR_IMG, win[0], win[1]);
    this._c = new Float32Array(3);
    this.flow = buildFlowField(this.rng, FLOW_GRID);
    this.pigment = buildFlowField(this.rng, PIGMENT_GRID);
    this.wellCount = WELL_COUNT;
    this.wells = buildWells(this.rng, this.W, this.H, this.wellCount);
    this.hue = new Float32Array(this.num);
    this.weight = new Float32Array(this.num);
    this.radius = new Uint8Array(this.num);

    /** the trail map — replaces the p5 canvas pixels */
    this.trail = new Uint8Array(this.W * this.H * 4);

    this.x = new Float32Array(this.num);
    this.y = new Float32Array(this.num);
    this.heading = new Float32Array(this.num); // degrees
    this.cr = new Uint8Array(this.num);
    this.cg = new Uint8Array(this.num);
    this.cb = new Uint8Array(this.num);

    this.iteration = 0;
    this.spawn();
  }

  /** constructor(): random(w/2 - r, w/2 + r), random(360) */
  spawn() {
    const { W, H, num, rng, colorImage, hue, wells } = this;
    const jitter = this.spawnRadius;
    for (let i = 0; i < num; i++) {
      const wi = (i % this.wellCount) * 3;
      const a = rng() * TAU;
      const r = wells[wi + 2] * (0.85 + 0.3 * rng()) + (rng() * 2 - 1) * jitter;
      this.x[i] = (((wells[wi] + Math.cos(a) * r) % W) + W) % W;
      this.y[i] = (((wells[wi + 1] + Math.sin(a) * r) % H) + H) % H;
      this.heading[i] = rng() * 360;
    }
    for (let i = 0; i < num; i++) {
      hue[i] = rng();
      sampleColor(colorImage, COLOR_IMG, this.x[i] / W, this.y[i] / H, this._c);
      const bright = 0.8 + 0.25 * rng();
      this.cr[i] = Math.min(255, Math.round(this._c[0] * bright));
      this.cg[i] = Math.min(255, Math.round(this._c[1] * bright));
      this.cb[i] = Math.min(255, Math.round(this._c[2] * bright));
    }
  }

  /** clear the trail and respawn the agents (new RNG stream if seed given) */
  reset(opts = {}) {
    if (opts.seed !== undefined) {
      this.seed = opts.seed;
      this.rng = makeRng(opts.seed);
      this.flow = buildFlowField(this.rng, FLOW_GRID);
      this.pigment = buildFlowField(this.rng, PIGMENT_GRID);
      this.wells = buildWells(this.rng, this.W, this.H, this.wellCount);
      this.colorImage = buildColorImage(
        this.rng,
        COLOR_IMG,
        this.hueWindow[0],
        this.hueWindow[1],
      );
    }
    if (opts.num !== undefined) {
      this.num = Math.max(1, Math.round(opts.num));
      this.x = new Float32Array(this.num);
      this.y = new Float32Array(this.num);
      this.heading = new Float32Array(this.num);
      this.cr = new Uint8Array(this.num);
      this.cg = new Uint8Array(this.num);
      this.cb = new Uint8Array(this.num);
      this.hue = new Float32Array(this.num);
      this.weight = new Float32Array(this.num);
      this.radius = new Uint8Array(this.num);
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
    const next = new Uint8Array(W * H * 4);
    const cw = Math.min(W, this.W);
    const ch = Math.min(H, this.H);
    for (let y = 0; y < ch; y++) {
      next.set(this.trail.subarray(y * this.W * 4, (y * this.W + cw) * 4), y * W * 4);
    }
    const kx = W / this.W;
    const ky = H / this.H;
    const kr = Math.min(kx, ky);
    const wells = this.wells;
    for (let i = 0; i < wells.length; i += 3) {
      wells[i] *= kx;
      wells[i + 1] *= ky;
      wells[i + 2] *= kr;
    }
    this.trail = next;
    this.W = W;
    this.H = H;
    this.cx = W / 2;
    this.cy = H / 2;
    this.swirlK = this.swirl / (Math.min(W, H) * 0.5);
    for (let i = 0; i < this.num; i++) {
      this.x[i] = ((this.x[i] % W) + W) % W;
      this.y[i] = ((this.y[i] % H) + H) % H;
    }
    return true;
  }

  /** trail value at a pixel index (after p5's `%` wrap) */
  _at(px, py) {
    return this.trail[(py * this.W + px) * 4];
  }

  _field(lat, g, px, py) {
    return latticeAt(lat, 0, g, px / this.W, py / this.H);
  }

  _flow(px, py) {
    return this._field(this.flow, FLOW_GRID, px, py);
  }

  _pigment(px, py) {
    return this._field(this.pigment, PIGMENT_GRID, px, py);
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
    const o = ((sy | 0) * W + (sx | 0)) * 4;
    const r = this.trail[o];
    const g = this.trail[o + 1];
    const b = this.trail[o + 2];
    return r > g ? (r > b ? r : b) : g > b ? g : b;
  }

  /** one draw() of the sketch: fade, then every mold senses/steers/moves/deposits */
  step() {
    const { W, H, num, trail, x, y, heading, decayLUT, cr, cg, cb, hue, colorImage, wells } =
      this;
    const nWells = this.wellCount;
    const weight = this.weight;
    const radius = this.radius;
    const sensorAngle = this.sensorAngle;
    const rotAngle = this.rotAngle;
    const rng = this.rng;
    const k = this.swirlK;
    const cx = this.cx;
    const cy = this.cy;

    // ── background(0, decay) ────────────────────────────────────────────────
    if (this.decay > 0) {
      const n = trail.length;
      if (this.decay >= 255) {
        trail.fill(0);
      } else {
        for (let i = 0; i < n; i += 4) {
          trail[i] = decayLUT[trail[i]];
          trail[i + 1] = decayLUT[trail[i + 1]];
          trail[i + 2] = decayLUT[trail[i + 2]];
        }
      }
    }

    // ── pass 1: update() — move first, then sense, then steer ───────────────
    // (all sensors read the same post-fade / pre-deposit snapshot, exactly
    //  like p5's loadPixels() + `pixels[]`)
    for (let i = 0; i < num; i++) {
      let h = heading[i];
      const a = h * DEG2RAD;
      const dx = x[i] - cx;
      const dy = y[i] - cy;

      // this.vx = cos(heading); this.x = (x + vx + width) % width
      const px = (x[i] + Math.cos(a) - dy * k + W) % W;
      const py = (y[i] + Math.sin(a) + dx * k + H) % H;
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

      const w = this._flow(px, py);
      h += (w - 0.5) * WIND_TURN;

      const wi = (i % nWells) * 3;
      const ox = px - wells[wi];
      const oy = py - wells[wi + 1];
      const orbit = wells[wi + 2];
      const od = Math.sqrt(ox * ox + oy * oy) + 1e-3;
      let pull = (od - orbit) / orbit;
      pull = pull > 1 ? 1 : pull < -1 ? -1 : pull;
      const ux = ox / od;
      const uy = oy / od;
      const spin = hue[i] < 0.5 ? 1 : -1;
      const want =
        Math.atan2(ux * spin - uy * pull * WELL_PULL, -uy * spin - ux * pull * WELL_PULL) /
        DEG2RAD;
      let turn = want - h;
      if (turn > 180) turn -= 360;
      else if (turn < -180) turn += 360;
      h += turn > WELL_TURN ? WELL_TURN : turn < -WELL_TURN ? -WELL_TURN : turn;
      heading[i] = h;

      const g2 = this._pigment(px, py);
      radius[i] = g2 < HAIRLINE_MAX ? 0 : g2 < RIBBON_MIN ? 1 : 2;

      const c = sampleColor(colorImage, COLOR_IMG, px / W, py / H, this._c);
      const lum = Math.max(c[0], Math.max(c[1], c[2])) / 255;
      weight[i] = (WEIGHT_FLOOR + (1 - WEIGHT_FLOOR) * g2) * (0.72 + 0.28 * lum);

      const dim = (0.7 + 0.3 * g2) * (0.82 + 0.18 * hue[i]);
      cr[i] = Math.round(cr[i] + (c[0] * dim - cr[i]) * COLOR_DRIFT);
      cg[i] = Math.round(cg[i] + (c[1] * dim - cg[i]) * COLOR_DRIFT);
      cb[i] = Math.round(cb[i] + (c[2] * dim - cb[i]) * COLOR_DRIFT);
    }

    // ── pass 2: display() — deposit each agent's color through its own brush ─
    for (let i = 0; i < num; i++) {
      const px = x[i] | 0;
      const py = y[i] | 0;
      const r0 = cr[i];
      const g0 = cg[i];
      const b0 = cb[i];
      const rad = radius[i];
      const strength = weight[i];
      const side = rad === 0 ? 1 : rad === 1 ? 3 : 5;
      const brush = rad === 1 ? BRUSH : rad === 2 ? BRUSH5 : null;
      for (let m = 0; m < side * side; m++) {
        const w = (brush ? brush[m] : 1) * strength;
        const ox = (((px + (m % side) - rad) % W) + W) % W;
        const oy = (((py + ((m / side) | 0) - rad) % H) + H) % H;
        const o = (oy * W + ox) * 4;
        const inv = 1 - w;
        trail[o] = Math.min(255, (r0 * w + trail[o] * inv + 0.5) | 0);
        trail[o + 1] = Math.min(255, (g0 * w + trail[o + 1] * inv + 0.5) | 0);
        trail[o + 2] = Math.min(255, (b0 * w + trail[o + 2] * inv + 0.5) | 0);
      }
    }

    {
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
