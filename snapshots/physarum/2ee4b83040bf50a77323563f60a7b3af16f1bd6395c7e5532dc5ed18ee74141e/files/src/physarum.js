// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — compact physarum core: one loom.
//
// A rectilinear weave grows across the frame from seeded station roots. Each
// track is one shallow bowed segment with its own seeded birth time, so the
// loom builds outward from a dense main circuit toward a thin fringe of stubs
// and late chords. Track share follows a length power, so the main circuit
// carries the largest flock and the stubs stay thin. Each station drips along
// its track from root to tip, then wraps to the root, so the colony patrols
// the weave. One slow shared phase bends every track, so the finished loom
// keeps re-weaving itself instead of stopping.
//
// The sensor ladder is the only steer on trail: hold when forward reads
// strongest, turn toward the stronger side ray, and take one seeded side
// when both side rays beat forward. Equal live readings hold the heading.
// The home pull acts only when all three sensors read zero, so trail
// feedback decides every visible path and the track lines cannot override
// it. A blind agent keeps one gentle seeded curl and returns to its home
// station after a short run, so the open cells stay quiet.
//
// The trail RGBA carries the display color and the reuse count. Zero decay
// keeps every deposit: the busiest lanes saturate first and the renderer
// lifts them toward one warm brass accent, while thin tracks and fringe
// keep their dim map color. The map runs through one indigo span, so related
// forms share related colors.
//
// Particle color comes from a generated map in one indigo span, sampled at
// the deposit position.
// ─────────────────────────────────────────────────────────────────────────────

export const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;

export const DEFAULTS = {
  num: 1000,
  sensorAngle: 58,
  sensorDist: 55,
  rotAngle: 42,
  decay: 0,
  spawnRadius: 11,
  seed: 1337,
  palette: 'loom',
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

const GROW_K = 40;
const SWAY = 0.0015;
const SWAY_AMP = 0.0045;
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
  loom: [0.575, 0.675],
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
    this.defs = [];
    this._loom();
    const n = this.defs.length;
    const shares = new Float32Array(n + 1);
    for (let b = 0; b < n; b++) {
      const d = this.defs[b];
      const dx = d.x1 - d.x0;
      const dy = d.y1 - d.y0;
      const w = Math.pow(Math.sqrt(dx * dx + dy * dy), WEIGHT_POW) + 0.004;
      shares[b + 1] = shares[b] + w;
    }
    this.shares = shares;
  }

  _loom() {
    const g = this.grng;
    const defs = this.defs;
    const jit = () => (g() * 2 - 1) * 0.026;
    const node = (x, y) => [x + jit(), y + jit()];
    const track = (a, b, birth) => {
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const len = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const px = -dy / len;
      const py = dx / len;
      const bow = (g() * 2 - 1) * Math.min(0.045, len * 0.16);
      defs.push({
        x0: a[0], y0: a[1], x1: b[0], y1: b[1],
        cx: (a[0] + b[0]) / 2 + px * bow,
        cy: (a[1] + b[1]) / 2 + py * bow,
        px, py, birth,
        phase: g() * TAU,
        fs: 0.7 + g() * 0.6,
        e: 0, mx: 0, my: 0,
      });
    };
    const A = node(0.105, 0.26);
    const B = node(0.5, 0.225);
    const C = node(0.55, 0.505);
    const D = node(0.115, 0.525);
    track(A, B, 0);
    track(B, C, 0.012);
    track(C, D, 0.006);
    track(D, A, 0.003);
    const E = node(0.865, 0.3);
    const F = node(0.835, 0.565);
    track(B, E, 0.09);
    track(C, F, 0.14);
    track(E, F, 0.24);
    const Gp = node(0.335, 0.685);
    const Gq = node(0.625, 0.725);
    track(D, Gp, 0.3);
    track(Gp, Gq, 0.42);
    track(Gp, node(0.318, 0.512), 0.37);
    track(B, node(0.472, 0.105), 0.34);
    track(D, node(0.038, 0.298), 0.2);
    track(E, node(0.958, 0.272), 0.27);
    track(F, node(0.882, 0.702), 0.52);
    track(Gq, node(0.685, 0.865), 0.6);
    track(B, D, 0.5);
    track(C, E, 0.62);
    track(Gp, C, 0.74);
    track(Gp, F, 0.85);
  }

  _updateSources() {
    const m = Math.min(this.W, this.H);
    const grow = this.iteration / (this.iteration + GROW_K);
    const ph = this.p1 + this.iteration * SWAY;
    const defs = this.defs;
    for (let b = 0; b < defs.length; b++) {
      const d = defs[b];
      const p = (grow - d.birth) / (1 - d.birth);
      const q = p <= 0 ? 0 : p >= 1 ? 1 : p;
      d.e = 1 - (1 - q) * (1 - q);
      const off = Math.sin(ph * d.fs + d.phase) * SWAY_AMP;
      d.mx = d.cx + d.px * off;
      d.my = d.cy + d.py * off;
    }
    this.half = Math.max(1.2, this.spawnRadius * 0.35 * (m / 1000));
    this.cap = Math.max(this.sensorDist * 2, 0.052 * m);
  }

  _homePoint(i) {
    const d = this.defs[this.homeNode[i]];
    let r = this.homeR[i];
    if (r > d.e) r = d.e;
    const s = 1 - r;
    this._hx = (s * s * d.x0 + 2 * s * r * d.mx + r * r * d.x1) * this.W;
    this._hy = (s * s * d.y0 + 2 * s * r * d.my + r * r * d.y1) * this.H;
  }

  _homeAngle(i) {
    const d = this.defs[this.homeNode[i]];
    let r = this.homeR[i];
    if (r > d.e) r = d.e;
    const s = 1 - r;
    const tx = 2 * s * (d.mx - d.x0) + 2 * r * (d.x1 - d.mx);
    const ty = 2 * s * (d.my - d.y0) + 2 * r * (d.y1 - d.my);
    return Math.atan2(ty, tx) / DEG2RAD;
  }

  _place(i) {
    const { rng, W, H, x, y, heading, curl, blind } = this;
    this._homePoint(i);
    const half = this.half;
    x[i] = ((this._hx + (rng() * 2 - 1) * half) % W + W) % W;
    let py = this._hy + (rng() * 2 - 1) * half;
    y[i] = py < 1 ? 1 : py > H - 2 ? H - 2 : py;
    heading[i] = this._homeAngle(i) + (rng() * 2 - 1) * 24;
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
