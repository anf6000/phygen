// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — compact physarum core: one frond.
//
// One pinnate frond spans the frame. A single bowed rachis runs from the
// lower left root toward the mid right tip, and thirteen rib pairs branch
// from it to both sides, long near the middle and short at the root and the
// tip. Every agent owns a home station: rachis agents hold a station on the
// rachis and sweep it end to end, rib agents hold a station on one rib,
// weighted so the rachis carries the largest flock. Each station drifts
// along its line and wraps to the anchor. One slow shared phase breathes
// through the whole frond: the rachis control points and every rib angle
// oscillate with that phase, so the colony keeps re-weaving its own lattice
// instead of stopping. The sensor ladder is the only steer on trail: hold
// when forward reads strongest, turn toward the stronger side ray, and take
// one seeded side when both side rays beat forward. Equal live readings hold
// the heading; the home pull acts only when all three sensors read zero, so
// trail feedback decides every visible path and the stations cannot override
// it. A blind agent keeps one gentle seeded curl, so one excursion lays one
// short curved bud beside its line, and an early return run keeps long blind
// arcs out of the open field. Agents that leave the frame, and agents that
// stay blind past a fixed run, return to their home station.
//
// The trail RGBA carries the display color and the reuse count. Zero decay
// keeps every deposit: the rachis and the busiest rib roots saturate first
// and the renderer lifts them toward one warm gold accent, while rib tips
// and fray keep their dim map color. The map runs from yellow-green at the
// top of the frame toward teal-green at the bottom and brightens in a band
// along the rachis, so related forms share related colors.
//
// Particle color comes from a generated map in one green span, sampled at
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
  palette: 'moss',
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

const SPINE_P = [
  [0.07, 0.74],
  [0.34, 0.24],
  [0.66, 0.3],
  [0.93, 0.62],
];
const SPINE_N = 48;
const RIBS = 13;
const SPINE_SHARE = 0.42;
const LMAX = 0.3;
const SWAY = 0.0012;
const BREATH = 0.03;
const BOW = 0.012;
const DRIP = 0.0005;
const PULL = 0.1;
const CURL = 0.6;
const SCOUT = 80;

const COLOR_IMG = 56;

const HUE_WINDOWS = {
  white: [0, 1],
  ice: [0.635, 0.55],
  bone: [0.05, 0.115],
  ember: [0.95, 1.05],
  moss: [0.24, 0.46],
  viridis: [0.46, 0.24],
  inferno: [0.56, 0.82],
  magma: [0.66, 0.78],
  slate: [0.55, 0.66],
  lagoon: [0.45, 0.55],
};

function spineAt(t, ox1, oy1, ox2, oy2, out) {
  const s = 1 - t;
  const a = s * s * s;
  const b = 3 * s * s * t;
  const c = 3 * s * t * t;
  const d = t * t * t;
  out[0] = a * SPINE_P[0][0] + b * (SPINE_P[1][0] + ox1) + c * (SPINE_P[2][0] + ox2) + d * SPINE_P[3][0];
  out[1] = a * SPINE_P[0][1] + b * (SPINE_P[1][1] + oy1) + c * (SPINE_P[2][1] + oy2) + d * SPINE_P[3][1];
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
  const grids = [3, 5];
  const nrng = makeRng(Math.floor(p1 * 1000000007));
  const fields = grids.map((g) => {
    const f = new Float32Array(g * g);
    for (let i = 0; i < f.length; i++) f[i] = nrng();
    return f;
  });
  const sp = [];
  const pt = [0, 0];
  for (let k = 0; k <= 24; k++) {
    spineAt(k / 24, 0, 0, 0, 0, pt);
    sp.push(pt[0], pt[1]);
  }
  const M = sp.length / 2;
  for (let y = 0; y < n; y++) {
    const v = (y + 0.5) / n;
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) / n;
      const a1 = noiseAt(fields[0], grids[0], u, v);
      const a2 = noiseAt(fields[1], grids[1], u, v);
      let hue = from + (to - from) * v + (a1 - 0.5) * 0.03;
      if (hue < 0) hue = 0;
      else if (hue > 1) hue = 1;
      let d2 = 9;
      for (let k = 0; k < M; k++) {
        const dx = u - sp[k * 2];
        const dy = v - sp[k * 2 + 1];
        const dd = dx * dx + dy * dy;
        if (dd < d2) d2 = dd;
      }
      const sat = 0.42 + 0.16 * a2;
      const val = 0.075 + 0.06 * a1 + 0.16 * Math.exp(-d2 / 0.0032);
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

    this.spX = new Float32Array(SPINE_N);
    this.spY = new Float32Array(SPINE_N);
    this.ribs = new Float32Array(this.ribDefs.length * 6);
    this.ribLen = new Float32Array(this.ribDefs.length);
    this._pt = new Float32Array(2);

    this.iteration = 0;
    this.spawn();
  }

  _reseed(seed) {
    this.seed = seed;
    this.rng = makeRng(seed);
    this.p1 = this.rng() * TAU;
    const win = HUE_WINDOWS[this.palette] || HUE_WINDOWS.white;
    this.colorImage = buildColorImage(this.rng, COLOR_IMG, win[0], win[1], this.p1);
    const grng = makeRng((seed ^ 0x5f356495) >>> 0);
    this.ribDefs = [];
    for (let k = 1; k <= RIBS; k++) {
      const t = k / (RIBS + 1);
      for (let side = -1; side <= 1; side += 2) {
        this.ribDefs.push([
          t,
          side,
          (grng() * 2 - 1) * 0.12,
          1 + (grng() * 2 - 1) * 0.15,
          grng() * 0.1 + 0.04,
        ]);
      }
    }
  }

  _updateSources() {
    const W = this.W;
    const H = this.H;
    const m = Math.min(W, H);
    const ph = this.p1 + this.iteration * SWAY;
    const ox1 = Math.sin(ph) * BOW;
    const oy1 = Math.cos(ph * 0.83) * BOW * 0.8;
    const ox2 = -Math.sin(ph * 0.77 + 1.3) * BOW;
    const oy2 = -Math.cos(ph * 0.83 + 0.9) * BOW * 0.8;
    const spX = this.spX;
    const spY = this.spY;
    const pt = this._pt;
    for (let k = 0; k < SPINE_N; k++) {
      spineAt(k / (SPINE_N - 1), ox1, oy1, ox2, oy2, pt);
      spX[k] = pt[0] * W;
      spY[k] = pt[1] * H;
    }
    const ribs = this.ribs;
    const defs = this.ribDefs;
    const pad = 0.03 * m;
    let total = 0;
    for (let k = 0; k < defs.length; k++) {
      const def = defs[k];
      const t = def[0];
      const i0 = Math.max(1, Math.min(SPINE_N - 2, Math.round(t * (SPINE_N - 1))));
      const ax = spX[i0];
      const ay = spY[i0];
      let tx = spX[i0 + 1] - spX[i0 - 1];
      let ty = spY[i0 + 1] - spY[i0 - 1];
      const tl = Math.sqrt(tx * tx + ty * ty) || 1;
      tx /= tl;
      ty /= tl;
      const sweep = 0.35 + 0.25 * (1 - t);
      const ang = Math.atan2(ty, tx) + def[1] * (HALF_PI - sweep) + def[2] + BREATH * Math.sin(ph + t * 9);
      let L = LMAX * Math.pow(4 * t * (1 - t), 0.55) * def[3] * m;
      const dx = Math.cos(ang);
      const dy = Math.sin(ang);
      const txp = ax + dx * L;
      const typ = ay + dy * L;
      let sc = 1;
      if (txp > W - pad) sc = Math.min(sc, (W - pad - ax) / (txp - ax));
      else if (txp < pad) sc = Math.min(sc, (pad - ax) / (txp - ax));
      if (typ > H - pad) sc = Math.min(sc, (H - pad - ay) / (typ - ay));
      else if (typ < pad) sc = Math.min(sc, (pad - ay) / (typ - ay));
      if (sc < 1) L *= Math.max(0, sc);
      const o = k * 6;
      ribs[o] = ax;
      ribs[o + 1] = ay;
      ribs[o + 2] = dx * L;
      ribs[o + 3] = dy * L;
      ribs[o + 4] = tx * def[4] * L;
      ribs[o + 5] = ty * def[4] * L;
      this.ribLen[k] = L;
      total += L;
    }
    this.ribTotal = total;
    this.half = Math.max(1.2, this.spawnRadius * 0.35 * (m / 1000));
    this.cap = Math.max(this.sensorDist * 2, 0.052 * m);
  }

  _homePoint(i) {
    const k = this.homeNode[i];
    if (k === 0) {
      const fi = this.homeR[i] * (SPINE_N - 1);
      const i0 = fi | 0;
      const i1 = Math.min(SPINE_N - 1, i0 + 1);
      const f = fi - i0;
      this._hx = this.spX[i0] + (this.spX[i1] - this.spX[i0]) * f;
      this._hy = this.spY[i0] + (this.spY[i1] - this.spY[i0]) * f;
      return;
    }
    const o = (k - 1) * 6;
    const r = this.homeR[i];
    this._hx = this.ribs[o] + this.ribs[o + 2] * r + this.ribs[o + 4] * r * r;
    this._hy = this.ribs[o + 1] + this.ribs[o + 3] * r + this.ribs[o + 5] * r * r;
  }

  _place(i) {
    const { rng, W, H, x, y, heading, curl, blind } = this;
    this._homePoint(i);
    const half = this.half;
    x[i] = ((this._hx + (rng() * 2 - 1) * half) % W + W) % W;
    let py = this._hy + (rng() * 2 - 1) * half;
    y[i] = py < 1 ? 1 : py > H - 2 ? H - 2 : py;
    heading[i] = rng() * 360;
    curl[i] = (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 1.3);
    blind[i] = 0;
  }

  spawn() {
    this._updateSources();
    const nr = this.ribLen.length;
    for (let i = 0; i < this.num; i++) {
      const draw = this.rng();
      if (draw < SPINE_SHARE) {
        this.homeNode[i] = 0;
        this.homeR[i] = this.rng();
      } else {
        const u = ((draw - SPINE_SHARE) / (1 - SPINE_SHARE)) * this.ribTotal;
        let acc = 0;
        let k = nr - 1;
        for (let j = 0; j < nr; j++) {
          acc += this.ribLen[j];
          if (u < acc) {
            k = j;
            break;
          }
        }
        this.homeNode[i] = k + 1;
        this.homeR[i] = this.rng() * this.rng();
      }
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
