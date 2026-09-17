// ─────────────────────────────────────────────────────────────────────────────
// snapshot-integrity.mjs — read one published snapshot and prove what it holds.
//
// A published snapshot is a directory that holds `files/` (the package, relative
// to its root) and `snapshot.json` (the marker). The marker names the content
// hash of the package and the hash of every file.
//
// This module never writes. Publication uses it to decide whether an existing
// directory can be reused; the integrity report uses it to describe history.
//
// Two hash conventions exist in the records of this repository:
//
//   canonical   the hash of the package-relative paths (`src/main.js`)
//   legacy      the hash of the paths as they were walked (`files/src/main.js`)
//
// The canonical form is the one `checkPackage` computes, so it is the hash a
// version record stores. A legacy marker is reported, never rewritten.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { hashDescribedFiles } from '../../../runtime/node/package-checks.js';

export const FILES_DIR = 'files';
export const MARKER_NAME = 'snapshot.json';

export async function readSnapshotMarker(dir) {
  try {
    return JSON.parse(await readFile(join(dir, MARKER_NAME), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Verify a snapshot directory against its own marker.
 *
 * @param {string} dir the snapshot directory that holds `files/` and the marker
 * @param {{expectedHash?: string|null}} [options]
 * @returns {Promise<{state: 'ok'|'missing'|'unreadable'|'hash_mismatch'|'conflict', markerHash: string|null, contentsHash: string|null, problems: string[]}>}
 */
export async function verifySnapshot(dir, { expectedHash = null } = {}) {
  const marker = await readSnapshotMarker(dir);
  if (!marker) return { state: 'missing', markerHash: null, contentsHash: null, problems: ['the snapshot marker is missing or unreadable'] };
  if (!Array.isArray(marker.files)) {
    return { state: 'unreadable', markerHash: marker.packageHash ?? null, contentsHash: null, problems: ['the marker holds no file list'] };
  }

  const problems = [];
  const described = [];
  for (const entry of marker.files) {
    if (!entry || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string') {
      problems.push('the marker holds a file entry without a path or a hash');
      continue;
    }
    let body;
    try {
      body = await readFile(join(dir, FILES_DIR, entry.path));
    } catch {
      problems.push(`${entry.path} is named by the marker but is not present`);
      continue;
    }
    const digest = createHash('sha256').update(body).digest('hex');
    if (digest !== entry.sha256) problems.push(`${entry.path} has hash ${digest.slice(0, 12)}, the marker names ${entry.sha256.slice(0, 12)}`);
    described.push({ path: entry.path, sha256: digest });
  }

  const contentsHash = described.length > 0 ? hashDescribedFiles(described) : null;
  const markerHash = typeof marker.packageHash === 'string' ? marker.packageHash : null;
  if (markerHash && contentsHash && markerHash !== contentsHash) {
    problems.push(`the marker names content hash ${markerHash.slice(0, 12)}, the files hash to ${contentsHash.slice(0, 12)}`);
  }
  if (expectedHash && contentsHash && contentsHash !== expectedHash) {
    problems.push(`the directory is named ${expectedHash.slice(0, 12)}, but its files hash to ${contentsHash.slice(0, 12)}`);
  }
  if (problems.length > 0) {
    return { state: 'hash_mismatch', markerHash, contentsHash, problems };
  }
  return { state: 'ok', markerHash, contentsHash, problems: [] };
}

/**
 * Verify every snapshot of one artwork root. Read-only.
 * @param {string} artworkRoot `<snapshots>/<artworkId>`
 */
export async function reportArtworkSnapshots(artworkRoot, { listDirectories }) {
  const names = await listDirectories(artworkRoot);
  const rows = [];
  for (const name of names) {
    const verdict = await verifySnapshot(join(artworkRoot, name), { expectedHash: name });
    rows.push({ directory: name, ...verdict });
  }
  return rows;
}
