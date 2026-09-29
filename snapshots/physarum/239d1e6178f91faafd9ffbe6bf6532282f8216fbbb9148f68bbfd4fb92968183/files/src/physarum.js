// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — compact physarum core: one watershed colony.
//
// Six seeded headwater clusters sit across the top of the frame and one mouth
// sits low right. Every agent spawns inside one cluster with a heading toward
// the mouth and a seeded offset. An agent that sees no trail steers toward the
// mouth at a capped rate, so the flow gathers into streams that run from the
// headwaters down to the mouth. The big clusters feed thick trunks and the
// small clusters feed thin side channels, so the union of paths reads like a
// drainage network: many fine headwaters, fewer stems, one bright mouth. The
// clusters and the mouth drift on slow seeded sines, so the streams keep
// re-routing through the whole run.
//
// When trail enters the sensor cone, the sensor ladder takes control: hold
// when forward reads strongest, turn toward the stronger side ray, and take
// one seeded side when both side rays beat forward. The guide acts only when
// all three readings are zero. Equal readings inside a stream hold the
// heading, so agents ride a saturated channel in a straight line instead of
// looping. The guide can never pull an agent out of a live stream.
//
// The trail is the only shared memory. Its color bytes carry the display and
// its alpha byte carries path reuse. Each visit adds a compressed step. Agents
// sense that reuse ahead and on both side rays, turn toward the strongest
// reading, move, and deposit one full-opacity pixel. Zero decay keeps every
// deposit: the mouth and the busiest stems saturate, while the lower left and
// the corners stay quiet.
//
// Particle color comes from a generated noise map in the indigo span, a dark
// blue-to-violet range sampled at the deposit position. The renderer lifts
// the reuse stored in the alpha byte toward one pale gold accent, so only the
// mouth and the busiest stems read warm while fresh fiber stays dark.
// ─────────────────────────────────────────────────────────────────────────────

export const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;

export const DEFAULTS = {
  num: 460,
  sensorAngle: 30,
  sensorDist: 30,
  rotAngle: 12,
  decay: 0,
  spawnRadius: 24,
  seed: 1337,
  palette: 'inferno',
  speed: 2,
};

export const REFERENCE = { num: 4000, sensorAngle: 45, sensorDist: 10, rotAngle: 45, decay: 5 };

const MOUTH = [0.64, 0.87];
const MOUTH_REACH = 0.02;
const MOUTH_DRIFT = 0.012;
const MOUTH_W = [0.0011, 0.0014];
const CLUSTER_X = [0.09, 0.24, 0.4, 0.55, 0.7, 0.85];
const CLUSTER_Y = [0.14, 0.1, 0.18, 0.11, 0.16, 0.12];
const CLUSTER_W = [0.3, 0.22, 0.17, 0.13, 0.1, 0.08];
const CLUSTER_DRIFT = 0.024;
const CLUSTER_W1 = [0.0017, 0.0013, 0.0019, 0.0012, 0.0016, 0.0014];
const CLUSTER_W2 = [0.0012, 0.0018, 0.0011, 0.0016, 0.0013, 0.0019];
const SPAWN_TIGHT = 0.3;
const GUIDE_JET = 28;
const G_RATE = 2.4;

const COLOR_IMG = 56;

const HUE_WINDOWS = {
  white: [0, 1],
  ice: [0.46, 0.58],
  bone: [0.05, 0.13],
  ember: [0.95, 1.05],
  viridis: [0.44, 0.31],
  inferno: [0.58, 0.8],
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
    this._sp = new Float32Array(14);
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
    this.hphase = new Float32Array(14);
    for (let k = 0; k < 14; k++) this.hphase[k] = this.rng() * TAU;
  }

  _updateSources() {
    const { W, H, _sp, hphase } = this;
    const cm = CLUSTER_DRIFT * Math.min(W, H);
    const mm = MOUTH_DRIFT * Math.min(W, H);
    const it = this.iteration;
    _sp[0] = W * MOUTH[0] + mm * Math.sin(it * MOUTH_W[0] + hphase[0]);
    _sp[1] = H * MOUTH[1] + mm * Math.cos(it * MOUTH_W[1] + hphase[1]);
    for (let k = 0; k < CLUSTER_X.length; k++) {
      _sp[2 + k * 2] = W * CLUSTER_X[k] + cm * Math.sin(it * CLUSTER_W1[k] + hphase[2 + k * 2]);
      _sp[3 + k * 2] = H * CLUSTER_Y[k] + cm * Math.cos(it * CLUSTER_W2[k] + hphase[3 + k * 2]);
    }
  }

  _pickCluster() {
    const r = this.rng();
    let acc = 0;
    for (let k = 0; k < CLUSTER_W.length; k++) {
      acc += CLUSTER_W[k];
      if (r < acc) return k;
    }
    return CLUSTER_W.length - 1;
  }

  _place(i) {
    const { rng, W, H, x, y, heading, _sp } = this;
    const k = this._pickCluster();
    const sf = Math.sqrt(CLUSTER_W[k] / CLUSTER_W[0]);
    const rr = this.spawnRadius * (SPAWN_TIGHT + (1 - SPAWN_TIGHT) * sf) * Math.sqrt(rng());
    const ang = rng() * TAU;
    let px = _sp[2 + k * 2] + Math.cos(ang) * rr;
    let py = _sp[3 + k * 2] + Math.sin(ang) * rr;
    if (px < 0) px = 0;
    else if (px > W - 1) px = W - 1;
    if (py < 0) py = 0;
    else if (py > H - 1) py = H - 1;
    x[i] = px;
    y[i] = py;
    const want = Math.atan2(_sp[1] - py, _sp[0] - px) / DEG2RAD;
    heading[i] = want + (rng() - 0.5) * 2 * GUIDE_JET;
  }

  spawn() {
    this._updateSources();
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
    this._updateSources();
    const sp = this._sp;
    const reach = MOUTH_REACH * Math.min(W, H);
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
      if (f === 0 && l === 0 && r === 0) {
        const want = Math.atan2(sp[1] - y[i], sp[0] - x[i]) / DEG2RAD;
        const d = (((want - h) % 360) + 540) % 360 - 180;
        trailTurn = d > G_RATE ? G_RATE : d < -G_RATE ? -G_RATE : d;
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
        if (Math.abs(x[i] - sp[0]) < reach && Math.abs(y[i] - sp[1]) < reach) {
          this._place(i);
        }
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
