// ─────────────────────────────────────────────────────────────────────────────
// workspace.mjs — candidate workspaces, the edit surface, and publication.
//
// An author session gets its own copy of the artwork package. It may change the
// files the manifest allows and nothing else. This module enforces that rule
// and reports every change, so the record holds the real difference.
// ─────────────────────────────────────────────────────────────────────────────
import { randomUUID } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ArtworkError } from '../../../runtime/contract.js';
import { classifyPackageFile, isEditablePath } from '../../../runtime/manifest.js';
import { IGNORED_DIRS, hashPackageFiles, snapshotMarker, walkPackage } from '../../../runtime/node/package-checks.js';
import { FILES_DIR, MARKER_NAME, readSnapshotMarker, verifySnapshot } from './snapshot-integrity.mjs';

// One ignore list for the whole system: the validator owns it.
const SKIP_DIRS = new Set(IGNORED_DIRS);

function toPosix(value) {
  return value.split('\\').join('/');
}

/** Copy a package into a private workspace, without dependencies or history. */
export async function copyPackage(sourceDir, targetDir) {
  await rm(targetDir, { recursive: true, force: true });
  await mkdir(dirname(targetDir), { recursive: true });
  await cp(sourceDir, targetDir, {
    recursive: true,
    filter: (source) => {
      const name = source.split(/[\\/]/).pop();
      return !SKIP_DIRS.has(name);
    },
  });
  return targetDir;
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/**
 * Compare a candidate workspace with the package it came from.
 *
 * @returns {Promise<{changed: object[], added: string[], removed: string[], violations: string[], changes: object[]}>}
 */
export async function reviewEdits({ originalDir, workspaceDir, manifest }) {
  const workspaceFiles = (await walkPackage(workspaceDir)).filter((file) => !file.symlink);
  const originalFiles = (await walkPackage(originalDir)).filter((file) => !file.symlink);
  const originalByPath = new Map(originalFiles.map((file) => [file.rel, file]));

  const violations = [];
  const changed = [];
  const added = [];
  const changes = [];

  for (const file of workspaceFiles) {
    if (!isEditablePath(file.rel, manifest)) {
      const original = originalByPath.get(file.rel);
      if (!original) {
        violations.push(`${file.rel} was added, but the manifest does not allow edits there`);
        continue;
      }
      const [before, after] = await Promise.all([readFile(original.full), readFile(file.full)]);
      if (!before.equals(after)) violations.push(`${file.rel} was changed, but the manifest protects it`);
      continue;
    }
    const original = originalByPath.get(file.rel);
    if (!original) {
      added.push(file.rel);
      changes.push({ path: file.rel, status: 'added', summary: '', added: 0, removed: 0 });
      continue;
    }
    const [before, after] = await Promise.all([readFile(original.full), readFile(file.full)]);
    if (before.equals(after)) continue;
    const stats = lineStats(before.toString('utf8'), after.toString('utf8'));
    changed.push(file.rel);
    changes.push({ path: file.rel, status: 'changed', summary: '', ...stats });
  }

  const workspacePaths = new Set(workspaceFiles.map((file) => file.rel));
  const removed = [];
  for (const file of originalFiles) {
    if (workspacePaths.has(file.rel)) continue;
    if (!isEditablePath(file.rel, manifest)) {
      violations.push(`${file.rel} was deleted, but the manifest protects it`);
      continue;
    }
    removed.push(file.rel);
    changes.push({ path: file.rel, status: 'removed', summary: '', added: 0, removed: 0 });
  }

  for (const file of await walkPackage(workspaceDir)) {
    if (file.symlink) violations.push(`${file.rel} is a symbolic link, which a candidate may not create`);
  }

  return { changed, added, removed, violations, changes };
}

/** Added and removed line counts for one text pair. */
export function lineStats(before, after) {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  if (beforeLines.length > 4000 || afterLines.length > 4000) {
    return approximateLineStats(beforeLines, afterLines);
  }
  const common = longestCommonSubsequence(beforeLines, afterLines);
  return { added: afterLines.length - common, removed: beforeLines.length - common };
}

function approximateLineStats(beforeLines, afterLines) {
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < beforeLines.length - prefix &&
    suffix < afterLines.length - prefix &&
    beforeLines[beforeLines.length - 1 - suffix] === afterLines[afterLines.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { added: afterLines.length - prefix - suffix, removed: beforeLines.length - prefix - suffix };
}

/** The length of the longest common subsequence of two line arrays. */
function longestCommonSubsequence(a, b) {
  const previous = new Uint32Array(b.length + 1);
  const current = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous.set(current);
  }
  return previous[b.length];
}

/**
 * The canonical hash mapping of one artwork. A snapshot published before the
 * path convention was corrected carries a marker that names the hash of
 * `files/…` paths. The evidence stays as it is; this file records the mapping
 * from that directory to the hash of its real contents.
 */
export const CANONICAL_MAP_NAME = 'canonical-hashes.json';

async function recordCanonicalHash(artworkRoot, entry) {
  const path = join(artworkRoot, CANONICAL_MAP_NAME);
  let map = {};
  try {
    map = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    map = {};
  }
  map[entry.directory] = { ...entry, recordedAt: new Date().toISOString() };
  await writeFile(path, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
}

/** Reuse a directory only when its real contents hash to the requested value. */
async function reuseSnapshot(target, packageHash) {
  const verdict = await verifySnapshot(target, { expectedHash: packageHash });
  if (verdict.contentsHash !== packageHash) {
    throw new ArtworkError('snapshot_conflict', `The snapshot directory ${packageHash.slice(0, 12)} holds different content`, {
      problems: verdict.problems,
    });
  }
  if (verdict.state !== 'ok') {
    // The content is correct and the directory name is correct; an older
    // publication wrote a marker that used the wrong path prefix. Keep it.
    await recordCanonicalHash(dirname(target), {
      directory: packageHash,
      markerHash: verdict.markerHash,
      contentsHash: packageHash,
      problems: verdict.problems,
    });
    return { path: target, created: false, packageHash, verified: false, legacyMarkerHash: verdict.markerHash };
  }
  return { path: target, created: false, packageHash, verified: true, legacyMarkerHash: null };
}

/**
 * Copy the accepted workspace to its immutable snapshot directory.
 *
 * The hash covers package-relative paths, exactly as `checkPackage` computes it,
 * so the directory name, the marker, the returned value, and the version record
 * all agree. An existing directory is reused only after its file hashes are
 * verified.
 */
export async function publishSnapshot({ workspaceDir, snapshotRoot, artworkId, packageHash }) {
  const artworkRoot = join(snapshotRoot, artworkId);
  const target = join(artworkRoot, packageHash);
  await mkdir(artworkRoot, { recursive: true });

  if (await readSnapshotMarker(target)) return reuseSnapshot(target, packageHash);

  // A unique working directory: two publications of the same hash must never
  // share one, or each would delete the other's files.
  const working = join(artworkRoot, `.pending-${packageHash}-${process.pid}-${randomUUID()}`);
  await rm(working, { recursive: true, force: true });
  await mkdir(working, { recursive: true });
  await cp(workspaceDir, join(working, FILES_DIR), {
    recursive: true,
    filter: (source) => !SKIP_DIRS.has(source.split(/[\\/]/).pop()),
  });

  // Hash the package relative to its own root. Walking `files/` would put the
  // prefix into every path and produce a hash that no other check agrees with.
  const walked = (await walkPackage(join(working, FILES_DIR))).filter((file) => !file.symlink);
  const { files, packageHash: computed } = await hashPackageFiles(walked);
  if (computed !== packageHash) {
    await rm(working, { recursive: true, force: true });
    throw new ArtworkError('snapshot_hash_mismatch', 'The published files do not hash to the validated package hash', {
      computed,
      requested: packageHash,
    });
  }
  await writeFile(join(working, MARKER_NAME), snapshotMarker({ artworkId, packageHash: computed, files }), {
    encoding: 'utf8',
    flag: 'wx',
  });

  try {
    await stat(target);
    // Another worker published the same hash first. Verify it, then drop this one.
    const reused = await reuseSnapshot(target, packageHash);
    await rm(working, { recursive: true, force: true });
    return reused;
  } catch (error) {
    if (error instanceof ArtworkError) throw error;
    // The target is free.
  }

  try {
    await rename(working, target);
  } catch (error) {
    if (['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) {
      // A concurrent publication won the rename. Its directory is complete,
      // because a rename of a complete working directory is atomic.
      await rm(working, { recursive: true, force: true });
      return { path: target, created: false, packageHash, verified: true, legacyMarkerHash: null };
    }
    await rm(working, { recursive: true, force: true });
    throw error;
  }
  return { path: target, created: true, packageHash, verified: true, legacyMarkerHash: null };
}

/** The candidate workspace file list, for diagnostics. */
export async function workspaceFiles(workspaceDir) {
  return (await readdir(workspaceDir)).map(toPosix);
}


