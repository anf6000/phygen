// ─────────────────────────────────────────────────────────────────────────────
// reset-to-root.mjs — delete every evolved version and start a new tree.
//
//   node tools/reset-to-root.mjs
//
// The tool keeps each artwork's root version (the imported mother) and removes
// everything the evolution history created:
//
//   1. versions except the root, with their captures (rows and files)
//   2. all runs, rounds, jobs, usage, and events
//   3. candidate workspaces under <data>/workspaces
//   4. snapshots that no kept version references, plus .pending leftovers
//
// The root version, its captures, and the artwork record stay. The next run
// then evolves the mother from generation 0 again.
//
// Stop the server first. The tool refuses when a run is active or when the
// API or artwork origin still answers on its port.
// ─────────────────────────────────────────────────────────────────────────────
import { readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadConfig } from '../src/config.mjs';

const config = loadConfig();

function portAnswers(port, host) {
  return new Promise((settle) => {
    const probe = createServer();
    probe.once('error', () => settle(true));
    probe.once('listening', () => probe.close(() => settle(false)));
    probe.listen(port, host);
  });
}

const busy = await Promise.all([
  portAnswers(config.port, config.host),
  portAnswers(config.livePort, config.host),
]);
if (busy.some(Boolean)) {
  console.error('A server still answers on the API or artwork port. Stop the server first.');
  process.exit(1);
}

const db = new DatabaseSync(join(config.dataDir, 'phygen.db'));

const activeRuns = db
  .prepare("SELECT id FROM runs WHERE state IN ('queued','running','stopping','paused')")
  .all();
if (activeRuns.length > 0) {
  console.error(`Refused: ${activeRuns.length} run(s) are not terminal. Stop or clear them first.`);
  db.close();
  process.exit(1);
}

// ── collect what stays and what goes ─────────────────────────────────────────
const artworks = db.prepare('SELECT id, package_id, title, root_version_id FROM artworks').all();
const keptVersions = new Set(artworks.map((artwork) => artwork.root_version_id).filter(Boolean));
const removedVersions = db
  .prepare('SELECT id, generation, title FROM versions')
  .all()
  .filter((version) => !keptVersions.has(version.id));

// ── delete records, references first ─────────────────────────────────────────
const keep = Array.from(keptVersions);
const keepList = keep.map(() => '?').join(',');
const count = (statement, ...params) => db.prepare(statement).run(...params).changes;

db.exec('BEGIN');
try {
  const jobs = count('DELETE FROM jobs');
  const usage = count('DELETE FROM usage');
  const events = count('DELETE FROM events');
  const rounds = count('DELETE FROM rounds');
  const runs = count('DELETE FROM runs');
  const captures = count(`DELETE FROM captures WHERE version_id NOT IN (${keepList})`, ...keep);
  const versions = count(`DELETE FROM versions WHERE id NOT IN (${keepList})`, ...keep);
  db.exec('COMMIT');
  console.log(`runs ${runs}, rounds ${rounds}, jobs ${jobs}, usage ${usage}, events ${events} removed`);
  console.log(`versions ${versions}, captures ${captures} removed`);
} catch (error) {
  db.exec('ROLLBACK');
  console.error(`Refused, nothing was deleted: ${error.message}`);
  db.close();
  process.exit(1);
}

// ── delete files the removed records named ───────────────────────────────────
for (const version of removedVersions) {
  rmSync(join(config.dataDir, 'captures', version.id), { recursive: true, force: true });
}
rmSync(join(config.dataDir, 'workspaces'), { recursive: true, force: true });

const keptSnapshotPaths = new Set(
  db
    .prepare('SELECT DISTINCT snapshot_path FROM versions')
    .all()
    .map((row) => String(row.snapshot_path).toLowerCase()),
);
for (const artwork of artworks) {
  const snapshotRoot = join(config.artifactsDir, artwork.package_id);
  let entries = [];
  try {
    entries = readdirSync(snapshotRoot);
  } catch {
    continue;
  }
  for (const entry of entries) {
    const full = join(snapshotRoot, entry);
    if (keptSnapshotPaths.has(full.toLowerCase())) continue;
    rmSync(full, { recursive: true, force: true });
  }
}

console.log('capture files, workspaces, and unreferenced snapshots removed');
console.log(`kept: ${artworks.length} artwork(s) with ${keep.length} root version(s)`);
for (const artwork of artworks) console.log(`  artwork ${artwork.id} "${artwork.title}" root ${artwork.root_version_id}`);

db.close();
