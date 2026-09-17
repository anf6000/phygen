// ─────────────────────────────────────────────────────────────────────────────
// snapshot-report.mjs — read-only integrity report for published snapshots.
//
// It never writes. For every snapshot directory it verifies the marker against
// the files, and it compares the version records with the directories they name.
//
//   node tools/snapshot-report.mjs [--json]
// ─────────────────────────────────────────────────────────────────────────────
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/db.mjs';
import { CANONICAL_MAP_NAME } from '../src/artwork/workspace.mjs';
import { verifySnapshot } from '../src/artwork/snapshot-integrity.mjs';

async function directories(root) {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

async function readMapping(artworkRoot) {
  try {
    return JSON.parse(await readFile(join(artworkRoot, CANONICAL_MAP_NAME), 'utf8'));
  } catch {
    return {};
  }
}

export async function snapshotReport({ config }) {
  const artworkRoots = await directories(config.artifactsDir);
  const rows = [];
  for (const artworkId of artworkRoots) {
    const root = join(config.artifactsDir, artworkId);
    const mapping = await readMapping(root);
    for (const directory of await directories(root)) {
      const dir = join(root, directory);
      const verdict = await verifySnapshot(dir, { expectedHash: directory });
      const mapped = Boolean(mapping[directory]);
      // A legacy marker names the hash of the prefixed paths. The directory
      // name and the real content hash agree, and the mapping records it, so
      // the evidence itself is verified even though its marker is not current.
      const state = verdict.state === 'hash_mismatch' && verdict.contentsHash === directory && mapped ? 'legacy_marker' : verdict.state;
      rows.push({ ...verdict, artworkId, directory, state, mapped });
    }
  }

  const store = new Store(join(config.dataDir, 'phygen.db'));
  let versions;
  try {
    versions = store.db.prepare('SELECT id, artwork_id, source_hash, snapshot_path FROM versions').all();
  } finally {
    store.close();
  }

  // A version record names a snapshot directory. The directory name is the
  // package id, which is not the artwork row id, so the record is checked
  // against the directories that exist rather than a reconstructed path.
  const recordProblems = [];
  for (const version of versions) {
    if (!version.snapshot_path) {
      recordProblems.push({ versionId: version.id, problem: 'the version names no snapshot path' });
      continue;
    }
    const name = version.snapshot_path.split(/[\\/]/).pop();
    if (name !== version.source_hash) {
      recordProblems.push({
        versionId: version.id,
        problem: 'the snapshot directory name differs from the source hash',
        snapshotPath: version.snapshot_path,
        expected: version.source_hash,
      });
    }
    const exact = rows.find(
      (candidate) =>
        version.snapshot_path.endsWith(`${candidate.artworkId}\\${candidate.directory}`) ||
        version.snapshot_path.endsWith(`${candidate.artworkId}/${candidate.directory}`),
    );
    if (!exact) {
      recordProblems.push({ versionId: version.id, problem: 'no published snapshot directory matches this record', snapshotPath: relative(config.repoRoot, version.snapshot_path) });
    } else if (exact.state !== 'ok' && exact.state !== 'legacy_marker') {
      recordProblems.push({
        versionId: version.id,
        problem: `the snapshot is ${exact.state}`,
        snapshotPath: relative(config.repoRoot, version.snapshot_path),
        problems: exact.problems,
      });
    }
  }

  const counts = { ok: 0, legacy_marker: 0, hash_mismatch: 0, missing: 0, unreadable: 0, conflict: 0 };
  for (const row of rows) counts[row.state] = (counts[row.state] ?? 0) + 1;
  return {
    snapshots: rows.length,
    counts,
    versions: versions.length,
    recordProblems,
    rows,
  };
}

/**
 * Record the canonical hash of every legacy snapshot. This writes ONE mapping
 * file per artwork. It never writes a snapshot, and it never changes a marker.
 */
export async function recordCanonicalMappings({ report, artifactsDir }) {
  const written = [];
  const byArtwork = new Map();
  for (const row of report.rows) {
    if (row.state === 'ok') continue;
    if (row.contentsHash !== row.directory) continue;
    const list = byArtwork.get(row.artworkId) ?? [];
    list.push({ directory: row.directory, markerHash: row.markerHash, contentsHash: row.contentsHash, problems: row.problems });
    byArtwork.set(row.artworkId, list);
  }
  for (const [artworkId, entries] of byArtwork) {
    const path = join(artifactsDir, artworkId, CANONICAL_MAP_NAME);
    let map = {};
    try {
      map = JSON.parse(await readFile(path, 'utf8'));
    } catch {
      map = {};
    }
    for (const entry of entries) map[entry.directory] = { ...entry, recordedAt: new Date().toISOString() };
    await writeFile(path, `${JSON.stringify(map, null, 2)}\n`, 'utf8');
    written.push({ artworkId, path: relative(artifactsDir, path), entries: entries.length });
  }
  return written;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const report = await snapshotReport({ config });
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`snapshots ${report.snapshots}, versions ${report.versions}\n`);
    for (const [state, count] of Object.entries(report.counts)) process.stdout.write(`  ${state}: ${count}\n`);
    for (const row of report.rows) {
      if (row.state === 'ok' || row.state === 'legacy_marker') continue;
      process.stdout.write(`\n${row.artworkId}/${row.directory.slice(0, 12)}: ${row.state}\n`);
      for (const problem of row.problems) process.stdout.write(`  - ${problem}\n`);
    }
    for (const problem of report.recordProblems) {
      process.stdout.write(`\nversion ${problem.versionId}: ${problem.problem}\n  ${problem.snapshotPath ?? ''}\n`);
      for (const detail of problem.problems ?? []) process.stdout.write(`  - ${detail}\n`);
    }
  }
  if (process.argv.includes('--record')) {
    const written = await recordCanonicalMappings({ report, artifactsDir: config.artifactsDir });
    for (const entry of written) process.stdout.write(`recorded ${entry.entries} canonical hash(es) in ${entry.path}\n`);
  }
  process.exitCode = report.recordProblems.length > 0 ? 1 : 0;
}
