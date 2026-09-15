// ─────────────────────────────────────────────────────────────────────────────
// workspace.mjs — candidate workspaces, the edit surface, and publication.
//
// An author session gets its own copy of the artwork package. It may change the
// files the manifest allows and nothing else. This module enforces that rule
// and reports every change, so the record holds the real difference.
// ─────────────────────────────────────────────────────────────────────────────
import { cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { classifyPackageFile, isEditablePath } from '../../../runtime/manifest.js';
import { IGNORED_DIRS, hashPackageFiles, snapshotMarker, walkPackage } from '../../../runtime/node/package-checks.js';

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

/** Copy the accepted workspace to its immutable snapshot directory. */
export async function publishSnapshot({ workspaceDir, snapshotRoot, artworkId, packageHash }) {
  const target = join(snapshotRoot, artworkId, packageHash);
  const marker = join(target, 'snapshot.json');
  try {
    await stat(marker);
    return { path: target, created: false, packageHash };
  } catch {
    // not published yet
  }

  const working = join(snapshotRoot, artworkId, `.pending-${packageHash}-${process.pid}`);
  await rm(working, { recursive: true, force: true });
  await mkdir(working, { recursive: true });
  await cp(workspaceDir, join(working, 'files'), {
    recursive: true,
    filter: (source) => !SKIP_DIRS.has(source.split(/[\\/]/).pop()),
  });

  const walked = (await walkPackage(working)).filter((file) => !file.symlink);
  const { files, packageHash: computed } = await hashPackageFiles(walked);
  await writeFile(
    join(working, 'snapshot.json'),
    snapshotMarker({
      artworkId,
      packageHash: computed,
      files: files.map((file) => ({ ...file, path: file.path.replace(/^files\//, '') })),
    }),
    { encoding: 'utf8', flag: 'wx' },
  );

  try {
    await stat(target);
    // another worker published the same hash first; keep the existing one
    await rm(working, { recursive: true, force: true });
    return { path: target, created: false, packageHash: computed };
  } catch {
    // the target is free
  }
  await mkdir(dirname(target), { recursive: true });
  await rename(working, target);
  return { path: target, created: true, packageHash: computed };
}

/** The candidate workspace file list, for diagnostics. */
export async function workspaceFiles(workspaceDir) {
  return (await readdir(workspaceDir)).map(toPosix);
}


