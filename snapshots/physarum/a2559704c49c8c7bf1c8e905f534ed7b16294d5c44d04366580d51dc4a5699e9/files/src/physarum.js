// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — compact physarum core: two forks that meet in one river.
//
// Two seeded springs hold the colony. The larger share of the agents spawns in
// the upper spring, the smaller share in the lower spring. Every placement
// points the agent toward the junction between the springs, so each life starts
// a run toward the meeting water. An agent east of the junction aims at the
// exit instead. An agent that sees no trail eases its heading toward that aim
// and keeps a small seeded curvature, which draws gentle creeks instead of
// closed loops. The drift never steers an agent that can see trail: it acts
// only when all three readings are zero. If the readings are equal but not
// zero, the forward preference holds the heading and the guide stays idle, so
// the two rivers and their braids remain the work of the trail.
//
// One continuous sense scale replaces castes. Each agent draws a seeded
// factor once: far sensors with small turns make long smooth cords, near
// sensors with wide turns raise fine twigs, and the middle values mix both.
// The trail is the only shared memory. Its color bytes carry the display and
// its alpha byte carries path reuse: each visit adds a compressed step, so a
// lane that many agents have used reads far above a fresh trace. Agents sense
// that reuse in front and on both side rays, turn toward the strongest
// reading, move, and deposit one full-opacity pixel. Each ray is read at
// three points and keeps the strongest one, so a lane one pixel wide is still
// found at the sensor distance. Zero decay keeps every deposit: the springs
// stay bright, the two fork rivers split and merge on the way to the junction,
// and the shared trunk downstream carries both colonies and reads strongest.
// The corners far from the Y keep the image quiet.
//
// Particle color comes from a generated noise map in a sea-teal family. The
// main fork samples the map lighter and the tributary fork deeper, so the two
// rivers stay related but distinct. The renderer lifts the reuse stored in the
// alpha byte toward one pale ice accent, so the shared water reads pale while
// fresh traces stay dark.
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
  palette: 'ice',
  speed: 2,
};

export const REFERENCE = { num: 4000, sensorAngle: 45, sensorDist: 10, rotAngle: 45, decay: 5 };

const ROOT_A = { x: 0.12, y: 0.24 };
const ROOT_B = { x: 0.26, y: 0.80 };
const JUNCTION = { x: 0.52, y: 0.47 };
const EXIT = { x: 1.06, y: 0.62 };
const MAIN_SHARE = 0.62;
const AIM_SPREAD = 20;
const FLOW_K = 0.02;
const BEND_BASE = 0.07;
const BEND_RANGE = 0.18;
const ANGLE_MAX = 55;
const TRIB_SHIFT = 0.5;
const TRIB_DIM = 0.82;

const COLOR_IMG = 56;

const HUE_WINDOWS = {
  white: [0, 1],
  ice: [0.46, 0.58],
  bone: [0.05, 0.13],
  ember: [0.94, 1.09],
  viridis: [0.36, 0.54],
  inferno: [0.72, 0.97],
  magma: [0.72, 1.06],
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
      const sat = 0.36 + 0.22 * a3;
      const val = 0.2 + 0.22 * (a2 * 0.4 + a3 * 0.35 + a4 * 0.25);
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
    this.spawnRadius = o.spawnRadius;
    const lim = Math.min(this.W, this.H);
    this.spawnR = Math.min(this.spawnRadius, lim * 0.12);
    this.speed = o.speed;
    this.palette = o.palette;
    this.mainCount = Math.round(this.num * MAIN_SHARE);

    this._c = new Float32Array(3);
    this._reseed(o.seed);
    this._setGuides();

    this.trail = new Uint8Array(this.W * this.H * 4);

    this.x = new Float32Array(this.num);
    this.y = new Float32Array(this.num);
    this.heading = new Float32Array(this.num);
    this.bend = new Float32Array(this.num);
    this.sk = new Float32Array(this.num);
    this.sdist = new Float32Array(this.num);
    this.sangle = new Float32Array(this.num);
    this.srot = new Float32Array(this.num);
    this.cr = new Uint8Array(this.num);
    this.cg = new Uint8Array(this.num);
    this.cb = new Uint8Array(this.num);

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

  _setGuides() {
    this.jx = JUNCTION.x * this.W;
    this.jy = JUNCTION.y * this.H;
    this.ex = EXIT.x * this.W;
    this.ey = EXIT.y * this.H;
  }

  _place(i) {
    const { W, H, rng } = this;
    if (this.sk[i] === 0) {
      const k = rng();
      this.sk[i] = k;
      this.sdist[i] = this.sensorDist * (0.62 + 0.5 * k);
      this.sangle[i] = Math.min(ANGLE_MAX, this.sensorAngle * (0.85 + 0.8 * k));
      this.srot[i] = this.rotAngle * (0.8 + 0.7 * k);
    }
    const root = i < this.mainCount ? ROOT_A : ROOT_B;
    const ang = rng() * TAU;
    const rad = Math.sqrt(rng()) * this.spawnR;
    this.x[i] = root.x * W + Math.cos(ang) * rad;
    this.y[i] = root.y * H + Math.sin(ang) * rad;
    const ta = Math.atan2(JUNCTION.y * H - this.y[i], JUNCTION.x * W - this.x[i]) / DEG2RAD;
    const h = ta + (rng() * 2 - 1) * AIM_SPREAD;
    this.heading[i] = ((h % 360) + 360) % 360;
    if (this.bend[i] === 0) {
      this.bend[i] = (BEND_BASE + BEND_RANGE * rng()) * (rng() < 0.5 ? -1 : 1);
    }
  }

  spawn() {
    for (let i = 0; i < this.num; i++) {
      this._place(i);
    }
    this._recolor();
  }

  _recolor() {
    const { W, H, num, colorImage, x, y, cr, cg, cb, sk, _c } = this;
    for (let i = 0; i < num; i++) {
      const tn = (0.6 + 0.4 * sk[i]) * (i < this.mainCount ? 1 : TRIB_DIM);
      const v = y[i] / H + (i < this.mainCount ? 0 : TRIB_SHIFT);
      sampleColor(colorImage, COLOR_IMG, x[i] / W, v % 1, _c);
      cr[i] = Math.min(255, Math.round(_c[0] * 0.95 * tn));
      cg[i] = Math.min(255, Math.round(_c[1] * 1.02 * tn));
      cb[i] = Math.min(255, Math.round(_c[2] * 1.08 * tn));
    }
  }

  reset(opts = {}) {
    if (opts.seed !== undefined) {
      this._reseed(opts.seed);
    }
    if (opts.num !== undefined) {
      this.num = Math.max(1, Math.round(opts.num));
      this.mainCount = Math.round(this.num * MAIN_SHARE);
      this.x = new Float32Array(this.num);
      this.y = new Float32Array(this.num);
      this.heading = new Float32Array(this.num);
      this.bend = new Float32Array(this.num);
      this.sk = new Float32Array(this.num);
      this.sdist = new Float32Array(this.num);
      this.sangle = new Float32Array(this.num);
      this.srot = new Float32Array(this.num);
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
    this._setGuides();
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
    const { W, H, num, trail, x, y, heading, cr, cg, cb, colorImage, sdist, sangle, srot } = this;
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
      const sd = sdist[i];
      const sa = sangle[i];
      const hc = Math.cos(h * DEG2RAD);
      const hs = Math.sin(h * DEG2RAD);
      const f = this._read(x[i], y[i], hc * sd, hs * sd);
      const lc = Math.cos((h + sa) * DEG2RAD);
      const ls = Math.sin((h + sa) * DEG2RAD);
      const l = this._read(x[i], y[i], lc * sd, ls * sd);
      const rc = Math.cos((h - sa) * DEG2RAD);
      const rs = Math.sin((h - sa) * DEG2RAD);
      const r = this._read(x[i], y[i], rc * sd, rs * sd);

      const ra = srot[i];
      let trailTurn = 0;
      if (f === 0 && l === 0 && r === 0) {
        const east = x[i] >= this.jx;
        const tx = east ? this.ex : this.jx;
        const ty = east ? this.ey : this.jy;
        const ta = Math.atan2(ty - y[i], tx - x[i]) / DEG2RAD;
        const da = ((ta - h + 540) % 360) - 180;
        trailTurn = da * FLOW_K + this.bend[i];
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

      const tn = (0.6 + 0.4 * this.sk[i]) * (i < this.mainCount ? 1 : TRIB_DIM);
      const v = y[i] / H + (i < this.mainCount ? 0 : TRIB_SHIFT);
      sampleColor(colorImage, COLOR_IMG, x[i] / W, v % 1, this._c);
      cr[i] = Math.min(255, Math.round(this._c[0] * 0.95 * tn));
      cg[i] = Math.min(255, Math.round(this._c[1] * 1.02 * tn));
      cb[i] = Math.min(255, Math.round(this._c[2] * 1.08 * tn));
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
