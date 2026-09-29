// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — compact physarum core: one terraced colony with a dry basin.
//
// The colony is a stack of horizontal terraces in the lower part of the frame.
// Each agent owns a home point on one lane: it spawns there, weaves the local
// trail, and its home point drifts along the lane, so fresh deposits sweep the
// whole terrace over time. Each lane undulates on its own slow sine and the
// lanes bend around one elliptical basin right of centre, so the terraces
// read as contour lines that skirt an interior void and compress at its rim.
// The sensor ladder is the only steer on trail: hold when forward reads
// strongest, turn toward the stronger side ray, and take one seeded side when
// both side rays beat forward. Equal live readings hold the heading. Only when
// all three sensors read zero does a weak pull toward the home point act, so
// each excursion lays one gently curved thread near its lane. Threads that
// meet the terrace join its traffic, and side rays from a dense lane reach the
// next lane and lay the diagonal links between terraces. Lower lanes hold the
// most agents and fuse into one bright plain; upper lanes hold few and stay
// thin; the sky above the field and the basin interior stay quiet. The basin
// radius swells and settles a few percent on a slow sine, so the rim keeps
// flexing and the field keeps re-forming. Agents that leave the frame, and
// agents that stay blind past a fixed run, return to their home stretch.
//
// The trail RGBA carries the display color and the reuse count. Zero decay
// keeps every deposit: the fused plain, the master lane and the basin rim
// saturate first and the renderer lifts them toward one warm apricot accent,
// while the upper terraces and the rare blind arcs keep their dim map color.
//
// Particle color comes from a generated map in one bone-to-tan span, sampled
// at the deposit position.
// ─────────────────────────────────────────────────────────────────────────────

export const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;

export const DEFAULTS = {
  num: 900,
  sensorAngle: 30,
  sensorDist: 22,
  rotAngle: 26,
  decay: 0,
  spawnRadius: 11,
  seed: 1337,
  palette: 'ice',
  speed: 2,
};

export const REFERENCE = { num: 4000, sensorAngle: 45, sensorDist: 10, rotAngle: 45, decay: 5 };

const FIELD_TOP = 0.42;
const FIELD_BOTTOM = 0.94;
const GAP0 = 0.012;
const GAP_GROW = 1.18;
const GAP_MAX = 0.075;
const BASIN_X = 0.62;
const BASIN_Y = 0.52;
const BASIN_R = 0.15;
const BREATH = 0.06;
const BREATH_W = TAU / 1400;
const PULL = 0.09;
const CURL = 0.15;
const SCOUT = 380;

const COLOR_IMG = 56;

const HUE_WINDOWS = {
  white: [0, 1],
  ice: [0.46, 0.575],
  bone: [0.05, 0.115],
  ember: [0.95, 1.05],
  viridis: [0.46, 0.24],
  inferno: [0.56, 0.82],
  magma: [0.72, 1.06],
  slate: [0.55, 0.66],
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
  const grids = [2, 3, 5];
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
      const mix = v * 0.38 + a1 * 0.14 + a2 * 0.24 + a3 * 0.24;
      const hue = from + (to - from) * mix;
      const sat = 0.42 + 0.26 * a3;
      const val = 0.2 + 0.26 * (a2 * 0.45 + a3 * 0.55);
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
    this.cr = new Uint8Array(this.num);
    this.cg = new Uint8Array(this.num);
    this.cb = new Uint8Array(this.num);
    this.curl = new Float32Array(this.num);
    this.blind = new Uint16Array(this.num);
    this.homeX = new Float32Array(this.num);
    this.lane = new Uint8Array(this.num);
    this.drift = new Float32Array(this.num);

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

  _updateSources() {
    const s = Math.min(this.W, this.H) / 1000;
    this.laneHalf = Math.max(1.5, this.spawnRadius * 0.38 * s);
    this.cap = Math.max(12, this.laneHalf * 6);
  }

  _buildLanes() {
    const rng = this.rng;
    const base = [];
    let y = FIELD_BOTTOM;
    let gap = GAP0;
    while (y > FIELD_TOP) {
      base.push(y);
      y -= gap;
      gap = Math.min(GAP_MAX, gap * GAP_GROW);
    }
    const nL = base.length;
    this.laneBase = base;
    this.laneAmp = new Float32Array(nL);
    this.laneFreq = new Float32Array(nL);
    this.lanePhase = new Float32Array(nL);
    const w = new Float32Array(nL);
    for (let k = 0; k < nL; k++) {
      this.laneAmp[k] = 0.004 + rng() * 0.016;
      this.laneFreq[k] = 1 + Math.floor(rng() * 3);
      this.lanePhase[k] = rng() * TAU;
      w[k] = Math.pow(0.85, k);
    }
    this.masterLane = Math.min(nL - 1, 8);
    w[this.masterLane] *= 2.2;
    let wsum = 0;
    for (let k = 0; k < nL; k++) wsum += w[k];
    this.lanePick = new Float32Array(nL);
    let acc = 0;
    for (let k = 0; k < nL; k++) {
      acc += w[k] / wsum;
      this.lanePick[k] = acc;
    }
  }

  _laneY(k, x) {
    const W = this.W;
    const H = this.H;
    let y = this.laneBase[k] * H
      + this.laneAmp[k] * H * Math.sin(TAU * this.laneFreq[k] * x / W + this.lanePhase[k]);
    const bx = BASIN_X * W;
    const by = BASIN_Y * H;
    let dx = x - bx;
    if (dx < 0) dx = -dx;
    if (dx > W - dx) dx = W - dx;
    const dy = y - by;
    const d = Math.sqrt(dx * dx + dy * dy);
    const R = BASIN_R * Math.min(W, H) * (1 + BREATH * Math.sin(BREATH_W * this.iteration));
    if (d < R && d > 0.001) {
      const push = R - d;
      const t = push / R;
      y += (dy >= 0 ? 1 : -1) * push * (1.7 - 0.7 * t);
    }
    return y;
  }

  _place(i) {
    const { rng, W, H, x, y, heading, curl, blind, homeX } = this;
    const half = this.laneHalf;
    const hx = homeX[i];
    const ly = this._laneY(this.lane[i], hx);
    x[i] = ((hx + (rng() * 2 - 1) * half * 2) % W + W) % W;
    let py = ly + (rng() * 2 - 1) * half;
    y[i] = py < 1 ? 1 : py > H - 2 ? H - 2 : py;
    heading[i] = (rng() < 0.5 ? 0 : 180) + (rng() * 2 - 1) * 14;
    curl[i] = (rng() < 0.5 ? -1 : 1) * (0.3 + rng() * 0.6);
    blind[i] = 0;
  }

  spawn() {
    this._updateSources();
    this._buildLanes();
    for (let i = 0; i < this.num; i++) {
      const u = this.rng();
      let k = 0;
      while (k < this.lanePick.length - 1 && u > this.lanePick[k]) k++;
      this.lane[i] = k;
      this.homeX[i] = this.rng() * this.W;
      this.drift[i] = (this.rng() < 0.5 ? -1 : 1) * (0.1 + this.rng() * 0.35);
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
      this.homeX = new Float32Array(this.num);
      this.lane = new Uint8Array(this.num);
      this.drift = new Float32Array(this.num);
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
      this.homeX[i] = ((this.homeX[i] % W) + W) % W;
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
    const { W, H, num, trail, x, y, heading, cr, cg, cb, curl, blind, homeX, lane, drift,
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
      let hx = homeX[i] + drift[i];
      if (hx < 0) hx += W;
      else if (hx >= W) hx -= W;
      homeX[i] = hx;
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
        const hy = this._laneY(lane[i], hx);
        const dx = x[i] - hx;
        const dy = y[i] - hy;
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
