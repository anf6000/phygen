// ─────────────────────────────────────────────────────────────────────────────
// physarum.js — faithful CPU port of the p5 sketch (../p5js/physarum.js).
//
// The reference sketch, ported line-for-line:
//
//   setup()   createCanvas(windowWidth, windowHeight); angleMode(DEGREES)
//             num = 4000 molds, spawned in a 40×40 px box at the canvas centre
//   draw()    background(0, 5)                       → fade the trail
//             loadPixels()                           → snapshot the trail
//             for each mold: update() ; display()    → sense snapshot, steer,
//                                                      move, deposit a white dot
//
// The only structural change is that the p5 *canvas* (which doubled as the
// trail buffer) is replaced by a plain Uint8Array `trail`, and agents are held
// in typed arrays instead of 4000 objects. Everything else — the sensor
// offsets, the steering table, the wrap-around modulo, the 8-bit fade — is the
// same maths, in the same order, so a seeded run is reproducible.
//
// Two p5 details that are easy to get wrong and are preserved here:
//
//  1. `pixels` is a *snapshot* taken after the fade and before any mold is
//     drawn. Deposits made during a frame are therefore not visible to other
//     molds until the next frame. step() reproduces this with a two-pass loop
//     (sense/steer/move for everyone, then deposit for everyone).
//  2. Agents move *before* they sense. update() integrates the position first
//     and only then calls getSensorPos(), so the sensors read from the new
//     position but the old heading.
// ─────────────────────────────────────────────────────────────────────────────

/** p5 angleMode(DEGREES) — every angle in this file is in degrees. */
export const DEG2RAD = Math.PI / 180;
const TAU = Math.PI * 2;

/** Defaults = the literal constants of the p5 sketch. */
export const DEFAULTS = {
  // simulation (same names/units as the sketch)
  num: 4000, //            4000 molds
  sensorAngle: 45, //      this.sensorAngle
  sensorDist: 10, //       this.sensorDist
  rotAngle: 45, //         this.rotAngle
  decay: 6, //             background(0, decay) alpha, 0…255
  spawnRadius: 20, //      random(w/2 - 20, w/2 + 20)
  seed: 1337,
  palette: 'inferno',
  swirl: 0.8, //           tangential speed at the frame edge, px per step
};

/** Number of entries in the generated color map. */
const COLOR_BINS = 128;

/** Deposit weight per cell of a hard-edged 3×3 brush. */
const BRUSH = new Float32Array([1, 1, 1, 1, 1, 1, 1, 1, 1]);

const BRUSH5 = (() => {
  const b = new Float32Array(25);
  for (let i = 0; i < 25; i++) b[i] = 1;
  return b;
})();

const FLOW_GRID = 24;
const WIND_TURN = 2.6;
const COLOR_DRIFT = 0.06;
const COLOR_TERR = 4;
const SPIRAL_TURNS = 0.22;
const SPIRAL_TURN = 5;
const SPIRAL_CORE = 70;
const SPIRAL_FLOOR = 0.3;
const SPIRAL_PULSE = 0.0022;
const SPIRAL_WARP = 0.12;
const TERR_SPIN = 0.0009;
const TERR_PHASE = 0.004;
const TERR_JITTER = 30;
const COLOR_IMG = 40;
const COLOR_LATTICE = 6;
const COLOR_BANDS = 6;
const VALUE_BANDS = 2;
const PIGMENT_GRID = 9;
const BRAID_GRID = 11;
const BRAID_PROBE = 0.09;
const BRAID_TURN = 4;
const BRAID_SPIN = 2;
const RAIL_MIN = 0.9;
const RAIL_MAX = 3.6;
const RAIL_SHARE = 0.6;
const AUR_GRID = 4;
const AUR_FLOOR = 0.32;
const AUR_PROBE = 0.12;
const AUR_SLOPE = 0.12;
const AUR_TURN = 3.2;
const LIFE_MIN = 240;
const LIFE_MAX = 760;
const AGE_FLOOR = 0.55;
const AGE_WIDE = 0.5;
const AGE_FAST = 0.4;
const AGE_HUE = 0.16;
const AGE_AGILE = 0.7;
const WEIGHT_FLOOR = 0.6;
const HAIRLINE_MAX = 0.45;
const RIBBON_MIN = 0.9;
const TRAVEL_MIN = 0.0006;
const TRAVEL_MAX = 0.0024;
const STREAK_TAPS = 4;
const STREAK_STEP = 2;
const STREAK_FALL = 0.75;
const STREAK_NORM = [0.68, 0.5];
const ARC_CURL = 0.72;
const ARC_FLOOR = 0.4;
const ARC_SWING = 0.55;
const ARC_SWING_RATE = 2.4;
const ARC_SOFT = 26;
const ARC_REVERSE = 0.45;
const RIB_LOW = 0.08;
const RIB_HIGH = 0.3;
const WELL_COUNT = 7;
const WELL_MIN = 0.12;
const WELL_MAX = 0.34;
const WELL_TURN = 4;
const WELL_PULL = 0.9;
const WELL_DRIFT = 0.00055;
const WELL_BREATH = 0.22;
const WELL_PULSE = 0.0055;
const STRAND_PROBE = 5;
const STRAND_MIN = 0.02;
const STRAND_FULL = 0.12;
const STRAND_TURN = 6;
const CHARGE_FOLLOW = 0.05;
const CHARGE_FLOOR = 0.1;
const FLARE_GAIN = 0.95;
const WHITE_MIX = 0.14;
const DIFFUSE = 0.34;
const DIFFUSE_BIAS = 0.22;
const DIFFUSE_SPIN = 0.004;
const CHROMA_PULL = 0.85;
const CHROMA_FLOOR = 18;
const SLOW_DENSE = 0.45;
const WEIGHT_CEIL = 0.95;
const MEM_GRID = 48;
const MEM_KEEP = 0.995;
const MEM_DIFF = 0.28;
const MEM_DEPOSIT = 0.05;
const MEM_PROBE = 8;
const MEM_SLOPE = 0.003;
const MEM_TURN = 1.5;
const MEM_LIFT = 0.35;
const MEM_REF_FOLLOW = 0.05;
const MEM_REF_CEIL = 2.2;
const MEM_SEED = 977;
const LATTICE_K = TAU / 58;
const LATTICE_SPIN = 0.0011;
const LATTICE_DRIFT = 0.005;
const LATTICE_PULSE = 0.0034;
const LATTICE_MIN = 0.18;
const LATTICE_TURN = 7;
const LATTICE_EDGE = 0.3;
const LATTICE_GAIN = 0.5;
const GRAZE_GRID = 5;
const GRAZE_SHARE = 0.6;
const GRAZE_FLOOR = 0.35;
const GRAZE_MAX = 1;
const GRAZE_LO = 0.48;
const GRAZE_HI = 0.72;
const GRAZE_BITE = 0.17;
const GRAZE_DEPTH = 0.24;
const GRAZE_PAINT = 0.7;
const GRAZE_CLIMB = 0.25;
const MIRROR_BASE = 0.82;
const MIRROR_SWING = 0.4;
const SHEAR_AMP = 0.07;
const SHEAR_WAVE = 2;
const SHEAR_RATE = 0.007;
const SHEAR_TURN = 3;
const SHEAR_GLOW = 0.45;
const SHEAR_FLOOR = 0.8;
const DISP_BLUE = 0.72;
const PRISM_GRID = 8;
const PRISM_MIN = 0.6;
const PRISM_MAX = 2.6;
const PRISM_FLOOR = 0.7;
const PRISM_CHARGE = 0.9;
const PRISM_SLOW = 0.004;
const PRISM_CEIL = 3.8;
const GRAZE_TAPS = 4;
const GRAZE_STEP = 3;
const GRAZE_FALL = 0.65;
const TIDE_BANDS = 3;
const TIDE_RATE = 0.0085;
const TIDE_AMP = 0.5;
const TIDE_SURF = 0.9;
const TIDE_GLIDE = 0.5;
const TIDE_HUE = 0.16;
const EDDY_GRID = 6;
const EDDY_SPIN = 0.0009;
const EDDY_ORBIT = 0.1;
const EDDY_RING = 0.34;
const EDDY_PULL = 0.8;
const EDDY_MAX = 8;
const EDDY_FALL = 1.6;
const EDDY_SHARE = 0.72;
const EDDY_PULSE = 0.0042;
const EDDY_FLOOR = 0.3;
const EDDY_HUE = 0.1;
const EDDY_RING_HUE = 0.12;
const EDDY_HUE_SPIN = 0.0006;
const EDDY_ARM = 0.7;
const EDDY_CORE = 0.55;
const GYRE_GRID = 5;
const GYRE_SPIN = 0.0007;
const GYRE_SEP = 0.26;
const GYRE_CORE = 150;
const GYRE_TURN = 8;
const GYRE_PULSE = 0.0016;
const GYRE_FLOOR = 0.32;
const GYRE_SHARE = 0.78;
const GYRE_GLOW = 0.55;
const GYRE_HUE = 0.1;
const MAG_GRID = 7;
const MAG_SPIN = 0.0016;
const MAG_TURN = 3.4;
const MAG_TILT = 90;
const MAG_STRETCH = 4;
const MAG_PAINT = 0.3;
const MAG_FLOOR = 0.04;
const INV255 = 1 / 255;
const WALL_MARGIN = 0.085;
const WALL_TURN = 11;
const TORSION_GRID = 6;
const TORSION_TURN = 3.6;
const TORSION_PITCH = 0.6;
const TORSION_K = 0.02;
const TORSION_SPIN = 0.004;
const TORSION_CORE = 60;
const TORSION_GLOW = 0.45;
const GRAZE_BRUSH_R = 2;
const GRAZE_BRUSH_SIDE = GRAZE_BRUSH_R * 2 + 1;
const GRAZE_BRUSH = (() => {
  const s = GRAZE_BRUSH_SIDE;
  const b = new Float32Array(s * s);
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      const dx = (x - GRAZE_BRUSH_R) / GRAZE_BRUSH_R;
      const dy = (y - GRAZE_BRUSH_R) / GRAZE_BRUSH_R;
      const f = 1 - Math.sqrt(dx * dx + dy * dy);
      b[y * s + x] = f > 0 ? f * f : 0;
    }
  }
  return b;
})();

const DRIP_GRID = 7;
const DRIP_FALL = 5.5;
const DRIP_SOFT = 9;
const DRIP_SIDE = 0.5;
const DRIP_GROW = 1.1;
const DRIP_TURN = 1.1;
const DRIP_WET = 0.6;

/** Hue window (0…1 of the wheel) that each palette name opens. */
const HUE_WINDOWS = {
  white: [0, 1],
  bone: [0.06, 0.2],
  ice: [0.44, 0.68],
  ember: [0.86, 1.12],
  viridis: [0.24, 0.62],
  inferno: [0.74, 1.24],
  magma: [0.72, 1.06],
};

/**
 * p5's `random()` is Math.random(); we want reproducible runs, so the sketch's
 * RNG is replaced by a seeded one. mulberry32 — small, fast, good enough.
 */
export function makeRng(seed = 0) {
  let a = (Math.floor(seed) || 0) >>> 0;
  return function rng() {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * An 8-bit "multiply by (1 - alpha/255)" table.
 * Equivalent to compositing rgba(0,0,0,alpha) over the trail once per frame,
 * i.e. p5's `background(0, decay)`.
 */
export function buildDecayLUT(alpha) {
  const a = Math.max(0, Math.min(255, Math.round(alpha)));
  const lut = new Uint8Array(256);
  const keep = (255 - a) / 255;
  for (let i = 0; i < 256; i++) lut[i] = Math.round(i * keep);
  return lut;
}

/**
 * Generate a color map: `bins` saturated samples inside the hue window
 * [from, to], with three brightness bands across the map for contrast.
 * Every agent samples one entry, so the color is per particle.
 */
export function buildColorMap(bins, from, to) {
  const map = new Uint8Array(bins * 3);
  const rgb = [0, 0, 0];
  for (let i = 0; i < bins; i++) {
    const t = i / bins;
    const band = 0.5 + 0.5 * Math.cos(t * Math.PI * 6);
    const s = 0.92 + 0.08 * (1 - band);
    const v = 0.72 + 0.28 * band;
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

export function buildColorImage(rng, n, from, to) {
  const g = COLOR_LATTICE;
  const warp = buildFlowField(rng, g);
  const img = new Uint8Array(n * n * 3);
  const rgb = [0, 0, 0];
  const inv = 1 / n;
  for (let y = 0; y < n; y++) {
    const v = (y + 0.5) * inv - 0.5;
    for (let x = 0; x < n; x++) {
      const u = (x + 0.5) * inv - 0.5;
      const raw = Math.sqrt(u * u + v * v) * 2;
      const rn = raw > 1 ? 1 : raw;
      const ang = Math.atan2(v, u) / TAU + 0.5;
      const w = latticeAt(warp, 0, g, (x + 0.5) * inv, (y + 0.5) * inv) - 0.5;
      const phase = ang + SPIRAL_TURNS * rn + SPIRAL_WARP * w;
      const cyc = phase - Math.floor(phase);
      const hue = Math.min(COLOR_BANDS - 1, (cyc * COLOR_BANDS) | 0) / (COLOR_BANDS - 1);
      const band = 0.5 + 0.5 * Math.cos(phase * TAU * VALUE_BANDS);
      hsvToRgb(from + (to - from) * hue, 0.98, 0.6 + 0.4 * band, rgb);
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

/**
 * Orbit wells: one seeded centre and one seeded orbit radius per colony.
 * A well steers its agents along a circle, so the colony grows as a ring.
 */
export function buildWells(rng, W, H, n) {
  const wells = new Float32Array(n * 3);
  const min = Math.min(W, H);
  const cx = W / 2;
  const cy = H / 2;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rng() * 0.9;
    const r = min * (0.08 + 0.26 * rng());
    wells[i * 3] = cx + Math.cos(a) * r;
    wells[i * 3 + 1] = cy + Math.sin(a) * r;
    wells[i * 3 + 2] = min * (WELL_MIN + (WELL_MAX - WELL_MIN) * rng());
  }
  return wells;
}

function turnToward(h, want, lim) {
  const d = ((((want - h) % 360) + 540) % 360) - 180;
  return h + (d > lim ? lim : d < -lim ? -lim : d);
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
    this.seed = o.seed;

    this.rng = makeRng(o.seed);
    this.decayLUT = buildDecayLUT(o.decay);

    this.swirl = o.swirl;
    this.cx = this.W / 2;
    this.cy = this.H / 2;
    this.swirlK = this.swirl / (Math.min(this.W, this.H) * 0.5);
    this.specR = Math.min(this.W, this.H) * 0.5;
    const win = HUE_WINDOWS[o.palette] || HUE_WINDOWS.white;
    this.hueWindow = win;
    this.colorImage = buildColorImage(this.rng, COLOR_IMG, win[0], win[1]);
    this.rivalImage = buildColorImage(this.rng, COLOR_IMG, win[0] + 0.5, win[1] + 0.5);
    this._c = new Float32Array(3);
    this._s0 = new Float32Array(3);
    this.flow = buildFlowField(this.rng, FLOW_GRID);
    this.pigment = buildFlowField(this.rng, PIGMENT_GRID);
    this.aurora = buildFlowField(this.rng, AUR_GRID);
    this.braid = buildFlowField(this.rng, BRAID_GRID);
    this.grazeField = buildFlowField(this.rng, GRAZE_GRID);
    this.torsion = buildFlowField(this.rng, TORSION_GRID);
    this.gyre = buildFlowField(this.rng, GYRE_GRID);
    this.eddy = buildFlowField(this.rng, EDDY_GRID);
    this.magnet = buildFlowField(this.rng, MAG_GRID);
    this.prism = buildFlowField(this.rng, PRISM_GRID);
    this.drip = buildFlowField(this.rng, DRIP_GRID);
    const eMin = Math.min(this.W, this.H);
    this.eddyR = eMin * EDDY_RING;
    this.eddyOrbit = eMin * EDDY_ORBIT;
    this.wellCount = WELL_COUNT;
    this.wells = buildWells(this.rng, this.W, this.H, this.wellCount);
    this.mem = new Float32Array(MEM_GRID * MEM_GRID);
    this.memTmp = new Float32Array(MEM_GRID * MEM_GRID);
    this.seedMemory();
    this.hue = new Float32Array(this.num);
    this.charge = new Float32Array(this.num);
    this.age = new Float32Array(this.num);
    this.life = new Float32Array(this.num);
    this.weight = new Float32Array(this.num);
    this.radius = new Uint8Array(this.num);
    this.cphase = new Float32Array(this.num);
    this.cdx = new Float32Array(this.num);
    this.cdy = new Float32Array(this.num);
    this.rib = new Float32Array(this.num);
    this.rail = new Float32Array(this.num);
    this.tcr = new Uint8Array(this.num);
    this.tcg = new Uint8Array(this.num);
    this.tcb = new Uint8Array(this.num);
    this.graze = new Float32Array(this.num);
    this.bite = new Float32Array(this.num);
    this.surf = new Float32Array(this.num);
    this.pol = new Float32Array(this.num);
    this.magS = new Float32Array(this.num);
    this.spread = new Float32Array(this.num);
    this.dripV = new Float32Array(this.num);

    /** the trail map — replaces the p5 canvas pixels */
    this.trail = new Uint8Array(this.W * this.H * 4);
    this.trailPx = new Uint32Array(this.trail.buffer);
    this.trailPrev = new Uint8Array(this.W * this.H * 4);
    this.shearRows = new Int32Array(this.H);
    this.tide = new Float32Array(this.W + this.H);

    this.x = new Float32Array(this.num);
    this.y = new Float32Array(this.num);
    this.heading = new Float32Array(this.num); // degrees
    this.cr = new Uint8Array(this.num);
    this.cg = new Uint8Array(this.num);
    this.cb = new Uint8Array(this.num);

    this.iteration = 0;
    this.spawn();
  }

  seedMemory() {
    const memRng = makeRng(this.seed + MEM_SEED);
    const field = buildFlowField(memRng, MEM_GRID);
    const mem = this.mem;
    for (let i = 0; i < mem.length; i++) mem[i] = field[i] * MEM_DEPOSIT * 3;
    this.memRef = MEM_DEPOSIT * 3;
  }

  /** constructor(): random(w/2 - r, w/2 + r), random(360) */
  spawn() {
    const { W, H, num, rng, colorImage, rivalImage, hue, wells, graze } = this;
    const jitter = this.spawnRadius;
    for (let i = 0; i < num; i++) {
      graze[i] = rng() < GRAZE_SHARE ? GRAZE_FLOOR + (GRAZE_MAX - GRAZE_FLOOR) * rng() : 0;
      this.pol[i] = rng() < 0.5 ? 1 : -1;
      const wi = (i % this.wellCount) * 3;
      const a = rng() * TAU;
      const r = wells[wi + 2] * (0.85 + 0.3 * rng()) + (rng() * 2 - 1) * jitter;
      this.x[i] = (((wells[wi] + Math.cos(a) * r) % W) + W) % W;
      this.y[i] = (((wells[wi + 1] + Math.sin(a) * r) % H) + H) % H;
      this.heading[i] = rng() * 360;
      this.life[i] = LIFE_MIN + (LIFE_MAX - LIFE_MIN) * rng();
      this.age[i] = rng() * this.life[i];
    }
    for (let i = 0; i < num; i++) {
      hue[i] = rng();
      const img = hue[i] < 0.5 ? rivalImage : colorImage;
      const da = rng() * TAU;
      const dr = TRAVEL_MIN + (TRAVEL_MAX - TRAVEL_MIN) * rng();
      this.cdx[i] = Math.cos(da) * dr;
      this.cdy[i] = Math.sin(da) * dr;
      this.cphase[i] = 0;
      this.charge[i] = 0;
      const g2 = this._pigment(this.x[i], this.y[i]);
      const rib = RIB_LOW + (RIB_HIGH - RIB_LOW) * g2;
      this.rib[i] = rib;
      this.rail[i] = RAIL_MIN + (RAIL_MAX - RAIL_MIN) * g2;
      const ha = this.heading[i] * DEG2RAD;
      sampleColor(img, COLOR_IMG, this.x[i] / W, this.y[i] / H, this._c);
      const bright = 0.8 + 0.25 * rng();
      this.cr[i] = Math.min(255, Math.round(this._c[0] * bright));
      this.cg[i] = Math.min(255, Math.round(this._c[1] * bright));
      this.cb[i] = Math.min(255, Math.round(this._c[2] * bright));
      sampleColor(
        img,
        COLOR_IMG,
        this.x[i] / W + rib * Math.cos(ha),
        this.y[i] / H + rib * Math.sin(ha),
        this._c,
      );
      this.tcr[i] = Math.min(255, Math.round(this._c[0] * bright));
      this.tcg[i] = Math.min(255, Math.round(this._c[1] * bright));
      this.tcb[i] = Math.min(255, Math.round(this._c[2] * bright));
    }
  }

  _renew(i) {
    const { W, H, rng, wells } = this;
    const wi = (i % this.wellCount) * 3;
    const a = rng() * TAU;
    const r = wells[wi + 2] * (0.7 + 0.6 * rng()) + (rng() * 2 - 1) * this.spawnRadius;
    this.x[i] = (((wells[wi] + Math.cos(a) * r) % W) + W) % W;
    this.y[i] = (((wells[wi + 1] + Math.sin(a) * r) % H) + H) % H;
    this.heading[i] = rng() * 360;
    this.age[i] = 0;
    this.life[i] = LIFE_MIN + (LIFE_MAX - LIFE_MIN) * rng();
  }

  /** clear the trail and respawn the agents (new RNG stream if seed given) */
  reset(opts = {}) {
    if (opts.seed !== undefined) {
      this.seed = opts.seed;
      this.rng = makeRng(opts.seed);
      this.flow = buildFlowField(this.rng, FLOW_GRID);
      this.pigment = buildFlowField(this.rng, PIGMENT_GRID);
      this.aurora = buildFlowField(this.rng, AUR_GRID);
      this.braid = buildFlowField(this.rng, BRAID_GRID);
      this.grazeField = buildFlowField(this.rng, GRAZE_GRID);
      this.torsion = buildFlowField(this.rng, TORSION_GRID);
      this.gyre = buildFlowField(this.rng, GYRE_GRID);
      this.eddy = buildFlowField(this.rng, EDDY_GRID);
      this.magnet = buildFlowField(this.rng, MAG_GRID);
      this.prism = buildFlowField(this.rng, PRISM_GRID);
      this.drip = buildFlowField(this.rng, DRIP_GRID);
      this.wells = buildWells(this.rng, this.W, this.H, this.wellCount);
      this.colorImage = buildColorImage(
        this.rng,
        COLOR_IMG,
        this.hueWindow[0],
        this.hueWindow[1],
      );
      this.rivalImage = buildColorImage(
        this.rng,
        COLOR_IMG,
        this.hueWindow[0] + 0.5,
        this.hueWindow[1] + 0.5,
      );
    }
    if (opts.num !== undefined) {
      this.num = Math.max(1, Math.round(opts.num));
      this.x = new Float32Array(this.num);
      this.y = new Float32Array(this.num);
      this.heading = new Float32Array(this.num);
      this.cr = new Uint8Array(this.num);
      this.cg = new Uint8Array(this.num);
      this.cb = new Uint8Array(this.num);
      this.hue = new Float32Array(this.num);
      this.charge = new Float32Array(this.num);
      this.age = new Float32Array(this.num);
      this.life = new Float32Array(this.num);
      this.weight = new Float32Array(this.num);
      this.radius = new Uint8Array(this.num);
      this.cphase = new Float32Array(this.num);
      this.cdx = new Float32Array(this.num);
      this.cdy = new Float32Array(this.num);
      this.rib = new Float32Array(this.num);
      this.rail = new Float32Array(this.num);
      this.tcr = new Uint8Array(this.num);
      this.tcg = new Uint8Array(this.num);
      this.tcb = new Uint8Array(this.num);
      this.graze = new Float32Array(this.num);
      this.bite = new Float32Array(this.num);
      this.surf = new Float32Array(this.num);
      this.pol = new Float32Array(this.num);
      this.magS = new Float32Array(this.num);
      this.spread = new Float32Array(this.num);
      this.dripV = new Float32Array(this.num);
    }
    this.trail.fill(0);
    this.shearRows.fill(0);
    this.mem.fill(0);
    this.seedMemory();
    this.iteration = 0;
    this.spawn();
  }

  /** rebuild the trail map at a new size, keeping the overlapping region */
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
    const kx = W / this.W;
    const ky = H / this.H;
    const kr = Math.min(kx, ky);
    const wells = this.wells;
    for (let i = 0; i < wells.length; i += 3) {
      wells[i] *= kx;
      wells[i + 1] *= ky;
      wells[i + 2] *= kr;
    }
    this.trail = next;
    this.trailPx = new Uint32Array(next.buffer);
    this.trailPrev = new Uint8Array(W * H * 4);
    this.shearRows = new Int32Array(H);
    this.tide = new Float32Array(W + H);
    this.W = W;
    this.H = H;
    this.cx = W / 2;
    this.cy = H / 2;
    this.swirlK = this.swirl / (Math.min(W, H) * 0.5);
    this.specR = Math.min(W, H) * 0.5;
    const eMin = Math.min(W, H);
    this.eddyR = eMin * EDDY_RING;
    this.eddyOrbit = eMin * EDDY_ORBIT;
    for (let i = 0; i < this.num; i++) {
      this.x[i] = ((this.x[i] % W) + W) % W;
      this.y[i] = ((this.y[i] % H) + H) % H;
    }
    return true;
  }

  _advectMedium(kw, ph) {
    const W = this.W;
    const H = this.H;
    const amp = SHEAR_AMP * W;
    const px = this.trailPx;
    const rows = this.shearRows;
    for (let y = 0; y < H; y++) {
      const s = Math.round(amp * Math.sin(y * kw + ph));
      const d = s - rows[y];
      if (d === 0) continue;
      rows[y] = s;
      const base = y * W;
      const k = ((d % W) + W) % W;
      px.copyWithin(base + k, base, base + W - k);
      px.copyWithin(base, base + W - k, base + W);
    }
  }

  /** trail value at a pixel index (after p5's `%` wrap) */
  _at(px, py) {
    return this.trail[(py * this.W + px) * 4];
  }

  _field(lat, g, px, py) {
    return latticeAt(lat, 0, g, px / this.W, py / this.H);
  }

  _flow(px, py) {
    return this._field(this.flow, FLOW_GRID, px, py);
  }

  _pigment(px, py) {
    return this._field(this.pigment, PIGMENT_GRID, px, py);
  }

  _memAt(px, py) {
    const g = MEM_GRID;
    const m = this.mem;
    const fx = (px / this.W) * g - 0.5;
    const fy = (py / this.H) * g - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const tx = fx - x0;
    const ty = fy - y0;
    const xa = ((x0 % g) + g) % g;
    const ya = ((y0 % g) + g) % g;
    const xb = (xa + 1) % g;
    const yb = (ya + 1) % g;
    const v00 = m[ya * g + xa];
    const v10 = m[ya * g + xb];
    const v01 = m[yb * g + xa];
    const v11 = m[yb * g + xb];
    const a = v00 + (v10 - v00) * tx;
    const b = v01 + (v11 - v01) * tx;
    return a + (b - a) * ty;
  }

  /** the trail RGB at a pixel, and its strongest channel (0…255) */
  _rgb(px, py, out) {
    const o = ((py | 0) * this.W + (px | 0)) * 4;
    const r = this.trail[o];
    const g = this.trail[o + 1];
    const b = this.trail[o + 2];
    out[0] = r;
    out[1] = g;
    out[2] = b;
    return r > g ? (r > b ? r : b) : g > b ? g : b;
  }

  /** strongest trail channel at a pixel, wrapped, 0…255 */
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

  /** chroma agreement between a trail sample and a color: rival … match */
  _match(s, sr, sg, sb) {
    const m1 = s[0] > s[1] ? (s[0] > s[2] ? s[0] : s[2]) : s[1] > s[2] ? s[1] : s[2];
    if (m1 < CHROMA_FLOOR) return 0;
    const m2 = sr > sg ? (sr > sb ? sr : sb) : sg > sb ? sg : sb;
    const i1 = 1 / m1;
    const i2 = m2 > 0 ? 1 / m2 : 1;
    const d =
      (Math.abs(s[0] * i1 - sr * i2) +
        Math.abs(s[1] * i1 - sg * i2) +
        Math.abs(s[2] * i1 - sb * i2)) /
      3;
    return 1 - 2 * d;
  }

  /** trail density at a sensor, weighted by how well its chroma fits the agent */
  _affinity(px, py, deg, sr, sg, sb) {
    const d = this._sense(px, py, deg, this._s0);
    return d * (1 + CHROMA_PULL * this._match(this._s0, sr, sg, sb));
  }

  /** getSensorPos() + `pixels[index]` in one go. Degrees in, 0…255 out. */
  _sense(px, py, deg, out) {
    const a = deg * DEG2RAD;
    const W = this.W;
    const H = this.H;
    let sx = (px + this.sensorDist * Math.cos(a) + W) % W;
    let sy = (py + this.sensorDist * Math.sin(a) + H) % H;
    if (sx < 0) sx += W; // (only reachable when W < sensorDist)
    if (sy < 0) sy += H;
    return this._rgb(sx, sy, out);
  }

  /** one draw() of the sketch: fade, then every mold senses/steers/moves/deposits */
  step() {
    const {
      W,
      H,
      num,
      trail,
      x,
      y,
      heading,
      cr,
      cg,
      cb,
      hue,
      colorImage,
      rivalImage,
      wells,
      cphase,
      charge,
      cdx,
      cdy,
      tcr,
      tcg,
      tcb,
      aurora,
      graze,
      bite,
      grazeField,
      surf,
      pol,
      magS,
      spread,
      dripV,
    } = this;
    const nWells = this.wellCount;
    const weight = this.weight;
    const radius = this.radius;
    const rail = this.rail;
    const braid = this.braid;
    const sensorAngle = this.sensorAngle;
    const rotAngle = this.rotAngle;
    const rng = this.rng;
    const k = this.swirlK;
    const cx = this.cx;
    const cy = this.cy;
    const agentAge = this.age;
    const agentLife = this.life;
    const spinT = this.iteration * TERR_SPIN;
    const spinCos = Math.cos(spinT);
    const spinSin = Math.sin(spinT);
    const spinDeg = spinT / DEG2RAD;
    const mem = this.mem;
    const memTmp = this.memTmp;
    const mw = MEM_GRID;
    const wAng = this.iteration * LATTICE_SPIN;
    const wcos = Math.cos(wAng);
    const wsin = Math.sin(wAng);
    const shearK = (TAU * SHEAR_WAVE) / H;
    const shearPhase = this.iteration * SHEAR_RATE;
    const waveT = this.iteration * LATTICE_DRIFT;
    const env = LATTICE_MIN + (1 - LATTICE_MIN) * (0.5 + 0.5 * Math.sin(this.iteration * LATTICE_PULSE));
    const wellAng = this.iteration * WELL_DRIFT;
    const wrc = Math.cos(wellAng);
    const wrs = Math.sin(wellAng);
    const wellPhase = this.iteration * WELL_PULSE;
    const tideK = (TAU * TIDE_BANDS) / (W + H);
    const tide = this.tide;
    const tidePhase = this.iteration * TIDE_RATE;
    const spiralEnv =
      SPIRAL_FLOOR + (1 - SPIRAL_FLOOR) * (0.5 + 0.5 * Math.sin(this.iteration * SPIRAL_PULSE));
    const sgr = SPIRAL_TURNS / this.specR;
    const eddyA = this.iteration * EDDY_SPIN;
    const eddyCx = cx + Math.cos(eddyA) * this.eddyOrbit;
    const eddyCy = cy + Math.sin(eddyA) * this.eddyOrbit;
    const eddyR = this.eddyR;
    const eddyEnv =
      EDDY_FLOOR + (1 - EDDY_FLOOR) * (0.5 + 0.5 * Math.sin(this.iteration * EDDY_PULSE));
    const gyreA = this.iteration * GYRE_SPIN;
    const gyreSpan = (W < H ? W : H) * GYRE_SEP;
    const gyreDx = Math.cos(gyreA) * gyreSpan;
    const gyreDy = Math.sin(gyreA) * gyreSpan;
    const gyreEnv =
      GYRE_FLOOR + (1 - GYRE_FLOOR) * (0.5 + 0.5 * Math.sin(this.iteration * GYRE_PULSE));
    for (let u = 0; u < tide.length; u++) {
      const c = Math.cos(u * tideK - tidePhase);
      tide[u] = c > 0 ? TIDE_AMP * c * c * c : 0;
    }

    let memSum = 0;
    for (let i = 0; i < mem.length; i++) {
      const v = mem[i] * MEM_KEEP;
      mem[i] = v;
      memSum += v;
    }
    for (let y = 0; y < mw; y++) {
      const row = y * mw;
      const up = ((y + mw - 1) % mw) * mw;
      const dn = ((y + 1) % mw) * mw;
      for (let x = 0; x < mw; x++) {
        const xl = (x + mw - 1) % mw;
        const xr = (x + 1) % mw;
        memTmp[row + x] = (mem[row + xl] + mem[row + xr] + mem[up + x] + mem[dn + x]) * 0.25;
      }
    }
    for (let i = 0; i < mem.length; i++) mem[i] += (memTmp[i] - mem[i]) * MEM_DIFF;
    const memMean = memSum / mem.length + 1e-6;
    const memRef = this.memRef + 1e-9;
    let memVisit = 0;

    const prev = this.trailPrev;
    const w4 = W * 4;
    if (this.decay >= 255) {
      trail.fill(0);
      prev.set(trail);
    } else {
      prev.set(trail);
      const keep = (255 - this.decay) / 255;
      const axis = this.iteration * DIFFUSE_SPIN;
      const cAxis = Math.cos(axis);
      const sAxis = Math.sin(axis);
      const wR = DIFFUSE * (0.25 + DIFFUSE_BIAS * cAxis);
      const wL = DIFFUSE * (0.25 - DIFFUSE_BIAS * cAxis);
      const wD = DIFFUSE * (0.25 + DIFFUSE_BIAS * sAxis);
      const wU = DIFFUSE * (0.25 - DIFFUSE_BIAS * sAxis);
      const wS = 1 - DIFFUSE;
      for (let y = 0; y < H; y++) {
        const rowU = y > 0 ? -w4 : 0;
        const rowD = y < H - 1 ? w4 : 0;
        let u = y;
        let o = y * w4;
        for (let x = 0; x < W; x++, u++, o += 4) {
          const e = tide[u];
          const nl = x > 0 ? o - 4 : o;
          const nr = x < W - 1 ? o + 4 : o;
          const nu = o + rowU;
          const nd = o + rowD;
          const v0 =
            prev[o] * wS + prev[nl] * wL + prev[nr] * wR + prev[nu] * wU + prev[nd] * wD;
          const v1 =
            prev[o + 1] * wS +
            prev[nl + 1] * wL +
            prev[nr + 1] * wR +
            prev[nu + 1] * wU +
            prev[nd + 1] * wD;
          const v2 =
            prev[o + 2] * wS +
            prev[nl + 2] * wL +
            prev[nr + 2] * wR +
            prev[nu + 2] * wU +
            prev[nd + 2] * wD;
          trail[o] = v0 * keep * (1 - e * (1 - v0 * INV255));
          trail[o + 1] = v1 * keep * (1 - e * (1 - v1 * INV255));
          trail[o + 2] = v2 * keep * (1 - e * (1 - v2 * INV255));
        }
      }
    }

    this._advectMedium(shearK, shearPhase);

    // ── pass 1: update() — move first, then sense, then steer ───────────────
    // (all sensors read the same post-fade / pre-deposit snapshot, exactly
    //  like p5's loadPixels() + `pixels[]`)
    for (let i = 0; i < num; i++) {
      let age = agentAge[i] + 1;
      if (age >= agentLife[i]) {
        this._renew(i);
        age = 0;
      }
      agentAge[i] = age;
      const vig = Math.sin((age / agentLife[i]) * Math.PI);
      const agile = AGE_AGILE + (1 - AGE_AGILE) * (1 - vig);
      const rotStep = rotAngle * agile;
      let h = heading[i];
      const a = h * DEG2RAD;
      const dx = x[i] - cx;
      const dy = y[i] - cy;

      const pace =
        (1 - SLOW_DENSE * charge[i]) *
        (1 + AGE_FAST * (1 - vig)) *
        (1 + TIDE_GLIDE * surf[i]);
      // this.vx = cos(heading); this.x = (x + vx + width) % width
      let px = x[i] + Math.cos(a) * pace - dy * k;
      let py = y[i] + Math.sin(a) * pace + dx * k;
      if (px < 0 || px >= W) {
        px = px < 0 ? -px : W + W - px;
        px = px < 0 ? 0 : px >= W ? W - 1e-3 : px;
        h = 180 - h;
      }
      if (py < 0 || py >= H) {
        py = py < 0 ? -py : H + H - py;
        py = py < 0 ? 0 : py >= H ? H - 1e-3 : py;
        h = -h;
      }
      x[i] = px;
      y[i] = py;

      const ti = (px | 0) + (py | 0);
      const eTide = tide[ti < 0 ? 0 : ti >= tide.length ? tide.length - 1 : ti];
      surf[i] = eTide;

      const dens = this._rgb(px, py, this._s0) / 255;
      const ch = charge[i] + (dens - charge[i]) * CHARGE_FOLLOW;
      charge[i] = ch;
      const flare = CHARGE_FLOOR + FLARE_GAIN * ch;
      const sp = hue[i] < 0.5;
      const fc = Math.cos(py * shearK + shearPhase);
      const fabs = fc < 0 ? -fc : fc;

      const g2 = this._pigment(px, py);
      const torRaw = latticeAt(this.torsion, 0, TORSION_GRID, px / W, py / H) - 0.5;
      const torMag = (torRaw < 0 ? -torRaw : torRaw) * 2;
      const tor = torRaw < 0 ? -1 : 1;
      const grain = g2 * (1 - AGE_WIDE) + vig * AGE_WIDE;
      radius[i] = grain < HAIRLINE_MAX ? 0 : grain < RIBBON_MIN ? 1 : 2;

      const ridge = Math.sin((px * wcos + py * wsin) * LATTICE_K + waveT);
      const focus = 1 - Math.abs(ridge);
      const lin = env * (LATTICE_EDGE + (1 - LATTICE_EDGE) * focus);

      const mv = this._memAt(px, py);
      memVisit += mv;
      const rel = mv / memRef;
      const sgx = this._memAt(px + MEM_PROBE, py) - this._memAt(px - MEM_PROBE, py);
      const sgy = this._memAt(px, py + MEM_PROBE) - this._memAt(px, py - MEM_PROBE);
      const slope = Math.sqrt(sgx * sgx + sgy * sgy) / (2 * MEM_PROBE * memMean);

      let ph = cphase[i] + TERR_PHASE;
      if (ph > TAU) ph -= TAU;
      cphase[i] = ph;
      const wob = TERR_JITTER * Math.cos(ph);
      const wobY = TERR_JITTER * Math.sin(ph);
      const rx = 0.5 + (px / W - 0.5) * spinCos - (py / H - 0.5) * spinSin;
      const ry = 0.5 + (px / W - 0.5) * spinSin + (py / H - 0.5) * spinCos;
      let gm = latticeAt(grazeField, 0, GRAZE_GRID, rx, ry);
      gm = (gm - GRAZE_LO) / (GRAZE_HI - GRAZE_LO);
      gm = gm > 1 ? 1 : gm < 0 ? 0 : gm;
      const bt = graze[i] * gm;
      bite[i] = bt;
      const ex = px - eddyCx;
      const ey = py - eddyCy;
      const er = Math.sqrt(ex * ex + ey * ey) + 1e-3;
      const ern = er / eddyR;
      const eux = ex / er;
      const euy = ey / er;
      const eLat = latticeAt(this.eddy, 0, EDDY_GRID, eux * 0.5 + 0.5, euy * 0.5 + 0.5);
      const eAng = (Math.atan2(ey, ex) / TAU + 1 + this.iteration * EDDY_HUE_SPIN) % 1;
      const g1x = px - (cx + gyreDx);
      const g1y = py - (cy + gyreDy);
      const g1d = Math.sqrt(g1x * g1x + g1y * g1y) + 1e-3;
      const g2x = px - (cx - gyreDx);
      const g2y = py - (cy - gyreDy);
      const g2d = Math.sqrt(g2x * g2x + g2y * g2y) + 1e-3;
      const gcore = GYRE_CORE / (GYRE_CORE + (g1d < g2d ? g1d : g2d));
      const su = (Math.floor(rx * COLOR_TERR) + 0.5) / COLOR_TERR;
      const sv = (Math.floor(ry * COLOR_TERR) + 0.5) / COLOR_TERR;
      const swing = AGE_HUE * (vig - 0.5) * (sp ? 1 : -1);
      const tideHue = TIDE_HUE * eTide * (sp ? 1 : -1);
      const gsp = gcore * GYRE_HUE * (sp ? 1 : -1);
      const hu =
        su + cdx[i] * wob - cdy[i] * wobY + swing + tideHue + eAng * EDDY_HUE + gsp;
      const hv =
        sv + cdy[i] * wob + cdx[i] * wobY + swing + tideHue + ern * EDDY_RING_HUE - gsp * 0.6;
      const au = latticeAt(aurora, 0, AUR_GRID, rx, ry);
      const aL = latticeAt(aurora, 0, AUR_GRID, rx - AUR_PROBE, ry);
      const aR = latticeAt(aurora, 0, AUR_GRID, rx + AUR_PROBE, ry);
      const aU = latticeAt(aurora, 0, AUR_GRID, rx, ry - AUR_PROBE);
      const aD = latticeAt(aurora, 0, AUR_GRID, rx, ry + AUR_PROBE);
      const agx = aR - aL;
      const agy = aD - aU;
      const ags = Math.sqrt(agx * agx + agy * agy);
      const c = sampleColor(sp ? rivalImage : colorImage, COLOR_IMG, hu, hv, this._c);
      const sr = c[0];
      const sg = c[1];
      const sb = c[2];
      const lum = Math.max(sr, Math.max(sg, sb)) / 255;
      let dep = (WEIGHT_FLOOR + (1 - WEIGHT_FLOOR) * g2) * (0.72 + 0.28 * lum);
      dep *= 0.45 + 0.85 * flare;
      dep *= 0.82 + MEM_LIFT * (rel > MEM_REF_CEIL ? MEM_REF_CEIL : rel);
      dep *= 0.55 + 0.7 * vig;
      dep *= AUR_FLOOR + (1 - AUR_FLOOR) * au;
      dep *= 1 + LATTICE_GAIN * lin;
      dep *= 1 - GRAZE_PAINT * bt;
      dep *= SHEAR_FLOOR + SHEAR_GLOW * fabs;
      dep *= 1 + TORSION_GLOW * torMag;
      dep *= 1 + TIDE_SURF * eTide;
      dep *= (1 + EDDY_ARM * eLat) * (1 + EDDY_CORE / (1 + ern * ern * 3));
      dep *= 1 + GYRE_GLOW * gcore * gyreEnv;
      weight[i] = dep > WEIGHT_CEIL ? WEIGHT_CEIL : dep;

      const prRaw = latticeAt(this.prism, 0, PRISM_GRID, px / W, py / H);
      const pSlow = 0.5 + 0.5 * Math.sin(this.iteration * PRISM_SLOW + hue[i] * TAU);
      const ssp =
        (PRISM_MIN + (PRISM_MAX - PRISM_MIN) * prRaw) *
        (PRISM_FLOOR + (1 - PRISM_FLOOR) * pSlow) *
        (0.8 + PRISM_CHARGE * ch) *
        (0.8 + 0.5 * radius[i]) *
        (0.85 + 0.3 * vig);
      spread[i] = ssp > PRISM_CEIL ? PRISM_CEIL : ssp;

      // getSensorPos(r|f|l) — note the sensors are placed along the *old*
      // heading, from the *new* position
      const r = this._affinity(px, py, h + sensorAngle, sr, sg, sb);
      const f = this._affinity(px, py, h, sr, sg, sb);
      const l = this._affinity(px, py, h - sensorAngle, sr, sg, sb);

      // the sketch's steering table, verbatim
      if (f > l && f > r) {
        // keep heading
      } else if (f < l && f < r) {
        h += rng() < 0.5 ? rotStep : -rotStep;
      } else if (l > r) {
        h -= rotStep;
      } else if (r > l) {
        h += rotStep;
      }

      const w = this._flow(px, py);
      h += (w - 0.5) * WIND_TURN;

      let stream = (fc >= 0 ? 0 : 180) - h;
      if (stream > 180) stream -= 360;
      else if (stream < -180) stream += 360;
      const streamLim = SHEAR_TURN * fabs;
      h += stream > streamLim ? streamLim : stream < -streamLim ? -streamLim : stream;

      const hrx = Math.cos(h * DEG2RAD);
      const hry = Math.sin(h * DEG2RAD);
      let ltx = -wsin;
      let lty = wcos;
      let ldot = hrx * ltx + hry * lty;
      if (ldot < 0) {
        ltx = -ltx;
        lty = -lty;
        ldot = -ldot;
      }
      const latDrift = Math.atan2(hrx * lty - hry * ltx, ldot) / DEG2RAD;
      const latLim = LATTICE_TURN * lin;
      h += latDrift > latLim ? latLim : latDrift < -latLim ? -latLim : latDrift;

      if (ags > 1e-5) {
        const along = Math.atan2(agy, agx) / DEG2RAD + (sp ? 90 : -90) - spinDeg;
        let drift = along - h;
        if (drift > 180) drift -= 360;
        else if (drift < -180) drift += 360;
        const lim = ags > AUR_SLOPE ? AUR_TURN : (AUR_TURN * ags) / AUR_SLOPE;
        h += drift > lim ? lim : drift < -lim ? -lim : drift;
      }

      const bgx =
        latticeAt(braid, 0, BRAID_GRID, rx + BRAID_PROBE, ry) -
        latticeAt(braid, 0, BRAID_GRID, rx - BRAID_PROBE, ry);
      const bgy =
        latticeAt(braid, 0, BRAID_GRID, rx, ry + BRAID_PROBE) -
        latticeAt(braid, 0, BRAID_GRID, rx, ry - BRAID_PROBE);
      const braw = Math.sqrt(bgx * bgx + bgy * bgy) / (2 * BRAID_PROBE);
      const bmag = braw > 1 ? 1 : braw;
      if (bmag > 0.01) {
        const wave = Math.cos(cphase[i] + spinT * BRAID_SPIN);
        const want = Math.atan2(bgy, bgx) / DEG2RAD + 90 * wave;
        let weave = want - h;
        if (weave > 180) weave -= 360;
        else if (weave < -180) weave += 360;
        const lim = BRAID_TURN * bmag;
        h += weave > lim ? lim : weave < -lim ? -lim : weave;
      }

      const magRaw = latticeAt(this.magnet, 0, MAG_GRID, rx, ry);
      const magF = Math.abs(magRaw - 0.5) * 2;
      magS[i] = magF;
      if (magF > MAG_FLOOR) {
        const axis =
          (this.iteration * MAG_SPIN) / DEG2RAD +
          (magRaw - 0.5) * MAG_TILT +
          (pol[i] > 0 ? 0 : 180);
        let align = axis - h;
        if (align > 180) align -= 360;
        else if (align < -180) align += 360;
        const lim = MAG_TURN * magF * agile;
        h += align > lim ? lim : align < -lim ? -lim : align;
      }

      if (sgx !== 0 || sgy !== 0) {
        const scentWant = Math.atan2(sgy, sgx) / DEG2RAD;
        let scentTurn = scentWant - h;
        if (scentTurn > 180) scentTurn -= 360;
        else if (scentTurn < -180) scentTurn += 360;
        const scentLim = slope > MEM_SLOPE ? MEM_TURN : (MEM_TURN * slope) / MEM_SLOPE;
        h += scentTurn > scentLim ? scentLim : scentTurn < -scentLim ? -scentLim : scentTurn;
      }

      const lxp = this._lum(px + STRAND_PROBE, py);
      const lxm = this._lum(px - STRAND_PROBE, py);
      const lyp = this._lum(px, py + STRAND_PROBE);
      const lym = this._lum(px, py - STRAND_PROBE);
      const sgx0 = (lxp - lxm) / (2 * STRAND_PROBE);
      const sgy0 = (lyp - lym) / (2 * STRAND_PROBE);
      const gmag = Math.sqrt(sgx0 * sgx0 + sgy0 * sgy0);
      if (gmag > STRAND_MIN) {
        let want;
        if (bt > GRAZE_CLIMB) {
          want = Math.atan2(sgy0, sgx0) / DEG2RAD;
        } else {
          let ttx = -sgy0 / gmag;
          let tty = sgx0 / gmag;
          const hx0 = Math.cos(h * DEG2RAD);
          const hy0 = Math.sin(h * DEG2RAD);
          if (hx0 * ttx + hy0 * tty < 0) {
            ttx = -ttx;
            tty = -tty;
          }
          want = Math.atan2(tty, ttx) / DEG2RAD;
        }
        let ride = want - h;
        if (ride > 180) ride -= 360;
        else if (ride < -180) ride += 360;
        const grip = gmag > STRAND_FULL ? 1 : gmag / STRAND_FULL;
        const rideLim = STRAND_TURN * grip * agile;
        h += ride > rideLim ? rideLim : ride < -rideLim ? -rideLim : ride;
      }

      const wi = (i % nWells) * 3;
      const wbx = wells[wi] - cx;
      const wby = wells[wi + 1] - cy;
      const ox = px - (cx + wbx * wrc - wby * wrs);
      const oy = py - (cy + wbx * wrs + wby * wrc);
      const orbit = wells[wi + 2] * (1 + WELL_BREATH * Math.sin(wellPhase + wi));
      const od = Math.sqrt(ox * ox + oy * oy) + 1e-3;
      let pull = (od - orbit) / orbit;
      pull = pull > 1 ? 1 : pull < -1 ? -1 : pull;
      const ux = ox / od;
      const uy = oy / od;
      const spin = sp ? 1 : -1;
      const want =
        Math.atan2(ux * spin - uy * pull * WELL_PULL, -uy * spin - ux * pull * WELL_PULL) /
        DEG2RAD;
      let turn = want - h;
      if (turn > 180) turn -= 360;
      else if (turn < -180) turn += 360;
      const wellTurn = WELL_TURN * agile;
      h += turn > wellTurn ? wellTurn : turn < -wellTurn ? -wellTurn : turn;

      if (hue[i] < EDDY_SHARE) {
        let epull = ern - 1;
        epull = epull > 1 ? 1 : epull < -1 ? -1 : epull;
        const edx = -euy - eux * epull * EDDY_PULL;
        const edy = eux - euy * epull * EDDY_PULL;
        let eturn = Math.atan2(edy, edx) / DEG2RAD - h;
        if (eturn > 180) eturn -= 360;
        else if (eturn < -180) eturn += 360;
        const elLim = EDDY_MAX * eddyEnv * eLat * (EDDY_FALL / (EDDY_FALL + ern)) * agile;
        h += eturn > elLim ? elLim : eturn < -elLim ? -elLim : eturn;
      }

      if (hue[i] < GYRE_SHARE) {
        const gl = latticeAt(this.gyre, 0, GYRE_GRID, px / W, py / H);
        const gfw = (gl - 0.25) / 0.75;
        if (gfw > 0.02) {
          const gf1 = GYRE_CORE / (GYRE_CORE + g1d);
          const gf2 = GYRE_CORE / (GYRE_CORE + g2d);
          const gvx = (-g1y / g1d) * gf1 + (g2y / g2d) * gf2;
          const gvy = (g1x / g1d) * gf1 - (g2x / g2d) * gf2;
          let gt = Math.atan2(gvy, gvx) / DEG2RAD - h;
          if (gt > 180) gt -= 360;
          else if (gt < -180) gt += 360;
          const glim =
            GYRE_TURN * gyreEnv * (gfw > 1 ? 1 : gfw) * (0.45 + 0.55 * gcore) * agile;
          h += gt > glim ? glim : gt < -glim ? -glim : gt;
        }
      }

      const rdx = px - cx;
      const rdy = py - cy;
      const rr = Math.sqrt(rdx * rdx + rdy * rdy) + 1e-3;
      const urx = rdx / rr;
      const ury = rdy / rr;
      const band = Math.sin(rr * TORSION_K + this.iteration * TORSION_SPIN);
      const pitch = TORSION_PITCH * band;
      let gyre =
        Math.atan2(urx * tor + ury * pitch, -ury * tor + urx * pitch) / DEG2RAD - h;
      if (gyre > 180) gyre -= 360;
      else if (gyre < -180) gyre += 360;
      const gyreLim = TORSION_TURN * torMag * (rr / (rr + TORSION_CORE)) * agile;
      h += gyre > gyreLim ? gyreLim : gyre < -gyreLim ? -gyreLim : gyre;

      const srad = rr > SPIRAL_CORE ? rr : SPIRAL_CORE;
      const trad = (pol[i] > 0 ? -1 : 1) / (TAU * srad);
      const ttan = sgr * (sp ? 1 : -1);
      const tvx = trad * urx - ttan * ury;
      const tvy = trad * ury + ttan * urx;
      let spear = Math.atan2(tvy, tvx) / DEG2RAD - spinDeg - h;
      if (spear > 180) spear -= 360;
      else if (spear < -180) spear += 360;
      const spearLim = SPIRAL_TURN * spiralEnv * (rr / (rr + SPIRAL_CORE)) * agile;
      h += spear > spearLim ? spearLim : spear < -spearLim ? -spearLim : spear;

      const dr = this._field(this.drip, DRIP_GRID, px, py);
      const dtan = Math.tanh((dr - 0.5) * DRIP_SOFT);
      const dmag = dtan > 0 ? dtan : -dtan;
      dripV[i] = DRIP_FALL * (1 + DRIP_GROW * ch) * dtan;
      let sink = (dtan >= 0 ? 90 : -90) - h;
      if (sink > 180) sink -= 360;
      else if (sink < -180) sink += 360;
      const sinkLim = DRIP_TURN * dmag * agile;
      h += sink > sinkLim ? sinkLim : sink < -sinkLim ? -sinkLim : sink;

      const wall = WALL_MARGIN * (W < H ? W : H);
      if (px < wall) h = turnToward(h, 0, WALL_TURN * (1 - px / wall));
      else if (px > W - wall) h = turnToward(h, 180, WALL_TURN * (1 - (W - px) / wall));
      if (py < wall) h = turnToward(h, 90, WALL_TURN * (1 - py / wall));
      else if (py > H - wall) h = turnToward(h, -90, WALL_TURN * (1 - (H - py) / wall));
      heading[i] = h;

      const dim = (0.7 + 0.3 * g2) * (0.82 + 0.18 * hue[i]) * (0.45 + 0.7 * flare);
      const mix = ch * ch * WHITE_MIX;
      const hr = sr * dim;
      const hg = sg * dim;
      const hb = sb * dim;
      cr[i] = Math.round(cr[i] + (hr + (255 - hr) * mix - cr[i]) * COLOR_DRIFT);
      cg[i] = Math.round(cg[i] + (hg + (255 - hg) * mix - cg[i]) * COLOR_DRIFT);
      cb[i] = Math.round(cb[i] + (hb + (255 - hb) * mix - cb[i]) * COLOR_DRIFT);

      const rib = RIB_LOW + (RIB_HIGH - RIB_LOW) * g2;
      this.rib[i] = rib;
      const hx = Math.cos(h * DEG2RAD);
      const hy = Math.sin(h * DEG2RAD);
      const tc = sampleColor(
        sp ? rivalImage : colorImage,
        COLOR_IMG,
        hu + hx * rib,
        hv + hy * rib,
        this._c,
      );
      const tr = tc[0] * dim;
      const tg = tc[1] * dim;
      const tb = tc[2] * dim;
      tcr[i] = Math.round(tcr[i] + (tr + (255 - tr) * mix - tcr[i]) * COLOR_DRIFT);
      tcg[i] = Math.round(tcg[i] + (tg + (255 - tg) * mix - tcg[i]) * COLOR_DRIFT);
      tcb[i] = Math.round(tcb[i] + (tb + (255 - tb) * mix - tcb[i]) * COLOR_DRIFT);
    }
    this.memRef += (memVisit / num - this.memRef) * MEM_REF_FOLLOW;

    // ── pass 2: display() — deposit each agent's color through its own brush ─
    for (let i = 0; i < num; i++) {
      const a = heading[i] * DEG2RAD;
      const ax = Math.cos(a);
      const ay = Math.sin(a);
      const rad = radius[i];
      const side = rad === 0 ? 1 : rad === 1 ? 3 : 5;
      const brush = rad === 1 ? BRUSH : rad === 2 ? BRUSH5 : null;
      const magF = magS[i];
      const norm =
        weight[i] * STREAK_NORM[rad === 0 ? 0 : 1] * RAIL_SHARE * (1 + MAG_PAINT * magF);
      const tailStep = STREAK_STEP * (1 + MAG_STRETCH * magF);
      const hr = cr[i];
      const hg = cg[i];
      const hb = cb[i];
      const qr = tcr[i] - hr;
      const qg = tcg[i] - hg;
      const qb = tcb[i] - hb;
      const sep = rail[i] * (0.6 + 0.4 * Math.cos(cphase[i] + spinT * BRAID_SPIN));
      const wx = -ay * sep;
      const wy = ax * sep;
      const mirrorW = MIRROR_BASE * (0.6 + MIRROR_SWING * Math.cos(cphase[i]));
      const curlAmp=
        ARC_FLOOR + (1 - ARC_FLOOR) * ((rail[i] - RAIL_MIN) / (RAIL_MAX - RAIL_MIN));
      const curl =
        ARC_CURL *
        curlAmp *
        (1 + ARC_SWING * Math.cos(cphase[i] + spinT * ARC_SWING_RATE)) *
        (hue[i] < 0.5 ? 1 : -ARC_REVERSE);
      const psp = spread[i];
      const dv = dripV[i];
      const dside = Math.sin(cphase[i] + spinT * BRAID_SPIN) * DRIP_SIDE * dv;
      const dxr = Math.round(-ay * psp);
      const dyr = Math.round(ax * psp);
      const dxb = -Math.round(dxr * DISP_BLUE);
      const dyb = -Math.round(dyr * DISP_BLUE);
      for (let rl = 0; rl < 2; rl++) {
        const sgn = rl === 0 ? 1 : -1;
        const orx = rl === 0 ? dxr : -dxr;
        const obx = rl === 0 ? dxb : -dxb;
        const lr = rl === 0 ? tcr[i] : hr;
        const lg = rl === 0 ? tcg[i] : hg;
        const lb = rl === 0 ? tcb[i] : hb;
        const dr = rl === 0 ? 0 : qr;
        const dg = rl === 0 ? 0 : qg;
        const db = rl === 0 ? 0 : qb;
        for (let s = 0; s < STREAK_TAPS; s++) {
          const f = s / (STREAK_TAPS - 1);
          const back = s * tailStep;
          let qx = x[i] - ax * back + wx * sgn;
          let qy = y[i] - ay * back + wy * sgn;
          if (s > 0) {
            const ox = qx - cx;
            const oy = qy - cy;
            const rd = Math.sqrt(ox * ox + oy * oy) + ARC_SOFT;
            const ang = (curl * back) / rd;
            const ca = Math.cos(ang);
            const sa = Math.sin(ang);
            qx = cx + ox * ca - oy * sa;
            qy = cy + ox * sa + oy * ca;
          }
          const px = ((((qx + dside * s) | 0) % W) + W) % W;
          const py = ((((qy + dv * s) | 0) % H) + H) % H;
          const pxr = (((px + orx) % W) + W) % W;
          const pyr = (((py + dyr) % H) + H) % H;
          const pxb = (((px + obx) % W) + W) % W;
          const pyb = (((py + dyb) % H) + H) % H;
          const r0 = (lr + dr * f) | 0;
          const g0 = (lg + dg * f) | 0;
          const b0 = (lb + db * f) | 0;
          const strength = norm * (1 - STREAK_FALL * f * DRIP_WET);
          for (let m = 0; m < side * side; m++) {
            const w = (brush ? brush[m] : 1) * strength;
            const mx = (m % side) - rad;
            const my = ((m / side) | 0) - rad;
            const oxr = (((pxr + mx) % W) + W) % W;
            const oyr = (((pyr + my) % H) + H) % H;
            const oxg = (((px + mx) % W) + W) % W;
            const oyg = (((py + my) % H) + H) % H;
            const oxb = (((pxb + mx) % W) + W) % W;
            const oyb = (((pyb + my) % H) + H) % H;
            const inv = 1 - w;
            const o = (oyr * W + oxr) * 4;
            trail[o] = Math.min(255, (r0 * w + trail[o] * inv + 0.5) | 0);
            const og = (oyg * W + oxg) * 4;
            trail[og + 1] = Math.min(255, (g0 * w + trail[og + 1] * inv + 0.5) | 0);
            const ob = (oyb * W + oxb) * 4;
            trail[ob + 2] = Math.min(255, (b0 * w + trail[ob + 2] * inv + 0.5) | 0);
            const wm = w * mirrorW;
            const minv = 1 - wm;
            const mo = (oyr * W + (W - 1 - oxr)) * 4;
            trail[mo] = Math.min(255, (r0 * wm + trail[mo] * minv + 0.5) | 0);
            const mg = (oyg * W + (W - 1 - oxg)) * 4;
            trail[mg + 1] = Math.min(255, (g0 * wm + trail[mg + 1] * minv + 0.5) | 0);
            const mb = (oyb * W + (W - 1 - oxb)) * 4;
            trail[mb + 2] = Math.min(255, (b0 * wm + trail[mb + 2] * minv + 0.5) | 0);
          }
        }
      }

      const bt = bite[i];
      if (bt > 0.02) {
        let gate = (this._lum(x[i], y[i]) / 255 - GRAZE_DEPTH) / (1 - GRAZE_DEPTH);
        gate = gate > 1 ? 1 : gate < 0 ? 0 : gate;
        const cut = bt * GRAZE_BITE * gate;
        if (cut > 0.002) {
          for (let s = 0; s < GRAZE_TAPS; s++) {
            const f = s / (GRAZE_TAPS - 1);
            const gxp = (((x[i] - ax * s * GRAZE_STEP) | 0) % W + W) % W;
            const gyp = (((y[i] - ay * s * GRAZE_STEP) | 0) % H + H) % H;
            const w0 = cut * (1 - GRAZE_FALL * f);
            for (let m = 0; m < GRAZE_BRUSH.length; m++) {
              const w = w0 * GRAZE_BRUSH[m];
              if (w <= 0) continue;
              const ox = (((gxp + (m % GRAZE_BRUSH_SIDE) - GRAZE_BRUSH_R) % W) + W) % W;
              const oy = (((gyp + ((m / GRAZE_BRUSH_SIDE) | 0) - GRAZE_BRUSH_R) % H) + H) % H;
              const o = (oy * W + ox) * 4;
              const inv = 1 - w;
              trail[o] = (trail[o] * inv + 0.5) | 0;
              trail[o + 1] = (trail[o + 1] * inv + 0.5) | 0;
              trail[o + 2] = (trail[o + 2] * inv + 0.5) | 0;
              const mo = (oy * W + (W - 1 - ox)) * 4;
              trail[mo] = (trail[mo] * inv + 0.5) | 0;
              trail[mo + 1] = (trail[mo + 1] * inv + 0.5) | 0;
              trail[mo + 2] = (trail[mo + 2] * inv + 0.5) | 0;
            }
          }
        }
      }

      const mmx = (x[i] / W) * MEM_GRID - 0.5;
      const mmy = (y[i] / H) * MEM_GRID - 0.5;
      const mix = Math.floor(mmx);
      const miy = Math.floor(mmy);
      const mfx = mmx - mix;
      const mfy = mmy - miy;
      const mxa = ((mix % MEM_GRID) + MEM_GRID) % MEM_GRID;
      const mya = ((miy % MEM_GRID) + MEM_GRID) % MEM_GRID;
      const mxb = (mxa + 1) % MEM_GRID;
      const myb = (mya + 1) % MEM_GRID;
      const amt = MEM_DEPOSIT * weight[i];
      mem[mya * MEM_GRID + mxa] += amt * (1 - mfx) * (1 - mfy);
      mem[mya * MEM_GRID + mxb] += amt * mfx * (1 - mfy);
      mem[myb * MEM_GRID + mxa] += amt * (1 - mfx) * mfy;
      mem[myb * MEM_GRID + mxb] += amt * mfx * mfy;
    }

    this.iteration++;
  }

  /** cheap run signature (useful for tests / headless checks) */
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

/** the p5 sketch's numbers, for reference in the docs */
export const REFERENCE = { num: 4000, sensorAngle: 45, sensorDist: 10, rotAngle: 45, decay: 5 };
export { TAU };
