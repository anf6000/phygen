// ─────────────────────────────────────────────────────────────────────────────
// contract.js — the artwork runtime contract (version 1.0.0).
//
// This module is the trusted side of the artwork boundary. Every artwork
// package imports it; the controller and the validators also import it. It has
// no dependencies, so the browser and Node can both load it.
//
// An artwork package supplies ONE entry module that default-exports a factory.
// The factory returns an adapter with exactly these methods:
//
//   initialize(options)  seed, viewport, configuration
//   reset(options)       clear the artwork state; optional new seed
//   step(count)          advance the simulation by an explicit step count
//   render()             draw the current state to the canvas
//   resize(viewport)     change the pixel size (explicit resize policy)
//   getState()           serializable state snapshot
//   dispose()            free every resource
//
// The adapter is part of the trusted runtime. Authors may not edit it, so the
// controller can compare candidates without trusting author claims.
// ─────────────────────────────────────────────────────────────────────────────

/** The contract version this runtime implements. */
export const CONTRACT_VERSION = '1.0.0';

/** The complete adapter surface. Nothing else is guaranteed. */
export const ADAPTER_METHODS = Object.freeze([
  'initialize',
  'reset',
  'step',
  'render',
  'resize',
  'getState',
  'dispose',
]);

/** The fields every `getState()` result must contain. */
export const STATE_FIELDS = Object.freeze([
  'contractVersion',
  'artworkId',
  'seed',
  'iteration',
  'stepsRemaining',
  'agents',
  'trail',
  'viewport',
  'configuration',
  'trailChecksum',
  'agentChecksum',
  'resizes',
  'disposed',
]);

/** Base class for every error this runtime raises. */
export class ArtworkError extends Error {
  /**
   * @param {string} code   stable machine-readable code
   * @param {string} message human-readable text
   * @param {object} [details] extra evidence (paths, urls, values)
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ArtworkError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { name: this.name, code: this.code, message: this.message, details: this.details };
  }
}

/**
 * The requested configuration is missing, unreadable, malformed, or outside
 * the declared schema. A candidate must fail on this error. It must never fall
 * back to the baseline configuration.
 */
export class ConfigurationError extends ArtworkError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'ConfigurationError';
  }
}

/** The package is malformed, unsafe, or does not follow the contract. */
export class PackageError extends ArtworkError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'PackageError';
  }
}

/** A contract call was made in the wrong order, or with wrong arguments. */
export class ContractError extends ArtworkError {
  constructor(code, message, details = {}) {
    super(code, message, details);
    this.name = 'ContractError';
  }
}

export function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Names of the contract methods that `value` does not provide. */
export function missingAdapterMethods(value) {
  if (value === null || value === undefined) return [...ADAPTER_METHODS];
  return ADAPTER_METHODS.filter((name) => typeof value[name] !== 'function');
}

/**
 * Throw a PackageError if `value` is not a complete adapter.
 * @param {unknown} value
 * @param {string} [label] name used in the error message
 */
export function assertAdapter(value, label = 'artwork entry') {
  const missing = missingAdapterMethods(value);
  if (missing.length > 0) {
    throw new PackageError(
      'adapter_incomplete',
      `${label} is missing the contract methods: ${missing.join(', ')}`,
      { missing },
    );
  }
  return value;
}

/**
 * Throw a PackageError when a package declares a contract version this runtime
 * cannot run. Only the major version must match.
 */
export function assertContractVersion(declared, label = 'package') {
  const text = String(declared ?? '');
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (!match) {
    throw new PackageError('contract_version_invalid', `${label} has an invalid contract version: ${text}`, { declared });
  }
  const major = Number(match[1]);
  const ours = Number(CONTRACT_VERSION.split('.')[0]);
  if (major !== ours) {
    throw new PackageError(
      'contract_version_unsupported',
      `${label} needs contract ${text}; this runtime implements ${CONTRACT_VERSION}`,
      { declared, supported: CONTRACT_VERSION },
    );
  }
  return text;
}

/** Throw a ContractError if a `getState()` result is malformed. */
export function assertState(state, label = 'artwork state') {
  if (!isPlainObject(state)) {
    throw new ContractError('state_malformed', `${label} is not an object`);
  }
  const missing = STATE_FIELDS.filter((field) => state[field] === undefined);
  if (missing.length > 0) {
    throw new ContractError(
      'state_incomplete',
      `${label} is missing the fields: ${missing.join(', ')}`,
      { missing },
    );
  }
  for (const field of ['trail', 'viewport', 'configuration']) {
    if (!isPlainObject(state[field])) {
      throw new ContractError('state_malformed', `${label}.${field} is not an object`, { field });
    }
  }
  for (const field of ['iteration', 'agents', 'resizes', 'trailChecksum', 'agentChecksum']) {
    if (typeof state[field] !== 'number' || !Number.isFinite(state[field])) {
      throw new ContractError('state_malformed', `${label}.${field} is not a finite number`, { field });
    }
  }
  return state;
}

/**
 * FNV-1a 32-bit hash. Small, dependency-free, and identical in Node and the
 * browser, so a checksum computed during capture can be compared later.
 */
export function fnv1a(bytes, offset = 0x811c9dc5) {
  let h = offset >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** FNV-1a over the raw bytes of a typed array. */
export function hashTypedArray(array) {
  const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
  return fnv1a(bytes);
}
