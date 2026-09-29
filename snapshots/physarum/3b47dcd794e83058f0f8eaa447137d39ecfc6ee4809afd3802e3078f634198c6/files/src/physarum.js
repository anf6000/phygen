// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — compact physarum core: one tree.
//
// One tree fills the frame. A short trunk rises from the lower root and
// splits through three seeded levels into limbs, sub-branches, and twigs.
// Every agent owns a home station on one branch. Station share follows a
// length power, so the trunk carries the largest flock and twigs stay thin.
// Each station drifts along its branch from root to tip, then wraps to the
// root, so the colony circulates through its own crown. One slow shared
// phase bends every branch control point, so the tree keeps re-weaving
// itself instead of stopping.
//
// The sensor ladder is the only steer on trail: hold when forward reads
// strongest, turn toward the stronger side ray, and take one seeded side
// when both side rays beat forward. Equal live readings hold the heading.
// The home pull acts only when all three sensors read zero, so trail
// feedback decides every visible path and the branch lines cannot override
// it. A blind agent keeps one gentle seeded curl and returns to its home
// station after a short run, so open field stays quiet.
//
// The trail RGBA carries the display color and the reuse count. Zero decay
// keeps every deposit: the trunk and the main limbs saturate first and the
// renderer lifts them toward one warm gold accent, while twigs and fray
// keep their dim map color. The map runs from deep red at the top of the
// frame toward orange red at the bottom, so related forms share related
// colors.
//
// Particle color comes from a generated map in one rust span, sampled at
// the deposit position.
// ─────────────────────────────────────────────────────────────────────────────

export const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;
const HALF_PI = Math.PI / 2;

export const DEFAULTS = {
  num: 1000,
  sensorAngle: 58,
  sensorDist: 55,
  rotAngle: 42,
  decay: 0,
  spawnRadius: 11,
  seed: 1337,
  palette: 'ember',
  speed: 2,
};

export const REFERENCE = { num: 4000, sensorAngle: 45, sensorDist: 10, rotAngle: 45, decay: 5 };

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

const SEG_N = 12;
const ROOT_X = 0.44;
const ROOT_Y = 0.94;
const TRUNK_LEN = 0.34;
const PAD = 0.05;
const SWAY = 0.0015;
const SWAY_AMP = 0.012;
const DRIP = 0.0006;
const PULL = 0.12;
const CURL = 0.4;
const SCOUT = 50;
const WEIGHT_POW = 1.6;

const COLOR_IMG = 56;

const HUE_WINDOWS = {
  white: [0, 1],
  ice: [0.635, 0.55],
  bone: [0.05, 0.115],
  ember: [0.99, 1.06],
  moss: [0.24, 0.46],
  viridis: [0.46, 0.24],
  inferno: [0.56, 0.82],
  magma: [0.66, 0.78],
  slate: [0.55, 0.66],
  lagoon: [0.45, 0.55],
};

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
  const grids = [3, 5];
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
      let hue = from + (to - from) * v + (a1 - 0.5) * 0.04;
      hue = ((hue % 1) + 1) % 1;
      const sat = 0.5 + 0.12 * a2;
      const val = 0.075 + 0.07 * a1;
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
    this._hx = 0;
    this._hy = 0;
    this._reseed(o.seed);

    this.trail = new Uint8Array(this.W * this.H * 4);

    this.x = new Float32Array(this.num);
    this.y = new Float32Array(this.num);
    this.heading = new Float32Array(this.num);
    this.cr = new Uint8Array(this.num);
    this.cg = new Uint8Array(this.num);
    this.cb = new Uint8Array(this.num);
    this.curl = new Float32Array(this.num);
    this.blind = new Uint16Array(this.num);
    this.homeR = new Float32Array(this.num);
    this.homeNode = new Uint8Array(this.num);

    this.iteration = 0;
    this.spawn();
  }

  _reseed(seed) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.p1 = this.rng() * TAU;
    const win = HUE_WINDOWS[this.palette] || HUE_WINDOWS.white;
    this.colorImage = buildColorImage(this.rng, COLOR_IMG, win[0], win[1], this.p1);
    this.grng = makeRng((seed ^ 0x5f356495) >>> 0);
    this.branchDefs = [];
    this._grow(this.branchDefs, ROOT_X, ROOT_Y, -HALF_PI, TRUNK_LEN, 0);
    const n = this.branchDefs.length;
    const shares = new Float32Array(n + 1);
    for (let b = 0; b < n; b++) {
      const d = this.branchDefs[b];
      const dx = d.x1 - d.x0;
      const dy = d.y1 - d.y0;
      const w = Math.pow(Math.sqrt(dx * dx + dy * dy), WEIGHT_POW) + 0.004;
      shares[b + 1] = shares[b] + w;
    }
    this.shares = shares;
    this.pts = new Float32Array(n * SEG_N * 2);
  }

  _grow(defs, x0, y0, ang, len, depth) {
    const g = this.grng;
    const a = ang + (g() * 2 - 1) * 0.18;
    let x1 = x0 + Math.cos(a) * len;
    let y1 = y0 + Math.sin(a) * len;
    x1 = Math.min(1 - PAD, Math.max(PAD, x1));
    y1 = Math.min(1 - PAD, Math.max(PAD, y1));
    const ca = a + HALF_PI;
    const mx = (x0 + x1) / 2 + Math.cos(ca) * (g() * 2 - 1) * len * 0.2;
    const my = (y0 + y1) / 2 + Math.sin(ca) * (g() * 2 - 1) * len * 0.2;
    defs.push({ x0, y0, mx, my, x1, y1, depth, phase: g() * TAU, fs: 0.7 + g() * 0.6 });
    if (depth >= 3) return;
    const side = g() < 0.5 ? -1 : 1;
    const nSide = depth === 0 ? 2 : g() < 0.45 ? 2 : 1;
    const spread = 0.55 + g() * 0.35;
    for (let k = 0; k < nSide; k++) {
      const t = 0.55 + ((k + 1) / (nSide + 1)) * 0.4;
      const off = side * (spread + g() * 0.25);
      this._sprout(defs, x0, y0, mx, my, x1, y1, t, off, len * (0.45 + g() * 0.2), depth + 1);
    }
    this._sprout(defs, x0, y0, mx, my, x1, y1, 1, (g() * 2 - 1) * 0.3, len * 0.68, depth + 1);
  }

  _sprout(defs, x0, y0, mx, my, x1, y1, t, off, len, depth) {
    const s = 1 - t;
    const px = s * s * x0 + 2 * s * t * mx + t * t * x1;
    const py = s * s * y0 + 2 * s * t * my + t * t * y1;
    const dx = 2 * s * (mx - x0) + 2 * t * (x1 - mx);
    const dy = 2 * s * (my - y0) + 2 * t * (y1 - my);
    this._grow(defs, px, py, Math.atan2(dy, dx) + off, len, depth);
  }

  _updateSources() {
    const W = this.W;
    const H = this.H;
    const m = Math.min(W, H);
    const ph = this.p1 + this.iteration * SWAY;
    const pts = this.pts;
    const defs = this.branchDefs;
    for (let b = 0; b < defs.length; b++) {
      const d = defs[b];
      const mx = d.mx + Math.sin(ph * d.fs + d.phase) * SWAY_AMP;
      const my = d.my + Math.cos(ph * d.fs * 0.83 + d.phase * 1.7) * SWAY_AMP * 0.7;
      const o = b * SEG_N * 2;
      for (let k = 0; k < SEG_N; k++) {
        const t = k / (SEG_N - 1);
        const s = 1 - t;
        pts[o + k * 2] = (s * s * d.x0 + 2 * s * t * mx + t * t * d.x1) * W;
        pts[o + k * 2 + 1] = (s * s * d.y0 + 2 * s * t * my + t * t * d.y1) * H;
      }
    }
    this.half = Math.max(1.2, this.spawnRadius * 0.35 * (m / 1000));
    this.cap = Math.max(this.sensorDist * 2, 0.052 * m);
  }

  _homePoint(i) {
    const b = this.homeNode[i];
    const fi = this.homeR[i] * (SEG_N - 1);
    const i0 = fi | 0;
    const i1 = Math.min(SEG_N - 1, i0 + 1);
    const f = fi - i0;
    const o = b * SEG_N * 2;
    this._hx = this.pts[o + i0 * 2] + (this.pts[o + i1 * 2] - this.pts[o + i0 * 2]) * f;
    this._hy = this.pts[o + i0 * 2 + 1] + (this.pts[o + i1 * 2 + 1] - this.pts[o + i0 * 2 + 1]) * f;
  }

  _homeAngle(i) {
    const b = this.homeNode[i];
    const o = b * SEG_N * 2;
    const fi = this.homeR[i] * (SEG_N - 1);
    const i0 = Math.max(0, Math.min(SEG_N - 2, Math.round(fi)));
    const dx = this.pts[o + (i0 + 1) * 2] - this.pts[o + i0 * 2];
    const dy = this.pts[o + (i0 + 1) * 2 + 1] - this.pts[o + i0 * 2 + 1];
    return Math.atan2(dy, dx) / DEG2RAD;
  }

  _place(i) {
    const { rng, W, H, x, y, heading, curl, blind } = this;
    this._homePoint(i);
    const half = this.half;
    x[i] = ((this._hx + (rng() * 2 - 1) * half) % W + W) % W;
    let py = this._hy + (rng() * 2 - 1) * half;
    y[i] = py < 1 ? 1 : py > H - 2 ? H - 2 : py;
    heading[i] = this._homeAngle(i) + (rng() * 2 - 1) * 45;
    curl[i] = (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 1.3);
    blind[i] = 0;
  }

  spawn() {
    this._updateSources();
    const shares = this.shares;
    const total = shares[shares.length - 1];
    for (let i = 0; i < this.num; i++) {
      const u = this.rng() * total;
      let k = shares.length - 2;
      for (let j = 0; j < shares.length - 1; j++) {
        if (u < shares[j + 1]) {
          k = j;
          break;
        }
      }
      this.homeNode[i] = k;
      this.homeR[i] = this.rng();
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
      this.cr = new Uint8Array(this.num);
      this.cg = new Uint8Array(this.num);
      this.cb = new Uint8Array(this.num);
      this.curl = new Float32Array(this.num);
      this.blind = new Uint16Array(this.num);
      this.homeR = new Float32Array(this.num);
      this.homeNode = new Uint8Array(this.num);
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
    this._updateSources();
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
    const { W, H, num, trail, x, y, heading, cr, cg, cb, curl, blind, homeR,
            sensorDist, sensorAngle, rotAngle } = this;
    this._updateSources();
    const cap2 = this.cap * this.cap;
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
      let hr = homeR[i] + DRIP;
      if (hr > 1) hr -= 1;
      homeR[i] = hr;
      let h = heading[i];
      const sd = sensorDist;
      const sa = sensorAngle;
      const hc = Math.cos(h * DEG2RAD);
      const hs = Math.sin(h * DEG2RAD);
      const f = this._read(x[i], y[i], hc * sd, hs * sd);
      const lc = Math.cos((h + sa) * DEG2RAD);
      const ls = Math.sin((h + sa) * DEG2RAD);
      const l = this._read(x[i], y[i], lc * sd, ls * sd);
      const rc = Math.cos((h - sa) * DEG2RAD);
      const rs = Math.sin((h - sa) * DEG2RAD);
      const r = this._read(x[i], y[i], rc * sd, rs * sd);

      const ra = rotAngle;
      let trailTurn = 0;
      if (f >= l && f >= r) trailTurn = 0;
      else if (f < l && f < r) trailTurn = this.rng() < 0.5 ? ra : -ra;
      else if (l > r) trailTurn = ra;
      else if (r > l) trailTurn = -ra;

      if (f === 0 && l === 0 && r === 0) {
        this._homePoint(i);
        const dx = x[i] - this._hx;
        const dy = y[i] - this._hy;
        if (dx * dx + dy * dy > cap2) {
          let g = Math.atan2(-dy, -dx) / DEG2RAD - h;
          while (g > 180) g -= 360;
          while (g < -180) g += 360;
          trailTurn += g * PULL;
        }
        trailTurn += curl[i] * CURL;
        const b = blind[i] + 1;
        if (b > SCOUT) {
          this._place(i);
          this._paint(i);
          continue;
        }
        blind[i] = b;
      } else {
        blind[i] = 0;
      }

      h += trailTurn;

      if (h >= 360) h -= 360;
      else if (h < 0) h += 360;
      heading[i] = h;

      const a = h * DEG2RAD;
      let nx = x[i] + Math.cos(a) * this.speed;
      const ny = y[i] + Math.sin(a) * this.speed;
      if (ny < 0 || ny >= H) {
        this._place(i);
        this._paint(i);
        continue;
      }
      if (nx < 0) nx += W;
      else if (nx >= W) nx -= W;
      x[i] = nx;
      y[i] = ny;

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
