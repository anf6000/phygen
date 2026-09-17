// ─────────────────────────────────────────────────────────────────────────────
// backup.mjs — one consistent copy of the records and the files they name.
//
// SQLite is copied with VACUUM INTO, so the copy is a single consistent file
// even while a server is writing. Immutable artifacts are copied after the
// database, and the manifest records both inventories.
//
//   node tools/backup.mjs --out <directory>
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.mjs';

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function walk(root, out = []) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) await walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function sha256(path) {
  const body = await readFile(path);
  return createHash('sha256').update(body).digest('hex');
}

/** Copy a directory, if it exists, and report what it held. */
async function mirror(source, target) {
  let info;
  try {
    info = await stat(source);
  } catch {
    return { source, present: false, files: 0, bytes: 0 };
  }
  if (!info.isDirectory()) return { source, present: false, files: 0, bytes: 0 };
  const files = await walk(source);
  const bytes = (await Promise.all(files.map(async (file) => (await stat(file)).size))).reduce((a, b) => a + b, 0);
  await mkdir(target, { recursive: true });
  await cp(source, target, { recursive: true });
  return { source, present: true, files: files.length, bytes };
}

export async function backup({ outDir, config = loadConfig() }) {
  const dbPath = join(config.dataDir, 'phygen.db');
  const target = resolve(outDir);
  await mkdir(target, { recursive: true });

  const dbCopy = join(target, 'phygen.db');
  const source = new DatabaseSync(dbPath, { readOnly: true });
  let counts;
  try {
    source.exec(`VACUUM INTO '${dbCopy.replace(/'/g, "''")}'`);
    counts = countRows(source);
  } finally {
    source.close();
  }

  const artifacts = [];
  artifacts.push(await mirror(join(config.repoRoot, 'snapshots'), join(target, 'snapshots')));
  artifacts.push(await mirror(join(config.dataDir, 'captures'), join(target, 'captures')));
  artifacts.push(await mirror(join(config.dataDir, 'judge'), join(target, 'judge')));

  const manifest = {
    createdAt: new Date().toISOString(),
    dataDir: config.dataDir,
    database: { path: dbCopy, sha256: await sha256(dbCopy), bytes: (await stat(dbCopy)).size, counts },
    artifacts,
  };
  await writeFile(join(target, 'backup.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return { target, manifest };
}

function countRows(db) {
  const counts = {};
  for (const table of ['artworks', 'versions', 'runs', 'captures', 'comparisons', 'usage', 'events']) {
    try {
      counts[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    } catch {
      counts[table] = null;
    }
  }
  return counts;
}

/** Read the copy back and prove it is a usable database. */
export async function verifyBackup(target) {
  const manifest = JSON.parse(await readFile(join(target, 'backup.json'), 'utf8'));
  const copy = new DatabaseSync(join(target, 'phygen.db'), { readOnly: true });
  let integrity;
  let counts;
  try {
    integrity = copy.prepare('PRAGMA integrity_check').get();
    counts = countRows(copy);
  } finally {
    copy.close();
  }
  const problems = [];
  if (integrity?.integrity_check !== 'ok') problems.push(`integrity_check reported ${integrity?.integrity_check}`);
  for (const [table, expected] of Object.entries(manifest.database.counts)) {
    if (expected === null) continue;
    if (counts[table] !== expected) problems.push(`${table}: ${counts[table]} rows, expected ${expected}`);
  }
  return { ok: problems.length === 0, problems, counts, integrity: integrity?.integrity_check ?? null, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outIndex = process.argv.indexOf('--out');
  const config = loadConfig();
  const outDir = outIndex === -1 ? join(config.repoRoot, 'backups', stamp()) : process.argv[outIndex + 1];
  const result = await backup({ outDir, config });
  const check = await verifyBackup(result.target);
  process.stdout.write(`${JSON.stringify({ out: result.target, verified: check.ok, problems: check.problems, counts: check.counts, integrity: check.integrity }, null, 2)}\n`);
  if (!check.ok) process.exitCode = 1;
}
