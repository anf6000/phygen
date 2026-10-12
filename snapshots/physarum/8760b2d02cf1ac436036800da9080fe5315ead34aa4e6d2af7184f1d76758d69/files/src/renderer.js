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
  uniform vec2 uTexel;
  uniform float uGain;
  uniform float uGamma;
  uniform float uFloor;
  uniform float uSpan;
  uniform float uRows;

  float tap(vec2 uv, vec2 o) {
    return texture2D(uTex, clamp(uv + o, vec2(0.0), vec2(1.0))).r;
  }

  void main() {
    vec2 uv = vec2(vUv.x, 1.0 - vUv.y);
    float mark = texture2D(uTex, uv).r;
    vec2 n1 = uTexel;
    vec2 n3 = uTexel * 3.0;
    float near8 =
        tap(uv, vec2(n1.x, 0.0)) + tap(uv, vec2(-n1.x, 0.0))
      + tap(uv, vec2(0.0, n1.y)) + tap(uv, vec2(0.0, -n1.y))
      + tap(uv, vec2(n1.x, n1.y)) + tap(uv, vec2(-n1.x, n1.y))
      + tap(uv, vec2(n1.x, -n1.y)) + tap(uv, vec2(-n1.x, -n1.y));
    float wide8 =
        tap(uv, vec2(n3.x, 0.0)) + tap(uv, vec2(-n3.x, 0.0))
      + tap(uv, vec2(0.0, n3.y)) + tap(uv, vec2(0.0, -n3.y))
      + tap(uv, vec2(n3.x, n3.y)) + tap(uv, vec2(-n3.x, n3.y))
      + tap(uv, vec2(n3.x, -n3.y)) + tap(uv, vec2(-n3.x, -n3.y));
    float body = mark > 0.5 ? (3.0 * mark + near8 + 0.85 * wide8) / 15.8 : 0.0;
    float v = clamp(uFloor + uSpan * pow(clamp(body * uGain, 0.0, 1.0), uGamma), 0.0, 1.0);
    vec3 rgb = texture2D(uPalette, vec2(v, 0.5 / uRows)).rgb;
    gl_FragColor = vec4(rgb * step(0.5, mark), 1.0);
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
    [4, 7, 14],
    [9, 17, 30],
    [15, 30, 47],
    [22, 44, 66],
    [32, 60, 84],
    [46, 82, 104],
    [70, 110, 130],
    [108, 140, 152],
    [162, 186, 192],
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
  marsh: [
    [10, 12, 20],
    [18, 30, 46],
    [24, 46, 58],
    [28, 62, 62],
    [40, 78, 60],
    [60, 92, 56],
    [88, 102, 54],
    [120, 112, 58],
    [152, 122, 62],
    [184, 136, 76],
    [210, 154, 98],
    [231, 178, 130],
    [244, 203, 162],
    [252, 232, 208],
  ],
};

export const RAMP_SWAP = Object.freeze({ magma: 'marsh' });

export function rampName(name) {
  return RAMP_SWAP[name] || name;
}

/** Build a 256×rows RGBA lookup texture from a list of stops, or a list of ramps. */
export function makePaletteTexture(name = 'white') {
  const set = PALETTES[rampName(name)] || PALETTES.white;
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

export class PhysarumRenderer {
  /**
   * @param {object}  o
   * @param {HTMLCanvasElement} o.canvas
   * @param {'white'|'ice'|'ember'|'viridis'|…} [o.palette]
   * @param {number} [o.gain]  display brightness scale
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

    this.material = new THREE.ShaderMaterial({
      vertexShader: SHOW_VERT,
      fragmentShader: SHOW_FRAG,
      uniforms: {
        uTex: { value: null },
        uPalette: { value: this.paletteTexture },
        uTexel: { value: new THREE.Vector2(1 / this.width, 1 / this.height) },
        uGain: { value: gain },
        uGamma: { value: gamma },
        uFloor: { value: 0.05 },
        uSpan: { value: 0.95 },
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
    this.material.dispose();
    this.quad.geometry.dispose();
    this.renderer.dispose();
  }
}
