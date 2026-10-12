// ─────────────────────────────────────────────────────────────────────────────
// adapter.js — the runtime adapter for the physarum artwork.
//
// This file is part of the trusted runtime. The manifest lists it as protected,
// so an author session can change the simulation and the renderer, but not the
// lifecycle, the recorded state, or the limits.
//
// The adapter owns:
//   - the trail size, derived from the viewport and the configuration scale
//   - the simulation, through src/physarum.js
//   - the display, through src/renderer.js
//   - the step budget, the resource bounds, and the state snapshot
//
// Resize policy: resize keeps the overlapping top-left region of the trail,
// wraps every agent into the new bounds, and does not re-seed. A resize
// therefore changes later simulation state. Evaluation must not resize between
// capture stages of one comparison.
// ─────────────────────────────────────────────────────────────────────────────
import {
  ArtworkError,
  CONTRACT_VERSION,
  ContractError,
  ConfigurationError,
  assertState,
  hashTypedArray,
} from '../../runtime/contract.js';
import { validateConfiguration } from '../../runtime/config.js';
import { Physarum } from './physarum.js';
import { PhysarumRenderer } from './renderer.js';

export const contractVersion = CONTRACT_VERSION;

/** Hard limits for the viewport. They are independent of the artwork. */
export const VIEWPORT_LIMITS = Object.freeze({
  minWidth: 64,
  minHeight: 64,
  maxWidth: 16384,
  maxHeight: 16384,
  minDpr: 0.25,
  maxDpr: 4,
});

/** The smallest trail the simulation accepts. */
export const MIN_TRAIL_PIXELS = 64;

const DEFAULT_LIMITS = Object.freeze({
  maxAgents: 200000,
  maxTrailPixels: 4194304,
  maxStepsPerEvaluation: 20000,
});

/** Build the WebGL display. Tests inject a replacement through `rendererFactory`. */
export function createWebGLRenderer({ canvas, configuration, viewport }) {
  const renderer = new PhysarumRenderer({
    canvas,
    palette: configuration.palette,
    gain: configuration.gain,
    gamma: configuration.gamma,
  });
  renderer.setSize(viewport.width, viewport.height);
  return renderer;
}

/** Read the graphics backend strings, for the record. Never throws. */
export function readRendererInfo(view) {
  const info = { available: false, version: null, vendor: null, renderer: null, unmasked: null };
  try {
    const gl = view?.renderer?.getContext?.();
    if (!gl) return info;
    info.available = true;
    info.version = gl.getParameter(gl.VERSION) ?? null;
    info.vendor = gl.getParameter(gl.VENDOR) ?? null;
    info.renderer = gl.getParameter(gl.RENDERER) ?? null;
    const debug = gl.getExtension?.('WEBGL_debug_renderer_info');
    if (debug) info.unmasked = gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) ?? null;
  } catch (error) {
    info.error = String(error?.message ?? error);
  }
  return info;
}

/** FNV-1a over every agent array. Detects any drift in positions or headings. */
export function agentsChecksum(simulation) {
  return hashTypedArray(simulation.x) ^ hashTypedArray(simulation.y) ^ hashTypedArray(simulation.heading);
}

function assertStepCount(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw new ContractError('step_count_invalid', `step count must be a positive integer, got ${value}`, { value });
  }
}

function assertSeed(seed) {
  if (!Number.isInteger(seed) || seed < 0 || seed > 4294967295) {
    throw new ConfigurationError('seed_out_of_range', `seed must be an integer from 0 to 4294967295, got ${seed}`, { seed });
  }
}

/** Every value the adapter reads. A missing value must fail, never default. */
const REQUIRED_NUMBERS = Object.freeze([
  'gamma', 'dpr', 'num', 'sensorAngle', 'sensorDist', 'rotAngle', 'decay',
  'spawnRadius', 'scale', 'gain', 'speed', 'seed',
]);

function assertConfigurationShape(configuration) {
  if (typeof configuration.palette !== 'string' || configuration.palette.length === 0) {
    throw new ConfigurationError('configuration_incomplete', 'configuration.palette must be a non-empty string');
  }
  for (const key of REQUIRED_NUMBERS) {
    const value = configuration[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new ConfigurationError('configuration_incomplete', `configuration.${key} must be a finite number, got ${value}`, { key, value });
    }
  }
  return configuration;
}

export class PhysarumAdapter {
  constructor() {
    this.artworkId = 'physarum';
    this.contractVersion = CONTRACT_VERSION;
    this.simulation = null;
    this.view = null;
    this.rendererFactory = createWebGLRenderer;
    this.limits = { ...DEFAULT_LIMITS };
    this.disposed = true;
    this.resizes = 0;
    this.stepsRemaining = 0;
    this.configuration = {};
    this.viewport = { width: 0, height: 0, dpr: 1 };
    this.displayPalette = null;
  }

  /**
   * @param {object} options
   * @param {HTMLCanvasElement|null} [options.canvas]      display target
   * @param {number} options.seed                          initial random seed
   * @param {{width: number, height: number, dpr: number}} options.viewport
   * @param {object} options.configuration                 complete configuration
   * @param {object|null} [options.schema]                 configuration schema
   * @param {object} [options.limits]                      resource limits
   * @param {string} [options.artworkId]                   package id, for the record
   * @param {Function|null} [options.rendererFactory]      null runs without a display
   * @returns {Promise<object>} the first state snapshot
   */
  async initialize({
    canvas = null,
    seed,
    viewport,
    configuration,
    schema = null,
    limits = {},
    artworkId = 'physarum',
    rendererFactory = createWebGLRenderer,
  } = {}) {
    if (!this.disposed) {
      throw new ContractError('already_initialized', 'initialize() was called on an adapter that is already initialized');
    }
    assertSeed(seed);
    if (!configuration || typeof configuration !== 'object') {
      throw new ConfigurationError('configuration_missing', 'initialize() needs a complete configuration object');
    }
    assertConfigurationShape(configuration);
    if (schema) validateConfiguration(configuration, schema);

    const resolvedLimits = { ...DEFAULT_LIMITS, ...limits };
    const resolvedViewport = this._validateViewport(viewport);
    const trail = this._trailSize(resolvedViewport, configuration.scale, resolvedLimits);

    if (configuration.num > resolvedLimits.maxAgents) {
      throw new ConfigurationError(
        'agents_exceed_limit',
        `The configuration asks for ${configuration.num} molds; the package limit is ${resolvedLimits.maxAgents}`,
        { requested: configuration.num, limit: resolvedLimits.maxAgents },
      );
    }

    this.artworkId = artworkId;
    this.configuration = { ...configuration };
    this.viewport = resolvedViewport;
    this.limits = resolvedLimits;
    this.resizes = 0;
    this.stepsRemaining = resolvedLimits.maxStepsPerEvaluation;
    this.rendererFactory = rendererFactory;

    this.simulation = new Physarum({
      width: trail.width,
      height: trail.height,
      num: Math.round(configuration.num),
      sensorAngle: configuration.sensorAngle,
      sensorDist: configuration.sensorDist,
      rotAngle: configuration.rotAngle,
      decay: configuration.decay,
      spawnRadius: configuration.spawnRadius,
      seed,
    });

    try {
      this.view = rendererFactory === null ? null : rendererFactory({ canvas, configuration: this.configuration, viewport: this.viewport });
    } catch (error) {
      // a candidate whose display cannot start is a failed candidate, and the
      // adapter must stay reusable, so release what was already built
      this.dispose();
      throw error;
    }
    this.disposed = false;
    return this.getState();
  }

  /** Clear the trail and respawn the molds. An optional seed starts a new stream. */
  reset({ seed } = {}) {
    this._assertRunning('reset');
    if (seed !== undefined) assertSeed(seed);
    this.simulation.reset(seed === undefined ? {} : { seed });
    this.stepsRemaining = this.limits.maxStepsPerEvaluation;
    return this.getState();
  }

  /** Advance the simulation by an explicit step count. */
  step(count = 1) {
    this._assertRunning('step');
    assertStepCount(count);
    if (count > this.stepsRemaining) {
      throw new ArtworkError(
        'step_budget_exceeded',
        `The step budget for this evaluation is ${this.limits.maxStepsPerEvaluation}; ${count} more steps were requested with ${this.stepsRemaining} left`,
        { requested: count, remaining: this.stepsRemaining, limit: this.limits.maxStepsPerEvaluation },
      );
    }
    for (let i = 0; i < count; i++) this.simulation.step();
    this.stepsRemaining -= count;
    return this.simulation.iteration;
  }

  /** Draw the current trail. Evaluation calls this after the last step. */
  render() {
    this._assertRunning('render');
    if (!this.view) {
      throw new ContractError('no_renderer', 'This adapter was initialized without a display, so render() cannot draw');
    }
    this.view.bindTrailData(this.simulation.trail, this.simulation.W, this.simulation.H);
    this.view.present();
    return this.getState();
  }

  /**
   * Change the viewport. The trail keeps its overlapping region and every agent
   * is wrapped into the new bounds. The seed and the iteration count stay.
   */
  resize(viewport) {
    this._assertRunning('resize');
    const next = this._validateViewport(viewport);
    const trail = this._trailSize(next, this.configuration.scale, this.limits);
    const changed =
      next.width !== this.viewport.width ||
      next.height !== this.viewport.height ||
      next.dpr !== this.viewport.dpr;
    if (!changed) return false;
    this.viewport = next;
    this.simulation.resize(trail.width, trail.height);
    this.view?.setSize(next.width, next.height);
    this.resizes += 1;
    return true;
  }

  /** Serializable state snapshot. The controller records this per capture. */
  getState() {
    const state = {
      contractVersion: CONTRACT_VERSION,
      artworkId: this.artworkId,
      seed: this.simulation ? this.simulation.seed : null,
      iteration: this.simulation ? this.simulation.iteration : 0,
      stepsRemaining: this.stepsRemaining,
      agents: this.simulation ? this.simulation.num : 0,
      trail: {
        width: this.simulation ? this.simulation.W : 0,
        height: this.simulation ? this.simulation.H : 0,
      },
      viewport: { ...this.viewport },
      configuration: { ...this.configuration },
      trailChecksum: this.simulation ? this.simulation.checksum() : 0,
      agentChecksum: this.simulation ? agentsChecksum(this.simulation) : 0,
      resizes: this.resizes,
      disposed: this.disposed,
      stepsPerFrame: this.configuration.speed ?? 1,
      renderer: readRendererInfo(this.view),
    };
    return assertState(state);
  }

  /** Free the display and the simulation. Safe to call more than once. */
  dispose() {
    if (this.view) {
      try {
        this.view.dispose();
      } finally {
        this.view = null;
      }
    }
    this.simulation = null;
    this.stepsRemaining = 0;
    this.disposed = true;
    return true;
  }

  /**
   * Live-playback palette change. Not part of the contract: this changes how
   * the trail is displayed, never the recorded evaluation configuration.
   */
  setDisplayPalette(name) {
    this._assertRunning('setDisplayPalette');
    if (!this.view) throw new ContractError('no_renderer', 'This adapter has no display to change');
    this.view.setPalette(name);
    this.displayPalette = name;
    return name;
  }

  _assertRunning(caller) {
    if (this.disposed || !this.simulation) {
      throw new ContractError('not_initialized', `${caller}() needs an initialized adapter; call initialize() first`);
    }
  }

  _validateViewport(viewport) {
    if (!viewport || typeof viewport !== 'object') {
      throw new ConfigurationError('viewport_missing', 'A viewport of {width, height, dpr} is required');
    }
    const { minWidth, minHeight, maxWidth, maxHeight, minDpr, maxDpr } = VIEWPORT_LIMITS;
    const width = viewport.width;
    const height = viewport.height;
    const dpr = viewport.dpr === undefined ? 1 : viewport.dpr;
    if (!Number.isFinite(width) || width < minWidth || width > maxWidth) {
      throw new ConfigurationError('viewport_invalid', `viewport.width must be from ${minWidth} to ${maxWidth}, got ${width}`, { value: width });
    }
    if (!Number.isFinite(height) || height < minHeight || height > maxHeight) {
      throw new ConfigurationError('viewport_invalid', `viewport.height must be from ${minHeight} to ${maxHeight}, got ${height}`, { value: height });
    }
    if (!Number.isFinite(dpr) || dpr < minDpr || dpr > maxDpr) {
      throw new ConfigurationError('viewport_invalid', `viewport.dpr must be from ${minDpr} to ${maxDpr}, got ${dpr}`, { value: dpr });
    }
    return { width: Math.round(width), height: Math.round(height), dpr };
  }

  /** Trail size from the viewport and the configured scale, inside the limits. */
  _trailSize(viewport, scale, limits) {
    if (!Number.isFinite(scale) || scale <= 0) {
      throw new ConfigurationError('scale_invalid', `configuration.scale must be a positive number, got ${scale}`, { value: scale });
    }
    const width = Math.max(MIN_TRAIL_PIXELS, Math.round(viewport.width * scale));
    const height = Math.max(MIN_TRAIL_PIXELS, Math.round(viewport.height * scale));
    const pixels = width * height;
    if (pixels > limits.maxTrailPixels) {
      throw new ConfigurationError(
        'trail_exceeds_limit',
        `A ${width}x${height} trail is ${pixels} pixels; the package limit is ${limits.maxTrailPixels}. Lower configuration.scale.`,
        { pixels, limit: limits.maxTrailPixels },
      );
    }
    return { width, height };
  }
}

/** Entry point named by manifest.entry. */
export async function createArtwork() {
  return new PhysarumAdapter();
}

export default createArtwork;
