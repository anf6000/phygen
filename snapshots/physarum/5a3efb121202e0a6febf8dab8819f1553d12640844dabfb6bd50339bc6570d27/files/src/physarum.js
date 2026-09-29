// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — compact physarum core: one colony, five grounds.
//
// The colony is one population with five home grounds. One large root ground
// sits left of center; four smaller grounds are placed around it by the seed.
// Each agent belongs to one ground and spawns in its pad with a random
// heading. An agent that sees no trail steers gently toward its home ground
// and keeps its own seeded meander; the pull is strong near home and weak far
// out, so excursions reach the open field between grounds. When trail enters
// the sensor cone, the sensor ladder takes control: hold when forward reads
// strongest, turn toward the stronger side ray, and take one seeded side when
// both side rays beat forward. The guide acts only when all three readings
// are zero, so equal readings inside a tube hold the heading and the network
// keeps itself. Excursions from all grounds cross, follow each other, and
// bind into tubes; the heaviest traffic runs through the root, so the root
// and its main roads read brightest while the outer towns stay quieter.
//
// The sense scale runs with the distance from home. Near a ground, short
// sensors, wide cones and large turns weave a fine knot. Farther out, long
// sensors and small turns lock strands together, so the field condenses into
// fewer, thicker roads between grounds while the piece runs. The trail is the
// only shared memory. Its color bytes carry the display and its alpha byte
// carries path reuse: each visit adds a compressed step. Agents sense that
// reuse ahead and on both side rays, turn toward the strongest reading, move,
// and deposit one full-opacity pixel. Zero decay keeps every deposit: the
// grounds and the main roads saturate, and the corners and margins stay quiet.
//
// Particle color comes from a generated noise map in the bone family, a dark
// amber-to-tan span sampled at the deposit position. The renderer lifts the
// reuse stored in the alpha byte toward one pale gold accent, so the root and
// the busiest roads read pale and warm while fresh fiber stays dark.
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
  palette: 'bone',
  speed: 2,
};

export const REFERENCE = { num: 4000, sensorAngle: 45, sensorDist: 10, rotAngle: 45, decay: 5 };

const BASIN_N = 5;
const ROOT_X = 0.34;
const ROOT_Y = 0.45;
const MARGIN = 0.12;
const KEEP_OUT = 0.13;
const REACH_FRAC = 0.42;
const GD_NEAR = 1.6;
const GD_FAR = 0.55;
const MW_FREQ = 0.01;
const MW_FREQ_RANGE = 0.024;
const MW_AMP = 0.07;
const MW_AMP_RANGE = 0.11;
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
    this.home = new Uint8Array(this.num);

    this._layout();
    this._setBasins();
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

  _layout() {
    const { W, H, rng } = this;
    const unit = Math.min(W, H);
    const margin = MARGIN * unit;
    const keep = KEEP_OUT * unit;
    const ax = ROOT_X * W;
    const ay = ROOT_Y * H;
    const rx = [ax];
    const ry = [ay];
    const rs = [1];
    for (let k = 1; k < BASIN_N; k++) {
      let px = ax;
      let py = ay;
      for (let t = 0; t < 80; t++) {
        const ang = rng() * TAU;
        const rad = (0.15 + 0.21 * rng()) * unit;
        px = ax + Math.cos(ang) * rad;
        py = ay + Math.sin(ang) * rad;
        let ok = px > margin && px < W - margin && py > margin && py < H - margin;
        for (let j = 0; j < k && ok; j++) {
          const dx = px - rx[j];
          const dy = py - ry[j];
          ok = Math.sqrt(dx * dx + dy * dy) > keep;
        }
        if (ok) break;
      }
      rx.push(px);
      ry.push(py);
      rs.push(0.45 + 0.45 * rng());
    }
    let total = 0;
    for (let k = 0; k < BASIN_N; k++) total += rs[k];
    this.brx = new Float32Array(BASIN_N);
    this.bry = new Float32Array(BASIN_N);
    this.bsize = new Float32Array(BASIN_N);
    this.pick = new Float32Array(BASIN_N);
    let acc = 0;
    for (let k = 0; k < BASIN_N; k++) {
      this.brx[k] = rx[k] / W;
      this.bry[k] = ry[k] / H;
      this.bsize[k] = rs[k];
      acc += rs[k] / total;
      this.pick[k] = acc;
    }
  }

  _setBasins() {
    this.bx = new Float32Array(BASIN_N);
    this.by = new Float32Array(BASIN_N);
    for (let k = 0; k < BASIN_N; k++) {
      this.bx[k] = this.brx[k] * this.W;
      this.by[k] = this.bry[k] * this.H;
    }
    this.reach = REACH_FRAC * Math.min(this.W, this.H);
  }

  _pickHome() {
    const u = this.rng();
    for (let k = 0; k < BASIN_N - 1; k++) {
      if (u < this.pick[k]) return k;
    }
    return BASIN_N - 1;
  }

  _progress(i) {
    const b = this.home[i];
    const dx = this.x[i] - this.bx[b];
    const dy = this.y[i] - this.by[b];
    const r = Math.sqrt(dx * dx + dy * dy) / this.reach;
    return r < 0 ? 0 : r > 1 ? 1 : r;
  }

  _place(i) {
    const { rng, W, H } = this;
    const b = this.home[i];
    const padR = this.spawnRadius * (0.4 + 0.6 * this.bsize[b]);
    const ang = rng() * TAU;
    const rr = padR * Math.sqrt(rng());
    let px = this.bx[b] + Math.cos(ang) * rr;
    let py = this.by[b] + Math.sin(ang) * rr;
    if (px < 0) px = 0;
    else if (px > W - 1) px = W - 1;
    if (py < 0) py = 0;
    else if (py > H - 1) py = H - 1;
    this.x[i] = px;
    this.y[i] = py;
    this.heading[i] = rng() * 360;
    const freq = MW_FREQ + MW_FREQ_RANGE * rng();
    this.bend[i] = (MW_AMP + MW_AMP_RANGE * rng()) * (rng() < 0.5 ? -1 : 1);
    this.wPhase[i] = rng() * TAU;
    this.wFreq[i] = freq;
  }

  spawn() {
    for (let i = 0; i < this.num; i++) {
      this.home[i] = this._pickHome();
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
      this.home = new Uint8Array(this.num);
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
    this._setBasins();
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
        const b = this.home[i];
        const want = Math.atan2(this.by[b] - y[i], this.bx[b] - x[i]) / DEG2RAD;
        const d = (((want - h) % 360) + 540) % 360 - 180;
        const rate = GD_NEAR + (GD_FAR - GD_NEAR) * m;
        trailTurn = (d > rate ? rate : d < -rate ? -rate : d)
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
