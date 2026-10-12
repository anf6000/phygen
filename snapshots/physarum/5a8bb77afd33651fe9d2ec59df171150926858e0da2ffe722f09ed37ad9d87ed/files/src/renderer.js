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
import { SEED_SITE } from './physarum.js';

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
  uniform vec2 uTexel;
  uniform float uGain;
  uniform float uGamma;
  uniform float uRows;

  float tap(vec2 uv, vec2 o) {
    return texture2D(uTex, clamp(uv + o, vec2(0.0), vec2(1.0))).r;
  }

  void main() {
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
    vec2 d1 = uTexel * 2.0;
    float mark = texture2D(uTex, uv).r;
    float reuse = 1.0
      + tap(uv, vec2(d1.x, 0.0)) + tap(uv, vec2(-d1.x, 0.0))
      + tap(uv, vec2(0.0, d1.y)) + tap(uv, vec2(0.0, -d1.y))
      + 0.55 * (tap(uv, vec2(d1.x, d1.y)) + tap(uv, vec2(-d1.x, d1.y))
              + tap(uv, vec2(d1.x, -d1.y)) + tap(uv, vec2(-d1.x, -d1.y)));
    float v = pow(clamp(mark * reuse * uGain * 0.1, 0.0, 1.0), uGamma);
    float dens = clamp(mark * reuse * 0.3, 0.0, 1.0);
    float heat = clamp(texture2D(uField, uv).r * (0.25 + 0.75 * dens), 0.0, 1.0);
    float row = (heat * (uRows - 1.0) + 0.5) / uRows;
    gl_FragColor = vec4(texture2D(uPalette, vec2(v, row)).rgb, 1.0);
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
    [
      [0, 0, 0],
      [3, 5, 11],
      [7, 13, 24],
      [12, 24, 40],
      [19, 39, 60],
      [30, 58, 82],
      [46, 82, 104],
      [70, 110, 130],
      [108, 140, 152],
      [162, 186, 192],
    ],
    [
      [0, 0, 0],
      [8, 5, 4],
      [20, 12, 8],
      [38, 20, 12],
      [62, 32, 17],
      [92, 48, 24],
      [128, 68, 32],
      [168, 96, 46],
      [210, 134, 72],
      [246, 190, 132],
    ],
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

/** Build a 256×rows RGBA lookup texture from a list of stops, or a list of ramps. */
export function makePaletteTexture(name = 'white') {
  const set = PALETTES[name] || PALETTES.white;
  const ramps = Array.isArray(set[0][0]) ? set : [set];
  const N = 256;
  const rows = ramps.length;
  const data = new Uint8Array(N * rows * 4);
  for (let b = 0; b < rows; b++) {
    const stops = ramps[b];
    for (let i = 0; i < N; i++) {
      const t = i / (N - 1);
      const s = t * (stops.length - 1);
      const i0 = Math.min(stops.length - 1, Math.floor(s));
      const i1 = Math.min(stops.length - 1, i0 + 1);
      const f = s - i0;
      const o = (b * N + i) * 4;
      for (let c = 0; c < 3; c++) {
        data[o + c] = Math.round(stops[i0][c] + (stops[i1][c] - stops[i0][c]) * f);
      }
      data[o + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, rows, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

const FIELD_REACH = 0.19;

export function makeColorFieldTexture(size = 128, aspect = 1) {
  const data = new Uint8Array(size * size);
  const sx = aspect >= 1 ? aspect : 1;
  const sy = aspect >= 1 ? 1 : 1 / aspect;
  for (let y = 0; y < size; y++) {
    const v = (y + 0.5) / size;
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const du = (u - SEED_SITE.x) * sx;
      const dv = (v - SEED_SITE.y) * sy;
      const d = Math.min(1, Math.sqrt(du * du + dv * dv) / FIELD_REACH);
      const m = 1 - d * d * (3 - 2 * d);
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
    this.paletteRows = this.paletteTexture.image.height;
    this.colorFieldTexture = makeColorFieldTexture(160, this.width / this.height);

    this.material = new THREE.ShaderMaterial({
      vertexShader: SHOW_VERT,
      fragmentShader: SHOW_FRAG,
      uniforms: {
        uTex: { value: null },
        uPalette: { value: this.paletteTexture },
        uField: { value: this.colorFieldTexture },
        uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
        uGain: { value: gain },
        uGamma: { value: gamma },
        uRows: { value: this.paletteRows },
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
    this.paletteRows = this.paletteTexture.image.height;
    this.material.uniforms.uPalette.value = this.paletteTexture;
    this.material.uniforms.uRows.value = this.paletteRows;
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
    this.material.uniforms.uTexel.value.set(1 / width, 1 / height);
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
