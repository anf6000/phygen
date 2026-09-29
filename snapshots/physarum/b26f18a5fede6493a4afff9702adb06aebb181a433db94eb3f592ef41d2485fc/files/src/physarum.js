// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — compact physarum core: one triangular colony, "the cairn".
//
// The colony is one organism: every agent owns a home point inside a tall
// scalene triangle, spawns there, and its home angle drifts around the
// triangle centre on a very slow shared swirl, so the traffic pattern keeps
// re-forming without ever stopping. The sensor ladder is the only steer on
// trail: hold when forward reads strongest, turn toward the stronger side ray,
// and take one seeded side when both side rays beat forward. Equal live
// readings hold the heading; the home pull acts only when all three sensors
// read zero, so trail feedback decides every visible path and the guide can
// never override it. A blind agent keeps one gentle seeded curl, so one
// excursion lays one short curved bud near the web edge, and an early return
// run keeps long blind arcs out of the quiet margins. Buds that touch the web
// are found by other agents and thicken into new cords, so the union grows as
// a fine net inside the triangle, with one fused bright core where traffic
// concentrates, a graded skirt toward the base, and wide quiet margins near
// the frame edges. Agents that leave the frame, and agents that stay blind
// past a fixed run, return to their home point.
//
// The trail RGBA carries the display color and the reuse count. Zero decay
// keeps every deposit: the core saturates first and the renderer lifts it
// toward one pale blue accent, while cord and fray pixels keep their dim map
// color. The map is warmest and brightest near the colony centre and cools
// toward the frontier, so related forms share related colors.
//
// Particle color comes from a generated map in one ember-gold span, sampled
// at the deposit position.
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
  palette: 'bone',
  speed: 2,
};

export const REFERENCE = { num: 4000, sensorAngle: 45, sensorDist: 10, rotAngle: 45, decay: 5 };

const TRI = [
  [0.46, 0.15],
  [0.13, 0.87],
  [0.85, 0.82],
];
const TRI_CX = (TRI[0][0] + TRI[1][0] + TRI[2][0]) / 3;
const TRI_CY = (TRI[0][1] + TRI[1][1] + TRI[2][1]) / 3;
const SWIRL = 0.0004;
const PULL = 0.1;
const CURL = 0.6;
const SCOUT = 80;

const COLOR_IMG = 56;

const HUE_WINDOWS = {
  white: [0, 1],
  ice: [0.4, 0.48],
  bone: [0.05, 0.115],
  ember: [0.95, 1.05],
  viridis: [0.46, 0.24],
  inferno: [0.56, 0.82],
  magma: [0.72, 1.06],
  slate: [0.55, 0.66],
  lagoon: [0.45, 0.55],
};

const TRI_EDGES = (() => {
  const edges = [];
  for (let k = 0; k < 3; k++) {
    const p = TRI[k];
    const q = TRI[(k + 1) % 3];
    let nx = q[1] - p[1];
    let ny = p[0] - q[0];
    const nl = Math.hypot(nx, ny) || 1;
    nx /= nl;
    ny /= nl;
    if (nx * (p[0] - TRI_CX) + ny * (p[1] - TRI_CY) < 0) {
      nx = -nx;
      ny = -ny;
    }
    edges.push([nx, ny, nx * (p[0] - TRI_CX) + ny * (p[1] - TRI_CY)]);
  }
  return edges;
})();

function triR(dx, dy) {
  let r = Infinity;
  for (let k = 0; k < 3; k++) {
    const e = TRI_EDGES[k];
    const dn = dx * e[0] + dy * e[1];
    if (dn > 1e-9) {
      const t = e[2] / dn;
      if (t < r) r = t;
    }
  }
  return r;
}

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
      const dx = u - TRI_CX;
      const dy = v - TRI_CY;
      const r = triR(dx, dy);
      const rho = Math.sqrt(dx * dx + dy * dy) / r;
      const t = Math.min(1, rho * 0.9 + (a1 - 0.5) * 0.45 + 0.08);
      const hue = from + (to - from) * t;
      const sat = 0.36 + 0.16 * a2;
      const val = 0.13 + 0.15 * a1 + 0.1 * Math.max(0, 1 - Math.min(rho, 1));
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
    this.homeA = new Float32Array(this.num);
    this.homeR = new Float32Array(this.num);

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
    const W = this.W;
    const H = this.H;
    const m = Math.min(W, H);
    const s = m / 1000;
    this.tcx = TRI_CX * W;
    this.tcy = TRI_CY * H;
    this.tE = [];
    for (let k = 0; k < 3; k++) {
      const p = TRI[k];
      const q = TRI[(k + 1) % 3];
      const px = p[0] * W;
      const py = p[1] * H;
      let nx = (q[1] - p[1]) * H;
      let ny = (p[0] - q[0]) * W;
      const nl = Math.hypot(nx, ny) || 1;
      nx /= nl;
      ny /= nl;
      if (nx * (px - this.tcx) + ny * (py - this.tcy) < 0) {
        nx = -nx;
        ny = -ny;
      }
      this.tE.push([nx, ny, nx * (px - this.tcx) + ny * (py - this.tcy)]);
    }
    this.half = Math.max(1.2, this.spawnRadius * 0.35 * s);
    this.cap = Math.max(this.sensorDist * 3, 0.09 * m);
  }

  _homePoint(i) {
    const a = this.homeA[i];
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    const E = this.tE;
    let r = Infinity;
    for (let k = 0; k < 3; k++) {
      const e = E[k];
      const dn = dx * e[0] + dy * e[1];
      if (dn > 1e-9) {
        const t = e[2] / dn;
        if (t < r) r = t;
      }
    }
    const rad = this.homeR[i] * r;
    this._hx = this.tcx + dx * rad;
    this._hy = this.tcy + dy * rad;
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
    for (let i = 0; i < this.num; i++) {
      this.homeA[i] = this.rng() * TAU;
      this.homeR[i] = Math.sqrt(this.rng());
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
      this.homeA = new Float32Array(this.num);
      this.homeR = new Float32Array(this.num);
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
    const { W, H, num, trail, x, y, heading, cr, cg, cb, curl, blind, homeA,
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
      let ha = homeA[i] + SWIRL;
      if (ha >= TAU) ha -= TAU;
      homeA[i] = ha;
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
