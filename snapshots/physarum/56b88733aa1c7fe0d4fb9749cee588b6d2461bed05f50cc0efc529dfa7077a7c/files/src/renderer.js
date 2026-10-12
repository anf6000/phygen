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

  float tap(vec2 uv, vec2 o) {
    return texture2D(uTex, clamp(uv + o, vec2(0.0), vec2(1.0))).r;
  }

  void main() {
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
    vec2 d1 = uTexel * 2.0;
    vec2 d2 = uTexel * 4.0;
    float mark = texture2D(uTex, uv).r;
    float reuse = 1.0
      + tap(uv, vec2(d1.x, 0.0)) + tap(uv, vec2(-d1.x, 0.0))
      + tap(uv, vec2(0.0, d1.y)) + tap(uv, vec2(0.0, -d1.y))
      + 0.55 * (tap(uv, vec2(d1.x, d1.y)) + tap(uv, vec2(-d1.x, d1.y))
              + tap(uv, vec2(d1.x, -d1.y)) + tap(uv, vec2(-d1.x, -d1.y)))
      + 0.3 * (tap(uv, vec2(d2.x, 0.0)) + tap(uv, vec2(-d2.x, 0.0))
             + tap(uv, vec2(0.0, d2.y)) + tap(uv, vec2(0.0, -d2.y)));
    float region = texture2D(uField, uv).r;
    float v = mark * reuse * uGain * 0.1 * (0.78 + 0.3 * region);
    v = pow(clamp(v, 0.0, 1.0), uGamma);
    gl_FragColor = vec4(texture2D(uPalette, vec2(v, 0.5)).rgb, 1.0);
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
    [4, 8, 11],
    [10, 17, 22],
    [15, 26, 32],
    [21, 36, 43],
    [27, 45, 52],
    [33, 55, 63],
    [43, 70, 78],
    [60, 92, 100],
    [84, 118, 124],
    [114, 146, 150],
    [150, 176, 176],
    [190, 202, 186],
    [228, 206, 154],
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

const FIELD_ORIGIN = { x: 0.36, y: 0.42 };
const FIELD_REACH = 0.5;

export function makeColorFieldTexture(size = 128, aspect = 1) {
  const data = new Uint8Array(size * size);
  const scaleX = aspect >= 1 ? 1 : aspect;
  const scaleY = aspect >= 1 ? 1 / aspect : 1;
  const ox = FIELD_ORIGIN.x * scaleX;
  const oy = FIELD_ORIGIN.y * scaleY;
  const reach = FIELD_REACH * Math.max(scaleX, scaleY);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const eu = ((x + 0.5) / size) * scaleX - ox;
      const ev = ((y + 0.5) / size) * scaleY - oy;
      const d = Math.sqrt(eu * eu + ev * ev) / reach;
      const m = d >= 1 ? 0 : 1 - d * d * (3 - 2 * d);
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
        uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
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
