// ─────────────────────────────────────────────────────────────────────────────
// renderer.js — drawing the trail with three.js.
//
// The trail is a single-channel Uint8Array — the same bytes the p5 sketch kept
// in its canvas. It is uploaded as a THREE.DataTexture and drawn on one
// full-screen triangle with an OrthographicCamera: the three.js equivalent of
// the sketch's `image()` / of the p5 canvas itself.
//
// There is no geometry, no lighting and no camera math — this is a 2D image
// pipeline. What WebGL buys is the palette LUT, the gain/gamma mapping and a
// clean separation between "the simulation" and "how it is looked at".
// ─────────────────────────────────────────────────────────────────────────────
import * as THREE from 'three';
import { POCKETS } from './physarum.js';

// Full-screen quad: position.xy ∈ [-1,1] is also the clip-space position.
const SHOW_VERT = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// vUv.y is flipped because the trail buffer is stored top-row-first (y down),
// the same orientation the p5 sketch used.
const SHOW_FRAG = /* glsl */ `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uTex;
  uniform sampler2D uPalette;
  uniform sampler2D uField;
  uniform float uGain;
  uniform float uGamma;
  void main() {
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
    float v = texture2D(uTex, uv).r;
    v = clamp(v * uGain, 0.0, 1.0);
    v = pow(v, uGamma);
    float tone = texture2D(uField, uv).r;
    gl_FragColor = vec4(texture2D(uPalette, vec2(v * tone, 0.5)).rgb, 1.0);
  }
`;

/** Named palettes, as lists of RGB stops (0…255) sampled by value 0…1. */
export const PALETTES = {
  white: [
    [0, 0, 0],
    [255, 255, 255],
  ],
  bone: [
    [0, 0, 0],
    [34, 26, 20],
    [140, 125, 100],
    [255, 244, 224],
  ],
  ice: [
    [0, 0, 0],
    [12, 18, 22],
    [30, 44, 52],
    [58, 82, 92],
    [96, 128, 138],
    [140, 172, 180],
    [184, 208, 212],
    [218, 234, 236],
    [255, 236, 204],
  ],
  ember: [
    [0, 0, 0],
    [16, 9, 7],
    [36, 17, 13],
    [62, 28, 19],
    [92, 42, 26],
    [124, 58, 33],
    [158, 82, 45],
    [200, 124, 72],
    [255, 206, 140],
  ],
  viridis: [
    [68, 1, 84],
    [72, 40, 120],
    [62, 73, 137],
    [49, 104, 142],
    [38, 130, 142],
    [31, 158, 137],
    [53, 183, 121],
    [110, 206, 88],
    [181, 222, 43],
    [253, 231, 37],
  ],
  inferno: [
    [0, 0, 4],
    [27, 12, 65],
    [74, 12, 107],
    [120, 28, 109],
    [165, 44, 96],
    [207, 68, 70],
    [237, 105, 37],
    [251, 155, 6],
    [247, 209, 61],
    [252, 255, 164],
  ],
  magma: [
    [0, 0, 4],
    [28, 16, 68],
    [79, 18, 123],
    [129, 37, 129],
    [181, 54, 122],
    [229, 80, 100],
    [251, 135, 97],
    [254, 194, 135],
    [252, 253, 191],
  ],
};

/** Build a 256×1 RGBA lookup texture from a list of stops. */
export function makePaletteTexture(name = 'white') {
  const stops = PALETTES[name] || PALETTES.white;
  const N = 256;
  const data = new Uint8Array(N * 4);
  for (let i = 0; i < N; i++) {
    const t = i / (N - 1);
    const s = t * (stops.length - 1);
    const i0 = Math.min(stops.length - 1, Math.floor(s));
    const i1 = Math.min(stops.length - 1, i0 + 1);
    const f = s - i0;
    for (let c = 0; c < 3; c++) {
      data[i * 4 + c] = Math.round(stops[i0][c] + (stops[i1][c] - stops[i0][c]) * f);
    }
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, N, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

function fieldHash(x, y, k) {
  let h = Math.imul(x + 379, 174763) ^ Math.imul(y + 173, 31337) ^ Math.imul(k + 17, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function fieldNoise(x, y, freq, k) {
  const fx = x * freq;
  const fy = y * freq;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const sx = tx * tx * (3 - 2 * tx);
  const sy = ty * ty * (3 - 2 * ty);
  const a = fieldHash(x0, y0, k);
  const b = fieldHash(x0 + 1, y0, k);
  const c = fieldHash(x0, y0 + 1, k);
  const d = fieldHash(x0 + 1, y0 + 1, k);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

export function makeColorFieldTexture(size = 128, aspect = 1) {
  const data = new Uint8Array(size * size);
  const accent = { x: 0.25, y: 0.49, r: 0.05 };
  const scaleX = aspect >= 1 ? 1 : aspect;
  const scaleY = aspect >= 1 ? 1 / aspect : 1;
  const pockets = POCKETS.map((p) => ({
    x: p.x * scaleX,
    y: p.y * scaleY,
    long: Math.max(1e-4, p.long * scaleX),
    short: Math.max(1e-4, p.short * scaleY),
    ca: Math.cos((p.tilt * Math.PI) / 180),
    sa: Math.sin((p.tilt * Math.PI) / 180),
  }));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const eu = u * scaleX;
      const ev = v * scaleY;
      let core = 0;
      for (const p of pockets) {
        const ex = eu - p.x;
        const ey = ev - p.y;
        const q = (ex * p.ca + ey * p.sa) / p.long;
        const s = (ey * p.ca - ex * p.sa) / p.short;
        const g = Math.exp(-0.9 * (q * q + s * s));
        if (g > core) core = g;
      }
      const ax = eu - accent.x * scaleX;
      const ay = ev - accent.y * scaleY;
      const glow = Math.exp(-(ax * ax + ay * ay) / (2 * accent.r * accent.r));
      const n = 0.6 * fieldNoise(u, v, 1.9, 5) + 0.4 * fieldNoise(u, v, 4.7, 11);
      let m = 0.3 + 0.24 * core + 0.055 * (n - 0.5) + 0.62 * glow;
      m = m < 0.06 ? 0.06 : m > 0.98 ? 0.98 : m;
      data[y * size + x] = Math.round(m * 255);
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.unpackAlignment = 1;
  tex.needsUpdate = true;
  return tex;
}

export class PhysarumRenderer {
  /**
   * @param {object}  o
   * @param {HTMLCanvasElement} o.canvas
   * @param {'white'|'ice'|'ember'|'viridis'|…} [o.palette]
   * @param {number} [o.gain]   trail value that maps to full brightness
   * @param {number} [o.gamma]  display gamma
   */
  constructor({ canvas, palette = 'white', gain = 1, gamma = 1 } = {}) {
    this.width = canvas?.width || 1;
    this.height = canvas?.height || 1;

    // stay in linear space end-to-end: the trail is data, not a colour
    THREE.ColorManagement.enabled = false;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      premultipliedAlpha: false,
      preserveDrawingBuffer: true, // so the canvas can be saved with toDataURL()
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(this.width, this.height, false);
    this.renderer.autoClear = false; // the sim does its own clearing
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x000000, 1);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.scene = new THREE.Scene();

    /** the trail texture currently being shown */
    this.sourceTexture = null;
    this.dataTexture = null;

    this.paletteTexture = makePaletteTexture(palette);
    this.colorFieldTexture = makeColorFieldTexture(160, this.width / this.height);

    this.material = new THREE.ShaderMaterial({
      vertexShader: SHOW_VERT,
      fragmentShader: SHOW_FRAG,
      uniforms: {
        uTex: { value: null },
        uPalette: { value: this.paletteTexture },
        uField: { value: this.colorFieldTexture },
        uGain: { value: gain },
        uGamma: { value: gamma },
      },
      depthTest: false,
      depthWrite: false,
      blending: THREE.NoBlending,
    });

    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.material);
    this.quad.frustumCulled = false;
    this.scene.add(this.quad);
  }

  /** pick a palette by name ('white' restores the sketch's look) */
  setPalette(name) {
    this.paletteTexture.dispose();
    this.paletteTexture = makePaletteTexture(name);
    this.material.uniforms.uPalette.value = this.paletteTexture;
  }

  setGain(gain) {
    this.material.uniforms.uGain.value = gain;
  }

  setGamma(gamma) {
    this.material.uniforms.uGamma.value = gamma;
  }

  /**
   * Point the display at a plain CPU byte buffer, uploading it as a DataTexture.
   * Rows are top-to-bottom (y down), matching the sim.
   */
  bindTrailData(data, width, height) {
    const t = this.dataTexture;
    if (!t || t.image.width !== width || t.image.height !== height) {
      t?.dispose();
      this.dataTexture = new THREE.DataTexture(
        data,
        width,
        height,
        THREE.RedFormat,
        THREE.UnsignedByteType,
      );
      this.dataTexture.wrapS = THREE.ClampToEdgeWrapping;
      this.dataTexture.wrapT = THREE.ClampToEdgeWrapping;
      this.dataTexture.magFilter = THREE.NearestFilter;
      this.dataTexture.minFilter = THREE.NearestFilter;
      this.dataTexture.generateMipmaps = false;
      this.dataTexture.colorSpace = THREE.NoColorSpace;
      this.dataTexture.unpackAlignment = 1; // row stride = width bytes
      this.dataTexture.needsUpdate = true;
    } else {
      t.image.data = data;
      t.needsUpdate = true;
    }
    this.sourceTexture = this.dataTexture;
  }

  /** image(trail, 0, 0) — draw the trail to the canvas */
  present() {
    this.material.uniforms.uTex.value = this.sourceTexture;
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);
  }

  /** the canvas backing size, in device pixels */
  setSize(width, height) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    this.renderer.setSize(this.width, this.height, false);
    if (this.renderer.getRenderTarget() === null) this.renderer.setRenderTarget(null);
  }

  /** current canvas as a PNG data URL (needs preserveDrawingBuffer) */
  toDataURL(type = 'image/png') {
    return this.renderer.domElement.toDataURL(type);
  }

  dispose() {
    this.dataTexture?.dispose();
    this.paletteTexture.dispose();
    this.colorFieldTexture.dispose();
    this.material.dispose();
    this.quad.geometry.dispose();
    this.renderer.dispose();
  }
}
