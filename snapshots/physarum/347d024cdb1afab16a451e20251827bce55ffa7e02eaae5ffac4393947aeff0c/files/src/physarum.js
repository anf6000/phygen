// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — compact physarum core: one sluice.
//
// The colony spawns in a narrow pad at the top left and drains down one
// braided fall toward an elbow low on the left, then runs right along one
// channel near the bottom edge and leaves the frame. There is no terminal
// pool: traffic circulates, an agent that exits any edge respawns in the pad.
// An agent that sees no trail keeps its own seeded meander: a slow sinusoidal
// sway, rate-limited toward the elbow while it is above the elbow line, and
// toward the channel exit once below it. When trail enters the sensor cone,
// the sensor ladder takes control: hold when forward reads strongest, turn
// toward the stronger side ray, and take one seeded side when both side rays
// beat forward. The guide acts only when all three readings are zero, so
// equal readings inside a channel hold the heading and the network keeps
// itself. The fall merges falling strands into a woven trunk, the elbow
// knots the traffic into the densest seam, and escape at a gap returns the
// strand to its sway.
//
// The sense scale runs with the fall. Near the pad, short sensors, wide cones
// and large turns weave fine crossing feeders. Lower down, long sensors and
// small turns lock strands together, so the weave condenses into fewer,
// thicker arteries that feed the run while the piece runs. The trail is the
// only shared memory. Its color bytes carry the display and its alpha byte
// carries path reuse: each visit adds a compressed step. Agents sense that
// reuse ahead and on both side rays, turn toward the strongest reading, move,
// and deposit one full-opacity pixel. Zero decay keeps every deposit: the pad
// and the elbow saturate, the trunk and the run carry the traffic, and the
// right field, the left margin and the bottom corners stay quiet.
//
// Particle color comes from a generated noise map in the ember family, a
// rose-red-to-vermilion span sampled at the deposit position. The renderer
// lifts the reuse stored in the alpha byte toward one pale gold accent, so
// the elbow and the thickest arteries read pale and warm while fresh feeder
// fiber stays dark.
// ─────────────────────────────────────────────────────────────────────────────

export const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;

export const DEFAULTS = {
  num: 800,
  sensorAngle: 24,
  sensorDist: 22,
  rotAngle: 26,
  decay: 0,
  spawnRadius: 40,
  seed: 1337,
  palette: 'ember',
  speed: 2,
};

export const REFERENCE = { num: 4000, sensorAngle: 45, sensorDist: 10, rotAngle: 45, decay: 5 };

const HEAD_SPREAD = 26;
const DOWN_HEADING = 90;
const SRC_X = 0.28;
const SRC_HALF = 0.05;
const SRC_TOP = 0.012;
const ELB_X = 0.28;
const ELB_Y = 0.74;
const RUN_Y = 0.85;
const EXIT_X = 1.07;
const GD_RATE = 1.4;
const MW_FREQ = 0.01;
const MW_FREQ_RANGE = 0.024;
const MW_AMP = 0.08;
const MW_AMP_RANGE = 0.14;
const ANGLE_MAX = 55;
const SD_NEAR = 0.55;
const SD_FAR = 1.35;
const SA_NEAR = 1.5;
const SA_FAR = 0.85;
const SR_NEAR = 1.7;
const SR_FAR = 0.55;

const COLOR_IMG = 56;

const HUE_WINDOWS = {
  white: [0, 1],
  ice: [0.46, 0.58],
  bone: [0.05, 0.13],
  ember: [0.9, 1.1],
  viridis: [0.44, 0.31],
  inferno: [0.72, 0.97],
  magma: [0.72, 1.06],
  indigo: [0.58, 0.76],
  lagoon: [0.45, 0.55],
};

export function makeRng(seed = 0) {
  let a = (Math.floor(seed) || 0) >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildDecayLUT(alpha) {
  const a = Math.max(0, Math.min(255, Math.round(alpha)));
  const lut = new Uint8Array(256);
  const keep = (255 - a) / 255;
  for (let i = 0; i < 256; i++) lut[i] = Math.round(i * keep);
  return lut;
}

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

export function buildColorImage(rng, n, from, to, p1 = 0) {
  const img = new Uint8Array(n * n * 3);
  const rgb = [0, 0, 0];
  const grids = [2, 3, 5, 9];
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
      const mix = a1 * 0.55 + a2 * 0.25 + a3 * 0.13 + a4 * 0.07;
      const hue = from + (to - from) * mix;
      const sat = 0.42 + 0.26 * a3;
      const val = 0.2 + 0.26 * (a2 * 0.4 + a3 * 0.35 + a4 * 0.25);
      hsvToRgb(hue, sat, val, rgb);
      const o = (y * n + x) * 3;
      img[o] = Math.round(rgb[0]);
      img[o + 1] = Math.round(rgb[1]);
      img[o + 2] = Math.round(rgb[2]);
    }
  }
  return img;
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
    this.decayLUT = buildDecayLUT(o.decay);
    this.speed = o.speed;
    this.palette = o.palette;
    this.spawnRadius = Math.max(1, o.spawnRadius ?? DEFAULTS.spawnRadius);

    this._c = new Float32Array(3);
    this._reseed(o.seed);

    this.trail = new Uint8Array(this.W * this.H * 4);

    this.x = new Float32Array(this.num);
    this.y = new Float32Array(this.num);
    this.heading = new Float32Array(this.num);
    this.bend = new Float32Array(this.num);
    this.wPhase = new Float32Array(this.num);
    this.wFreq = new Float32Array(this.num);
    this.cr = new Uint8Array(this.num);
    this.cg = new Uint8Array(this.num);
    this.cb = new Uint8Array(this.num);

    this._setGuide();
    this.iteration = 0;
    this.spawn();
  }

  _reseed(seed) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.p1 = this.rng() * TAU;
    const win = HUE_WINDOWS[this.palette] || HUE_WINDOWS.white;
    this.colorImage = buildColorImage(this.rng, COLOR_IMG, win[0], win[1], this.p1);
  }

  _setGuide() {
    this.ex = ELB_X * this.W;
    this.ey = ELB_Y * this.H;
    this.ry = RUN_Y * this.H;
    this.rx = EXIT_X * this.W;
  }

  _progress(i) {
    const m = this.y[i] / this.H;
    return m < 0 ? 0 : m > 1 ? 1 : m;
  }

  _place(i) {
    const { rng, W, H } = this;
    const u = rng() * 2 - 1;
    this.x[i] = (SRC_X + SRC_HALF * u) * W;
    const py = H * SRC_TOP + rng() * this.spawnRadius;
    this.y[i] = py > H - 1 ? H - 1 : py;
    this.heading[i] = DOWN_HEADING + (rng() * 2 - 1) * HEAD_SPREAD;
    const freq = MW_FREQ + MW_FREQ_RANGE * rng();
    this.bend[i] = (MW_AMP + MW_AMP_RANGE * rng()) * (rng() < 0.5 ? -1 : 1);
    this.wPhase[i] = rng() * TAU;
    this.wFreq[i] = freq;
  }

  spawn() {
    for (let i = 0; i < this.num; i++) {
      this._place(i);
    }
    for (let i = 0; i < this.num; i++) {
      this._paint(i);
    }
  }

  _paint(i) {
    const { W, H, colorImage, x, y, cr, cg, cb, _c } = this;
    sampleColor(colorImage, COLOR_IMG, x[i] / W, y[i] / H, _c);
    cr[i] = Math.round(_c[0]);
    cg[i] = Math.round(_c[1]);
    cb[i] = Math.round(_c[2]);
  }

  reset(opts = {}) {
    if (opts.seed !== undefined) {
      this._reseed(opts.seed);
    }
    if (opts.num !== undefined) {
      this.num = Math.max(1, Math.round(opts.num));
      this.x = new Float32Array(this.num);
      this.y = new Float32Array(this.num);
      this.heading = new Float32Array(this.num);
      this.bend = new Float32Array(this.num);
      this.wPhase = new Float32Array(this.num);
      this.wFreq = new Float32Array(this.num);
      this.cr = new Uint8Array(this.num);
      this.cg = new Uint8Array(this.num);
      this.cb = new Uint8Array(this.num);
    }
    this.trail.fill(0);
    this.iteration = 0;
    this.spawn();
  }

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
    this.trail = next;
    this.W = W;
    this.H = H;
    this._setGuide();
    for (let i = 0; i < this.num; i++) {
      this.x[i] = ((this.x[i] % W) + W) % W;
      this.y[i] = ((this.y[i] % H) + H) % H;
    }
    return true;
  }

  _strength(px, py) {
    const W = this.W;
    const H = this.H;
    const x = Math.floor(px);
    const y = Math.floor(py);
    if (x < 0 || x >= W || y < 0 || y >= H) return 0;
    return this.trail[(y * W + x) * 4 + 3] || 0;
  }

  _read(px, py, dx, dy) {
    const a = this._strength(px + dx * 0.55, py + dy * 0.55);
    const b = this._strength(px + dx * 0.78, py + dy * 0.78);
    const c = this._strength(px + dx, py + dy);
    return a > b ? (a > c ? a : c) : b > c ? b : c;
  }

  step() {
    const { W, H, num, trail, x, y, heading, cr, cg, cb, sensorDist, sensorAngle, rotAngle } = this;
    if (this.decay > 0) {
      const lut = this.decayLUT;
      for (let o = 0; o < trail.length; o += 4) {
        trail[o] = lut[trail[o]];
        trail[o + 1] = lut[trail[o + 1]];
        trail[o + 2] = lut[trail[o + 2]];
        trail[o + 3] = lut[trail[o + 3]];
      }
    }

    for (let i = 0; i < num; i++) {
      let h = heading[i];
      const m = this._progress(i);
      const sd = sensorDist * (SD_NEAR + (SD_FAR - SD_NEAR) * m);
      const sa = Math.min(ANGLE_MAX, sensorAngle * (SA_NEAR + (SA_FAR - SA_NEAR) * m));
      const hc = Math.cos(h * DEG2RAD);
      const hs = Math.sin(h * DEG2RAD);
      const f = this._read(x[i], y[i], hc * sd, hs * sd);
      const lc = Math.cos((h + sa) * DEG2RAD);
      const ls = Math.sin((h + sa) * DEG2RAD);
      const l = this._read(x[i], y[i], lc * sd, ls * sd);
      const rc = Math.cos((h - sa) * DEG2RAD);
      const rs = Math.sin((h - sa) * DEG2RAD);
      const r = this._read(x[i], y[i], rc * sd, rs * sd);

      const ra = rotAngle * (SR_NEAR + (SR_FAR - SR_NEAR) * m);
      let trailTurn = 0;
      if (f === 0 && l === 0 && r === 0) {
        const want = y[i] > this.ey
          ? Math.atan2(this.ry - y[i], this.rx - x[i]) / DEG2RAD
          : Math.atan2(this.ey - y[i], this.ex - x[i]) / DEG2RAD;
        const d = (((want - h) % 360) + 540) % 360 - 180;
        trailTurn = (d > GD_RATE ? GD_RATE : d < -GD_RATE ? -GD_RATE : d)
          + this.bend[i] * Math.sin(this.wPhase[i] + this.iteration * this.wFreq[i]);
      }
      else if (f >= l && f >= r) trailTurn = 0;
      else if (f < l && f < r) trailTurn = this.rng() < 0.5 ? ra : -ra;
      else if (l > r) trailTurn = ra;
      else if (r > l) trailTurn = -ra;
      h += trailTurn;

      if (h >= 360) h -= 360;
      else if (h < 0) h += 360;
      heading[i] = h;

      const a = h * DEG2RAD;
      const nx = x[i] + Math.cos(a) * this.speed;
      const ny = y[i] + Math.sin(a) * this.speed;
      if (nx < 0 || nx >= W || ny < 0 || ny >= H) {
        this._place(i);
      } else {
        x[i] = nx;
        y[i] = ny;
      }

      this._paint(i);
    }

    for (let i = 0; i < num; i++) {
      const o = (((y[i] | 0) * W + (x[i] | 0)) * 4);
      trail[o] = cr[i];
      trail[o + 1] = cg[i];
      trail[o + 2] = cb[i];
      const seen = trail[o + 3];
      if (seen < 255) trail[o + 3] = seen + (((255 - seen) >> 5) | 1);
    }

    this.iteration++;
  }

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

export { TAU };
