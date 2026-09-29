// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — compact physarum core with one migrating gravity well.
//
// The trail is the only shared memory: agents sense it, steer toward the
// strongest reading, move, and deposit one full-opacity pixel of their own
// color. The well waits at one point, then glides to a second point on the
// far diagonal. The pull grows near the well, so the swarm first packs into
// a bright knot, then stretches into a wake that streams after it and
// condenses into a new knot. Zero decay keeps every deposit, so the old
// knot, the wake, and the new knot are all one image.
// ─────────────────────────────────────────────────────────────────────────────

export const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;

export const DEFAULTS = {
  num: 4000,
  sensorAngle: 45,
  sensorDist: 10,
  rotAngle: 45,
  decay: 6,
  spawnRadius: 20,
  seed: 1337,
  palette: 'ember',
  speed: 1,
};

export const REFERENCE = { num: 4000, sensorAngle: 45, sensorDist: 10, rotAngle: 45, decay: 5 };

const COLOR_BINS = 128;
const COLOR_IMG = 56;
const FLOW_GRID = 12;
const WELL_U = 0.62;
const WELL_V = 0.4;
const WELL_FALLOFF = 150;
const WELL_TURN = 2.6;
const WELL_HOLD = 420;
const WELL_TRAVEL = 280;
const TARGET_U = 0.18;
const TARGET_V = 0.68;
const SOURCE_SPREAD = 8;

const HUE_WINDOWS = {
  white: [0, 1],
  bone: [0.06, 0.2],
  ice: [0.5, 0.73],
  ember: [0.86, 1.12],
  viridis: [0.24, 0.62],
  inferno: [0.74, 1.24],
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

export function buildColorMap(bins, from, to) {
  const map = new Uint8Array(bins * 3);
  const rgb = [0, 0, 0];
  for (let i = 0; i < bins; i++) {
    const t = i / bins;
    const band = 0.5 + 0.5 * Math.cos(t * Math.PI * 4);
    const s = 0.96 + 0.04 * (1 - band);
    const v = 0.8 + 0.2 * band;
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

export function buildColorImage(rng, n, from, to, p1 = 0, p2 = 0) {
  const g = 5;
  const warp = buildFlowField(rng, g);
  const img = new Uint8Array(n * n * 3);
  const rgb = [0, 0, 0];
  for (let y = 0; y < n; y++) {
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const w = latticeAt(warp, 0, g, u, v) - 0.5;
      const dxu = u - WELL_U;
      const dyv = v - WELL_V;
      const r = Math.sqrt(dxu * dxu + dyv * dyv) * 1.25;
      const ang = Math.atan2(dyv, dxu);
      let s = 1 - r + 0.1 * Math.sin(2 * ang + p1) + w * 0.08;
      s = s < 0 ? 0 : s > 1 ? 1 : s;
      const hue = from + (to - from) * (1 - s);
      let val = 0.3 + 0.7 * s + w * 0.05;
      val = val < 0 ? 0 : val > 1 ? 1 : val;
      hsvToRgb(hue, 0.88, val, rgb);
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

export function buildWells(rng, W, H, n) {
  const wells = new Float32Array(n * 3);
  const cx = W / 2;
  const cy = H / 2;
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU;
    const r = Math.min(W, H) * 0.2 * rng();
    wells[i * 3] = cx + Math.cos(a) * r;
    wells[i * 3 + 1] = cy + Math.sin(a) * r;
    wells[i * 3 + 2] = 24;
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
    this.speed = o.speed;
    this.palette = o.palette;

    this._c = new Float32Array(3);
    this.p1 = 0;
    this.p2 = 0;
    this._reseed(o.seed);

    this.trail = new Uint8Array(this.W * this.H * 4);

    this.x = new Float32Array(this.num);
    this.y = new Float32Array(this.num);
    this.heading = new Float32Array(this.num);
    this.cr = new Uint8Array(this.num);
    this.cg = new Uint8Array(this.num);
    this.cb = new Uint8Array(this.num);

    this.iteration = 0;
    this._wxy = [0, 0];
    this._layout();
    this.spawn();
  }

  _layout() {
    this.wayAx = this.W * WELL_U;
    this.wayAy = this.H * WELL_V;
    this.wayBx = this.W * TARGET_U;
    this.wayBy = this.H * TARGET_V;
  }

  _wellPos(t) {
    let s = 0;
    if (t > WELL_HOLD) {
      const q = Math.min(1, (t - WELL_HOLD) / WELL_TRAVEL);
      s = q * q * (3 - 2 * q);
    }
    this._wxy[0] = this.wayAx + (this.wayBx - this.wayAx) * s;
    this._wxy[1] = this.wayAy + (this.wayBy - this.wayAy) * s;
    return this._wxy;
  }

  _reseed(seed) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.p1 = this.rng() * TAU;
    this.p2 = this.rng() * TAU;
    const win = HUE_WINDOWS[this.palette] || HUE_WINDOWS.white;
    this.colorImage = buildColorImage(this.rng, COLOR_IMG, win[0], win[1], this.p1, this.p2);
  }

  spawn() {
    const { W, H, num, rng } = this;
    const sx = this.wayAx;
    const sy = this.wayAy;
    const r = this.spawnRadius;
    for (let i = 0; i < num; i++) {
      this.x[i] = (((sx + (rng() * 2 - 1) * r) % W) + W) % W;
      this.y[i] = (((sy + (rng() * 2 - 1) * r) % H) + H) % H;
      const h = Math.atan2(this.wayBy - this.y[i], this.wayBx - this.x[i]) / DEG2RAD + (rng() * 2 - 1) * SOURCE_SPREAD;
      this.heading[i] = ((h % 360) + 360) % 360;
    }
    this._recolor();
  }

  _recolor() {
    const { W, H, num, colorImage, x, y, cr, cg, cb } = this;
    for (let i = 0; i < num; i++) {
      sampleColor(colorImage, COLOR_IMG, x[i] / W, y[i] / H, this._c);
      cr[i] = Math.min(255, Math.round(this._c[0]));
      cg[i] = Math.min(255, Math.round(this._c[1]));
      cb[i] = Math.min(255, Math.round(this._c[2]));
    }
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
    this._layout();
    for (let i = 0; i < this.num; i++) {
      this.x[i] = ((this.x[i] % W) + W) % W;
      this.y[i] = ((this.y[i] % H) + H) % H;
    }
    return true;
  }

  _lum(px, py) {
    const W = this.W;
    const H = this.H;
    const x = (((px | 0) % W) + W) % W;
    const y = (((py | 0) % H) + H) % H;
    const o = (y * W + x) * 4;
    const r = this.trail[o];
    const g = this.trail[o + 1];
    const b = this.trail[o + 2];
    return r > g ? (r > b ? r : b) : g > b ? g : b;
  }

  step() {
    const { W, H, num, trail, x, y, heading, cr, cg, cb, colorImage } = this;
    if (this.decay > 0) {
      const lut = this.decayLUT;
      for (let o = 0; o < trail.length; o += 4) {
        trail[o] = lut[trail[o]];
        trail[o + 1] = lut[trail[o + 1]];
        trail[o + 2] = lut[trail[o + 2]];
      }
    }
    const sensorAngle = this.sensorAngle;
    const sensorDist = this.sensorDist;
    const rotAngle = this.rotAngle;
    const pace = this.speed ?? 1;
    const wpos = this._wellPos(this.iteration);
    const wx = wpos[0];
    const wy = wpos[1];

    for (let i = 0; i < num; i++) {
      let h = heading[i];
      const hc = Math.cos(h * DEG2RAD);
      const hs = Math.sin(h * DEG2RAD);
      const f = this._lum(x[i] + hc * sensorDist, y[i] + hs * sensorDist);
      const lc = Math.cos((h + sensorAngle) * DEG2RAD);
      const ls = Math.sin((h + sensorAngle) * DEG2RAD);
      const l = this._lum(x[i] + lc * sensorDist, y[i] + ls * sensorDist);
      const rc = Math.cos((h - sensorAngle) * DEG2RAD);
      const rs = Math.sin((h - sensorAngle) * DEG2RAD);
      const r = this._lum(x[i] + rc * sensorDist, y[i] + rs * sensorDist);

      const trailTurn = f < l && f < r ? 0 : l > r ? -rotAngle : r > l ? rotAngle : 0;
      h += trailTurn;

      const wdx = wx - x[i];
      const wdy = wy - y[i];
      const wd = Math.sqrt(wdx * wdx + wdy * wdy) + 1e-6;
      const want = Math.atan2(wdy, wdx) / DEG2RAD;
      const d = ((((want - h) % 360) + 540) % 360) - 180;
      const cap = WELL_TURN * (WELL_FALLOFF / (WELL_FALLOFF + wd));
      h += d > cap ? cap : d < -cap ? -cap : d;
      if (h >= 360) h -= 360;
      else if (h < 0) h += 360;
      heading[i] = h;

      const a = h * DEG2RAD;
      x[i] = (((x[i] + Math.cos(a) * pace) % W) + W) % W;
      y[i] = (((y[i] + Math.sin(a) * pace) % H) + H) % H;

      sampleColor(colorImage, COLOR_IMG, x[i] / W, y[i] / H, this._c);
      cr[i] = Math.min(255, Math.round(this._c[0]));
      cg[i] = Math.min(255, Math.round(this._c[1]));
      cb[i] = Math.min(255, Math.round(this._c[2]));
    }

    for (let i = 0; i < num; i++) {
      const o = (((y[i] | 0) * W + (x[i] | 0)) * 4);
      trail[o] = cr[i];
      trail[o + 1] = cg[i];
      trail[o + 2] = cb[i];
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
