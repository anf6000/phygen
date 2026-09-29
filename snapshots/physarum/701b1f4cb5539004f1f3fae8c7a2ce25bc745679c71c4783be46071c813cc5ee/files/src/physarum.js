// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — compact physarum core: one pressed leaf.
//
// A petiole disk sits on the lower-left diagonal of the frame. Every agent
// spawns inside the disk and streams into the blade with a seeded heading
// spread around the leaf axis. The blade is fenced by a leaf profile: an
// agent whose next step would leave the blade stays put and turns back
// toward the leaf axis. Inside the blade no external field acts on a
// sensing agent: the trail is the only shared memory, and every vein is
// grown by the sensor ladder alone.
//
// The sensor ladder is the only steering while any sensor sees trail: hold
// when forward reads strongest, turn toward the stronger side ray, and take
// one seeded side when both side rays beat forward. Equal live readings hold
// the heading. Only when all three sensors read zero does a short blind
// wander act, and it acts only there: the scout keeps its heading with the
// seeded curl as a soft wobble, draws one short arc over virgin ground, and
// re-seeds on the web after a fixed run of blind steps. The re-seed joins a
// busy vein, so the venation stays one connected web that thickens, branches,
// merges, and reroutes while the blade keeps filling toward the tip.
//
// The trail RGBA carries the display color and the reuse count. Each visit
// adds a compressed step to alpha. Zero decay keeps every deposit: the
// petiole core and the busiest veins saturate toward the warm accent, the
// gaps between veins stay dark, and the frame outside the blade stays empty.
//
// Particle color comes from a generated map in one rust span, sampled at the
// deposit position. The hue drifts from deep crimson to burnt orange with
// the canvas height and a slow noise field. The renderer lifts the reuse
// stored in the alpha byte toward one warm ivory accent, so only the core
// and the busiest veins read warm; fresh fiber stays dim rust.
// ─────────────────────────────────────────────────────────────────────────────

export const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;

export const DEFAULTS = {
  num: 900,
  sensorAngle: 30,
  sensorDist: 22,
  rotAngle: 26,
  decay: 0,
  spawnRadius: 6,
  seed: 1337,
  palette: 'ember',
  speed: 2,
};

export const REFERENCE = { num: 4000, sensorAngle: 45, sensorDist: 10, rotAngle: 45, decay: 5 };

const BASE = [0.16, 0.78];
const TIP = [0.81, 0.235];
const BLADE = 0.42;
const TAPER = 0.85;
const BOW = 0.9;
const PETIOLE = 0.03;
const WALL_TURN = 42;
const SCOUT = 14;
const RECRUIT_ALPHA = 128;
const RECRUIT_TRIES = 16;

const COLOR_IMG = 56;

const HUE_WINDOWS = {
  white: [0, 1],
  ice: [0.46, 0.58],
  bone: [0.05, 0.115],
  ember: [0.95, 1.05],
  viridis: [0.46, 0.24],
  inferno: [0.58, 0.8],
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
    this._sp = new Float32Array(2);
    this._reseed(o.seed);

    this.trail = new Uint8Array(this.W * this.H * 4);

    this.x = new Float32Array(this.num);
    this.y = new Float32Array(this.num);
    this.heading = new Float32Array(this.num);
    this.cr = new Uint8Array(this.num);
    this.cg = new Uint8Array(this.num);
    this.cb = new Uint8Array(this.num);
    this.curl = new Float32Array(this.num);
    this.blind = new Uint8Array(this.num);

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
    const { W, H, _sp } = this;
    const bx = W * BASE[0];
    const by = H * BASE[1];
    const tx = W * TIP[0];
    const ty = H * TIP[1];
    const ax = tx - bx;
    const ay = ty - by;
    const len = Math.hypot(ax, ay);
    this._bx = bx;
    this._by = by;
    this._ux = ax / len;
    this._uy = ay / len;
    this._vx = -this._uy;
    this._vy = this._ux;
    this._len = len;
    this._invLen = 1 / len;
    this._axisDeg = this._headingOf(this._ux, this._uy);
    this._hwMax = Math.min(W, H) * BLADE * 0.5;
    _sp[0] = bx + this._ux * PETIOLE * len;
    _sp[1] = by + this._uy * PETIOLE * len;
  }

  _headingOf(dx, dy) {
    let hd = Math.atan2(dy, dx) / DEG2RAD;
    if (hd < 0) hd += 360;
    return hd;
  }

  _inside(px, py) {
    const rx = px - this._bx;
    const ry = py - this._by;
    const t = (rx * this._ux + ry * this._uy) * this._invLen;
    if (t <= 0 || t >= 1) return false;
    const e = rx * this._vx + ry * this._vy;
    if (e < -this._hwMax || e > this._hwMax) return false;
    const hw = this._hwMax * Math.pow(Math.sin(Math.PI * Math.pow(t, TAPER)), BOW);
    return e >= -hw && e <= hw;
  }

  _inward(px, py) {
    const rx = px - this._bx;
    const ry = py - this._by;
    let t = (rx * this._ux + ry * this._uy) * this._invLen;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const gx = this._bx + this._ux * t * this._len - px;
    const gy = this._by + this._uy * t * this._len - py;
    return this._headingOf(gx, gy);
  }

  _place(i) {
    const { rng, x, y, heading, curl, blind, _sp } = this;
    const rr = this.spawnRadius * Math.sqrt(rng());
    const ang = rng() * TAU;
    let px = _sp[0] + Math.cos(ang) * rr;
    let py = _sp[1] + Math.sin(ang) * rr;
    if (!this._inside(px, py)) {
      px = _sp[0];
      py = _sp[1];
    }
    x[i] = px;
    y[i] = py;
    let hd = this._axisDeg + (rng() - 0.5) * 110;
    if (hd < 0) hd += 360;
    else if (hd >= 360) hd -= 360;
    heading[i] = hd;
    curl[i] = (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 1.0);
    blind[i] = 0;
  }

  _recruit(i) {
    const { rng, W, H, x, y, heading, curl, blind } = this;
    for (let k = 0; k < RECRUIT_TRIES; k++) {
      const px = (rng() * W) | 0;
      const py = (rng() * H) | 0;
      if (this.trail[(py * W + px) * 4 + 3] >= RECRUIT_ALPHA) {
        x[i] = px + 0.5;
        y[i] = py + 0.5;
        heading[i] = rng() * 360;
        curl[i] = (rng() < 0.5 ? -1 : 1) * (0.5 + rng() * 1.0);
        blind[i] = 0;
        this._paint(i);
        return;
      }
    }
    this._place(i);
    this._paint(i);
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
      this.curl = new Float32Array(this.num);
      this.blind = new Uint8Array(this.num);
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
    const { W, H, num, trail, x, y, heading, cr, cg, cb, curl, blind, sensorDist, sensorAngle, rotAngle } = this;
    this._updateSources();
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
      if (f >= l && f >= r) trailTurn = 0;
      else if (f < l && f < r) trailTurn = this.rng() < 0.5 ? ra : -ra;
      else if (l > r) trailTurn = ra;
      else if (r > l) trailTurn = -ra;

      if (f === 0 && l === 0 && r === 0) {
        trailTurn += curl[i] * 0.3;
        const b = blind[i] + 1;
        if (b > SCOUT) {
          this._recruit(i);
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
      const nx = x[i] + Math.cos(a) * this.speed;
      const ny = y[i] + Math.sin(a) * this.speed;
      if (this._inside(nx, ny)) {
        x[i] = nx;
        y[i] = ny;
      } else {
        let dh = this._inward(nx, ny) - h;
        while (dh > 180) dh -= 360;
        while (dh < -180) dh += 360;
        h += Math.abs(dh) <= WALL_TURN ? dh : dh > 0 ? WALL_TURN : -WALL_TURN;
        if (h >= 360) h -= 360;
        else if (h < 0) h += 360;
        heading[i] = h;
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
