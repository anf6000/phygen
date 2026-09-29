// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — compact physarum core with one self-organized colony.
//
// The trail is the only shared memory: agents sense it, steer toward the
// strongest reading, move, and deposit one full-opacity pixel of their own
// color. One colony spawns at an offset roost with random headings and no
// guide. Trail attraction holds a dense rosette at the roost, while frontier
// agents that sense no trail ahead keep straight and extend radial strands
// into the dark; attraction recruits passing agents onto existing strands, so
// the space between strands stays open and the far corners stay quiet. Zero
// decay keeps every deposit, so core, corona and strands are one image.
// Particle color comes from a radial map around the roost: bright warm at the
// core and fading outward, so strands dim as they reach into the void.
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

const COLOR_IMG = 56;
const COLONY_UV = [0.4, 0.56];
const MAP_REACH = 0.75;

const HUE_WINDOWS = {
  white: [0, 1],
  bone: [0.06, 0.2],
  ice: [0.5, 0.66],
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

const HUE_SWING = 0.07;
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
    this.speed = o.speed;
    this.palette = o.palette;

    this._c = new Float32Array(3);
    this._reseed(o.seed);

    this.trail = new Uint8Array(this.W * this.H * 4);

    this.x = new Float32Array(this.num);
    this.y = new Float32Array(this.num);
    this.heading = new Float32Array(this.num);
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

  spawn() {
    const { W, H, num, rng } = this;
    const r = this.spawnRadius;
    const gx = COLONY_UV[0] * W;
    const gy = COLONY_UV[1] * H;
    for (let i = 0; i < num; i++) {
      const a = rng() * TAU;
      const rr = r * Math.sqrt(rng());
      this.x[i] = (((gx + Math.cos(a) * rr) % W) + W) % W;
      this.y[i] = (((gy + Math.sin(a) * rr) % H) + H) % H;
      this.heading[i] = rng() * 360;
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
    const m22 = 0.072 + hcos * 0.928 + hsin * 0.072;

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

      const trailTurn = f < l && f < r ? 0 : l > r ? rotAngle : r > l ? -rotAngle : 0;
      h += trailTurn;
      if (h >= 360) h -= 360;
      else if (h < 0) h += 360;
      heading[i] = h;

      const a = h * DEG2RAD;
      x[i] = (((x[i] + Math.cos(a) * pace) % W) + W) % W;
      y[i] = (((y[i] + Math.sin(a) * pace) % H) + H) % H;

      sampleColor(colorImage, COLOR_IMG, x[i] / W, y[i] / H, this._c);
      const c0 = this._c[0];
      const c1 = this._c[1];
      const c2 = this._c[2];
      cr[i] = clampByte(c0 * m00 + c1 * m01 + c2 * m02);
      cg[i] = clampByte(c0 * m10 + c1 * m11 + c2 * m12);
      cb[i] = clampByte(c0 * m20 + c1 * m21 + c2 * m22);
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
