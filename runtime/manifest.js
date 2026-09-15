// ─────────────────────────────────────────────────────────────────────────────
// manifest.js — the artwork package manifest: its schema, and the path rules
// that decide which package files an author may change.
//
// A package declares every file it ships. A file that is neither editable nor
// protected is undeclared, and validation rejects the package.
// ─────────────────────────────────────────────────────────────────────────────
import { PackageError, isPlainObject } from './contract.js';
import { validateAgainstSchema } from './schema.js';

export const MANIFEST_VERSION = 1;

const NON_EMPTY_STRING = { type: 'string', minLength: 1 };

export const MANIFEST_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'manifestVersion',
    'id',
    'title',
    'contractVersion',
    'entry',
    'configuration',
    'allowedEditPaths',
    'protectedPaths',
    'pinnedDependencies',
    'resourceLimits',
    'evaluation',
    'browserCapabilities',
    'assets',
    'licenses',
  ],
  properties: {
    manifestVersion: { type: 'integer', enum: [MANIFEST_VERSION] },
    id: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{1,63}$' },
    title: { type: 'string', minLength: 1, maxLength: 120 },
    description: { type: 'string', maxLength: 400 },
    contractVersion: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+$' },
    entry: NON_EMPTY_STRING,
    configuration: {
      type: 'object',
      additionalProperties: false,
      required: ['baseline', 'schema'],
      properties: { baseline: NON_EMPTY_STRING, schema: NON_EMPTY_STRING },
    },
    allowedEditPaths: { type: 'array', minItems: 1, items: NON_EMPTY_STRING },
    protectedPaths: { type: 'array', items: NON_EMPTY_STRING },
    pinnedDependencies: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'version'],
        properties: {
          name: NON_EMPTY_STRING,
          version: { type: 'string', pattern: '^\\d+\\.\\d+\\.\\d+([-+][0-9A-Za-z.-]+)?$' },
        },
      },
    },
    resourceLimits: {
      type: 'object',
      additionalProperties: false,
      required: [
        'maxPackageBytes',
        'maxFiles',
        'maxAgents',
        'maxTrailPixels',
        'maxStepsPerEvaluation',
        'maxPlaybackSteps',
      ],
      properties: {
        maxPackageBytes: { type: 'integer', minimum: 1024 },
        maxFiles: { type: 'integer', minimum: 1 },
        maxAgents: { type: 'integer', minimum: 1 },
        maxTrailPixels: { type: 'integer', minimum: 4096 },
        maxStepsPerEvaluation: { type: 'integer', minimum: 1 },
        maxPlaybackSteps: { type: 'integer', minimum: 1 },
      },
    },
    evaluation: {
      type: 'object',
      additionalProperties: false,
      required: ['viewport', 'seedCount', 'captureStages', 'requiredMetadata'],
      properties: {
        viewport: {
          type: 'object',
          additionalProperties: false,
          required: ['width', 'height', 'dpr'],
          properties: {
            width: { type: 'integer', minimum: 1 },
            height: { type: 'integer', minimum: 1 },
            dpr: { type: 'number', minimum: 0.1, maximum: 8 },
          },
        },
        seedCount: { type: 'integer', minimum: 2, maximum: 8 },
        captureStages: {
          type: 'object',
          additionalProperties: false,
          required: ['candidates', 'finalist'],
          properties: {
            candidates: { type: 'array', minItems: 1, items: NON_EMPTY_STRING },
            finalist: { type: 'array', minItems: 1, items: NON_EMPTY_STRING },
          },
        },
        requiredMetadata: { type: 'array', minItems: 1, items: NON_EMPTY_STRING },
      },
    },
    browserCapabilities: {
      type: 'object',
      additionalProperties: false,
      required: ['canvas', 'webgl2'],
      properties: {
        canvas: { type: 'boolean' },
        webgl2: { type: 'boolean' },
        requiredExtensions: { type: 'array', items: NON_EMPTY_STRING },
      },
    },
    assets: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'sha256', 'license'],
        properties: {
          path: NON_EMPTY_STRING,
          sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          license: NON_EMPTY_STRING,
          source: NON_EMPTY_STRING,
        },
      },
    },
    licenses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['asset', 'license'],
        properties: { asset: NON_EMPTY_STRING, license: NON_EMPTY_STRING, source: NON_EMPTY_STRING },
      },
    },
  },
};

/** @returns {{valid: boolean, errors: object[]}} */
export function validateManifest(manifest) {
  return validateAgainstSchema(manifest, MANIFEST_SCHEMA);
}

/** Throw a PackageError unless `manifest` matches MANIFEST_SCHEMA. */
export function assertManifest(manifest, label = 'manifest.json') {
  const { valid, errors } = validateManifest(manifest);
  if (!valid) {
    throw new PackageError('manifest_invalid', `${label} is invalid (${errors.length} problem(s)); first: ${errors[0].message}`, { errors });
  }
  return manifest;
}

/**
 * A safe package-relative path: forward slashes, no drive letter, no absolute
 * root, no `..` step, no empty segment.
 */
export function isSafeRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  if (value.includes('\\')) return false;
  if (value.startsWith('/') || value.startsWith('~')) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  const body = value.endsWith('/') ? value.slice(0, -1) : value;
  const segments = body.split('/');
  if (segments[0] === '.') segments.shift();
  if (segments.length === 0) return false;
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/** Normalize a declared entry to a comparable package-relative path. */
export function normalizeEntry(entry) {
  return entry.replace(/\\/g, '/').replace(/^\.\//, '');
}

/** True when `relPath` is the entry itself or lies below a directory entry. */
export function pathIsCovered(relPath, entries) {
  const target = normalizeEntry(relPath);
  return entries.some((rawEntry) => {
    const entry = normalizeEntry(rawEntry);
    if (entry.endsWith('/')) return target.startsWith(entry);
    return target === entry;
  });
}

/**
 * Classify one package-relative file path. A protected entry wins over an
 * editable one, so a package can make a whole directory editable and still
 * protect single files inside it.
 * @returns {'editable'|'protected'|'undeclared'}
 */
export function classifyPackageFile(relPath, manifest) {
  if (pathIsCovered(relPath, manifest.protectedPaths ?? [])) return 'protected';
  if (pathIsCovered(relPath, manifest.allowedEditPaths ?? [])) return 'editable';
  return 'undeclared';
}

/** True when a declared path may be changed by an author session. */
export function isEditablePath(relPath, manifest) {
  return classifyPackageFile(relPath, manifest) === 'editable';
}

/**
 * Manifest-internal path problems, independent of the file system: unsafe
 * entries, repeated entries, dead edit paths, and editable trust files.
 *
 * The entry module and the configuration schema are trust files. An author who
 * can change them can leave the contract or widen its bounds, so they must be
 * protected.
 *
 * @returns {string[]} problem descriptions
 */
export function collectManifestPathProblems(manifest) {
  const problems = [];
  const groups = [
    ['allowedEditPaths', manifest.allowedEditPaths ?? []],
    ['protectedPaths', manifest.protectedPaths ?? []],
    ['entry', [manifest.entry]],
    ['configuration.baseline', [manifest.configuration?.baseline]],
    ['configuration.schema', [manifest.configuration?.schema]],
  ];
  for (const [label, entries] of groups) {
    for (const entry of entries) {
      if (entry === undefined) continue;
      if (!isSafeRelativePath(entry)) problems.push(`${label} has an unsafe path: ${entry}`);
    }
  }

  const edits = (manifest.allowedEditPaths ?? []).map(normalizeEntry);
  const dupes = edits.filter((entry, index) => edits.indexOf(entry) !== index);
  for (const dupe of new Set(dupes)) problems.push(`allowedEditPaths repeats ${dupe}`);

  for (const entry of edits) {
    if (pathIsCovered(entry.replace(/\/$/, ''), manifest.protectedPaths ?? [])) {
      problems.push(`allowedEditPaths entry ${entry} is protected and can never be edited`);
    }
  }

  const trustFiles = [
    ['entry', manifest.entry],
    ['configuration.schema', manifest.configuration?.schema],
  ];
  for (const [label, entry] of trustFiles) {
    if (typeof entry !== 'string' || !isSafeRelativePath(entry)) continue;
    if (isEditablePath(entry, manifest)) problems.push(`${label} (${entry}) must be protected, but it is editable`);
  }
  return problems;
}

/** True when the object looks like a parsed manifest. */
export function isManifest(value) {
  return isPlainObject(value) && typeof value.id === 'string' && typeof value.entry === 'string';
}
