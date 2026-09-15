// ─────────────────────────────────────────────────────────────────────────────
// package-checks.js — validate one artwork package on the file system.
//
// This module is for Node only. The tool in an artwork package and the
// controller both use it, so an imported package is checked exactly once, in
// exactly one place.
//
// It rejects unsafe paths, symbolic-link escapes, oversized packages,
// undeclared files, unapproved dependencies, an entry module that does not
// follow the contract, a baseline configuration that breaks its own schema,
// and a declared asset whose hash does not match.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ADAPTER_METHODS, CONTRACT_VERSION, assertAdapter, assertContractVersion } from '../contract.js';
import { validateConfiguration } from '../config.js';
import {
  assertManifest,
  classifyPackageFile,
  collectManifestPathProblems,
} from '../manifest.js';

export const IGNORED_DIRS = Object.freeze(['node_modules', '.git', 'snapshots', '.cache', 'dist']);
export const DEFAULT_LIMITS = Object.freeze({
  maxPackageBytes: 2097152,
  maxFiles: 64,
  maxAgents: 200000,
  maxTrailPixels: 4194304,
  maxStepsPerEvaluation: 20000,
  maxPlaybackSteps: 2000000,
});

function toPosix(value) {
  return value.split('\\').join('/');
}

async function readJson(path, problems, label) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    problems.push(`${label} cannot be read as JSON: ${error.message}`);
    return null;
  }
}

/** Collect every package file. Symlinks are reported, never followed. */
export async function walkPackage(root, dir = root, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = toPosix(relative(root, full));
    if (entry.isSymbolicLink()) {
      out.push({ rel, full, symlink: true });
    } else if (entry.isDirectory()) {
      if (IGNORED_DIRS.includes(entry.name)) continue;
      await walkPackage(root, full, out);
    } else if (entry.isFile()) {
      out.push({ rel, full, symlink: false });
    }
  }
  return out;
}

/** The hash of one file, and of the sorted set of all package files. */
export async function hashPackageFiles(files) {
  const described = [];
  for (const file of files) {
    if (file.symlink) continue;
    const body = await readFile(file.full);
    described.push({
      path: file.rel,
      bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'),
    });
  }
  described.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const hash = createHash('sha256');
  for (const file of described) hash.update(`${file.path}\0${file.sha256}\n`);
  return { files: described, packageHash: hash.digest('hex') };
}

async function checkDeclaredPath(root, realRoot, label, entry, problems) {
  const target = resolve(root, entry);
  let info;
  try {
    info = await stat(target);
  } catch {
    problems.push(`${label} declares ${entry}, but that path does not exist`);
    return null;
  }
  let real;
  try {
    real = await realpath(target);
  } catch (error) {
    problems.push(`${label} cannot resolve ${entry}: ${error.message}`);
    return null;
  }
  const inside = relative(realRoot, real);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    problems.push(`${label} declares ${entry}, which resolves outside the package`);
    return null;
  }
  return info;
}

async function checkManifestAndPaths(root, realRoot, problems, notes) {
  const manifest = await readJson(join(root, 'manifest.json'), 'manifest.json', problems);
  if (!manifest) return null;

  try {
    assertManifest(manifest);
  } catch (error) {
    problems.push(error.message);
    for (const detail of error.details?.errors ?? []) problems.push(`manifest.json ${detail.message}`);
    return manifest;
  }

  try {
    assertContractVersion(manifest.contractVersion, 'manifest.json');
  } catch (error) {
    problems.push(error.message);
  }

  for (const problem of collectManifestPathProblems(manifest)) problems.push(problem);

  await checkDeclaredPath(root, realRoot, 'entry', manifest.entry, problems);
  await checkDeclaredPath(root, realRoot, 'configuration.baseline', manifest.configuration.baseline, problems);
  await checkDeclaredPath(root, realRoot, 'configuration.schema', manifest.configuration.schema, problems);
  for (const entry of manifest.allowedEditPaths) await checkDeclaredPath(root, realRoot, 'allowedEditPaths', entry, problems);
  for (const entry of manifest.protectedPaths) await checkDeclaredPath(root, realRoot, 'protectedPaths', entry, problems);

  notes.push(`${manifest.id}: entry ${manifest.entry}, contract ${manifest.contractVersion}`);
  notes.push(`${manifest.allowedEditPaths.length} editable path(s), ${manifest.protectedPaths.length} protected path(s)`);
  return manifest;
}

async function checkFiles(root, manifest, problems, notes) {
  const files = await walkPackage(root);
  let bytes = 0;

  for (const file of files) {
    if (file.symlink) {
      problems.push(`the package contains a symbolic link: ${file.rel}`);
      continue;
    }
    const info = await stat(file.full);
    bytes += info.size;
    if (classifyPackageFile(file.rel, manifest) === 'undeclared') {
      problems.push(`${file.rel} is neither editable nor protected, so the package does not declare it`);
    }
  }

  const limits = { ...DEFAULT_LIMITS, ...manifest.resourceLimits };
  if (files.length > limits.maxFiles) problems.push(`the package has ${files.length} files; the limit is ${limits.maxFiles}`);
  if (bytes > limits.maxPackageBytes) problems.push(`the package is ${bytes} bytes; the limit is ${limits.maxPackageBytes}`);
  notes.push(`${files.length} file(s), ${bytes} bytes`);
  return { files, bytes };
}

async function checkConfiguration(root, manifest, problems, notes) {
  const schema = await readJson(resolve(root, manifest.configuration.schema), manifest.configuration.schema, problems);
  const baseline = await readJson(resolve(root, manifest.configuration.baseline), manifest.configuration.baseline, problems);
  if (!schema || !baseline) return;
  try {
    validateConfiguration(baseline, schema);
    notes.push(`${manifest.configuration.baseline} matches ${manifest.configuration.schema}`);
  } catch (error) {
    problems.push(error.message);
    for (const detail of error.details?.errors ?? []) problems.push(`${manifest.configuration.baseline} ${detail.message}`);
  }
}

async function checkDependencies(root, manifest, problems, notes) {
  const pkg = await readJson(join(root, 'package.json'), 'package.json', problems);
  if (!pkg) return;
  const declared = new Map(manifest.pinnedDependencies.map((entry) => [entry.name, entry.version]));
  const required = Object.keys(pkg.dependencies ?? {});

  for (const name of required) {
    if (!declared.has(name)) problems.push(`package.json declares ${name}, but the manifest does not approve it`);
  }
  for (const [name] of declared) {
    if (!required.includes(name)) problems.push(`the manifest pins ${name}, but package.json does not declare it`);
  }

  const lock = await readJson(join(root, 'package-lock.json'), 'package-lock.json', problems);
  if (!lock) {
    problems.push('package-lock.json is unavailable, so no dependency version is pinned');
    return;
  }
  for (const [name, version] of declared) {
    const locked = lock.packages?.[`node_modules/${name}`]?.version ?? null;
    if (locked === null) problems.push(`package-lock.json has no entry for ${name}`);
    else if (locked !== version) problems.push(`${name} is pinned to ${version} in the manifest, but package-lock.json has ${locked}`);
    else notes.push(`${name} is pinned to ${version}`);
  }
}

async function checkAssets(root, manifest, problems, notes) {
  for (const asset of manifest.assets ?? []) {
    const path = resolve(root, asset.path);
    let info;
    try {
      info = await stat(path);
    } catch {
      problems.push(`the declared asset ${asset.path} does not exist`);
      continue;
    }
    if (!info.isFile()) {
      problems.push(`the declared asset ${asset.path} is not a file`);
      continue;
    }
    const digest = createHash('sha256').update(await readFile(path)).digest('hex');
    if (digest !== asset.sha256) problems.push(`the asset ${asset.path} has hash ${digest}; the manifest declares ${asset.sha256}`);
    else notes.push(`asset ${asset.path} matches its declared hash`);
  }
}

/**
 * Check the entry module WITHOUT running it.
 *
 * Importing a package entry executes it with full process privileges, so the
 * default check is static. The real contract check happens when the artwork
 * page loads the adapter: a broken adapter fails the run there.
 */
async function checkEntryStatic(root, manifest, problems, notes) {
  const entryPath = resolve(root, manifest.entry);
  let source;
  try {
    source = await readFile(entryPath, 'utf8');
  } catch (error) {
    problems.push(`${manifest.entry} cannot be read: ${error.message}`);
    return;
  }
  if (!/(^|\s)export\s+default|export\s*\{/.test(source)) {
    problems.push(`${manifest.entry} has no default export`);
    return;
  }
  const missing = ADAPTER_METHODS.filter((name) => !new RegExp(`\\b${name}\\b`).test(source));
  if (missing.length > 0) {
    problems.push(`${manifest.entry} does not declare the contract methods: ${missing.join(', ')}`);
    return;
  }
  notes.push(`${manifest.entry} declares the contract surface (static check)`);
}

/** Import the entry module and call its factory. Use only for your own package. */
async function checkEntryByImport(root, manifest, problems, notes) {
  const entryPath = resolve(root, manifest.entry);
  let module;
  try {
    module = await import(pathToFileURL(entryPath).href);
  } catch (error) {
    problems.push(`${manifest.entry} cannot be imported: ${error.message}`);
    return;
  }
  if (module.contractVersion && module.contractVersion !== CONTRACT_VERSION) {
    problems.push(`${manifest.entry} exports contract ${module.contractVersion}; this runtime implements ${CONTRACT_VERSION}`);
  }
  if (typeof module.default !== 'function') {
    problems.push(`${manifest.entry} has no default-exported factory`);
    return;
  }
  try {
    assertAdapter(await module.default(), manifest.entry);
    notes.push(`${manifest.entry} provides every contract method`);
  } catch (error) {
    problems.push(error.message);
  }
}

/**
 * The immutable marker that completes a snapshot. One writer for every
 * producer, so the record shape cannot drift.
 */
export function snapshotMarker({ artworkId, contractVersion = CONTRACT_VERSION, packageHash, files, createdAt = new Date().toISOString() }) {
  return `${JSON.stringify(
    {
      snapshotVersion: 1,
      artworkId,
      contractVersion,
      packageHash,
      createdAt,
      files,
    },
    null,
    2,
  )}\n`;
}

/**
 * Check one artwork package.
 * @param {object} options
 * @param {string} options.packageDir absolute path of the package
 * @param {boolean} [options.verifyEntry] IMPORT and RUN the entry module. Off by default: importing a package runs its code in this process.
 * @returns {Promise<{ok: boolean, problems: string[], notes: string[], manifest: object|null, packageHash: string|null, files: object[]}>}
 */
export async function checkPackage({ packageDir, verifyEntry = false }) {
  const problems = [];
  const notes = [];
  const result = { ok: false, problems, notes, manifest: null, packageHash: null, files: [] };

  let realRoot;
  try {
    realRoot = await realpath(packageDir);
  } catch (error) {
    problems.push(`${packageDir} is not readable: ${error.message}`);
    return result;
  }

  const manifest = await checkManifestAndPaths(packageDir, realRoot, problems, notes);
  result.manifest = manifest;
  if (!manifest || problems.length > 0) return result;

  const { files } = await checkFiles(packageDir, manifest, problems, notes);
  result.files = files;
  await checkConfiguration(packageDir, manifest, problems, notes);
  await checkDependencies(packageDir, manifest, problems, notes);
  await checkAssets(packageDir, manifest, problems, notes);
  if (verifyEntry) await checkEntryByImport(packageDir, manifest, problems, notes);
  else await checkEntryStatic(packageDir, manifest, problems, notes);

  const { packageHash } = await hashPackageFiles(files);
  result.packageHash = packageHash;
  result.ok = problems.length === 0;
  return result;
}
