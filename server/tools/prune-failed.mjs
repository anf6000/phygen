// ────────────────────────────────────────────────────────────────────────────
// prune-failed.mjs — remove the versions that failed, and the data that only
// those versions produced.
//
// This is destructive and it cannot be undone from the records. It therefore
// REFUSES any version whose removal would break history:
//
//   - a failed version that has children would orphan them;
//   - a failed version that won a round would leave the round with no winner;
//   - a failed version that a round used as its parent would leave a round that
//     points at nothing;
//   - a failed version on the lineage is part of the artwork, not a dead end.
//
// Everything kept is reported with the reason. Files are moved aside first and
// the records are committed in one transaction, so a failure puts the files back.
//
//   node tools/prune-failed.mjs                 show the plan, change nothing
//   node tools/prune-failed.mjs --apply         do it
//   node tools/prune-failed.mjs --keep-usage    do not touch the cost records
// ────────────────────────────────────────────────────────────────────────────
import { mkdir, rename, rm, stat, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/db.mjs';

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}

async function directorySize(root) {
  let files = 0;
  let bytes = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += (await stat(full).catch(() => ({ size: 0 }))).size;
      }
    }
  };
  await walk(root);
  return { files, bytes };
}

/**
 * Work out what can be removed, and what cannot.
 *
 * Two selections:
 *   'failed'  every version that failed and that nothing depends on;
 *   'stub'    every version produced by a run whose provider was the test
 *             double, together with everything built on top of it. Work that
 *             descends from a stub is not real work, so it goes with it.
 */
export function planPrune({ store, config, mode = 'failed' }) {
  const all = store.db.prepare('SELECT * FROM versions ORDER BY created_at').all();
  const protocols = new Map();
  for (const run of store.db.prepare('SELECT id, protocol_json FROM runs').all()) {
    let protocol = {};
    try {
      protocol = JSON.parse(run.protocol_json ?? '{}');
    } catch {
      protocol = {};
    }
    protocols.set(run.id, protocol);
  }
  const rootVersionId = store.db.prepare('SELECT root_version_id FROM artworks').get()?.root_version_id ?? null;

  // The selection itself.
  let candidates;
  if (mode === 'stub') {
    const selected = new Set(
      all.filter((version) => version.run_id && protocols.get(version.run_id)?.providerDriver === 'fake').map((version) => version.id),
    );
    // A version that descends from a stub is stub work too, so the set is closed
    // under descendants: no surviving version may point at a removed parent.
    let grew = true;
    while (grew) {
      grew = false;
      for (const version of all) {
        if (selected.has(version.id)) continue;
        if (version.parent_id && selected.has(version.parent_id)) {
          selected.add(version.id);
          grew = true;
        }
      }
    }
    candidates = all.filter((version) => selected.has(version.id));
  } else {
    candidates = all.filter((version) => version.status === 'failed');
  }

  const roundRows = store.db.prepare('SELECT run_id, round, parent_version_id, candidate_ids_json, winner_version_id FROM rounds').all();
  const childCount = new Map();
  for (const row of store.db.prepare('SELECT parent_id, COUNT(*) AS n FROM versions WHERE parent_id IS NOT NULL GROUP BY parent_id').all()) {
    childCount.set(row.parent_id, row.n);
  }
  const winners = new Set();
  const roundParents = new Set();
  for (const row of roundRows) {
    if (row.winner_version_id) winners.add(row.winner_version_id);
    if (row.parent_version_id) roundParents.add(row.parent_version_id);
  }

  const removable = [];
  const kept = [];
  for (const version of candidates) {
    const blockers = [];
    if (version.id === rootVersionId) blockers.push('it is the artwork root');
    // In stub mode the set is already closed under descendants, so a child that
    // stays is impossible. In failed mode a child is why a version must stay.
    if (mode === 'failed' && (childCount.get(version.id) ?? 0) > 0) blockers.push(`${childCount.get(version.id)} child version(s)`);
    if (mode === 'failed' && winners.has(version.id)) blockers.push('it won a round');
    if (mode === 'failed' && roundParents.has(version.id)) blockers.push('a round used it as the parent');
    if (mode === 'failed' && version.on_lineage) blockers.push('it is on the lineage');
    const captures = store.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM captures WHERE version_id = ?').get(version.id);
    const measurements = store.db
      .prepare('SELECT COUNT(*) AS n FROM pair_measurements WHERE version_a = ? OR version_b = ?')
      .get(version.id, version.id);
    const evaluations = store.db.prepare('SELECT COUNT(*) AS n FROM evaluations WHERE version_id = ?').get(version.id);
    const jobs = store.db.prepare('SELECT COUNT(*) AS n FROM jobs WHERE version_id = ?').get(version.id);
    const usage = store.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS c FROM usage WHERE version_id = ?').get(version.id);
    const entry = {
      id: version.id,
      title: version.title,
      round: version.round,
      slot: version.slot,
      errorCode: version.error_code,
      snapshotPath: version.snapshot_path,
      captures: captures.n,
      captureBytes: captures.b,
      measurements: measurements.n,
      evaluations: evaluations.n,
      jobs: jobs.n,
      usageRows: usage.n,
      usageUsd: usage.c,
      lineage: version.on_lineage === 1,
      blockers,
    };
    if (blockers.length > 0) kept.push(entry);
    else removable.push(entry);
  }

  // A snapshot is content-addressed, so it may be shared with a version that
  // stays. Only the snapshots nothing else names may go.
  const removalIds = new Set(removable.map((entry) => entry.id));
  const orphanSnapshots = [];
  for (const entry of removable) {
    const named = store.db.prepare('SELECT id FROM versions WHERE snapshot_path = ?').all(entry.snapshotPath);
    const namedBySurvivor = named.some((row) => !removalIds.has(row.id));
    if (!namedBySurvivor) orphanSnapshots.push(entry.snapshotPath);
  }

  return {
    removable,
    kept,
    orphanSnapshots: [...new Set(orphanSnapshots)],
    totals: {
      selected: candidates.length,
      removable: removable.length,
      kept: kept.length,
      captures: removable.reduce((sum, entry) => sum + entry.captures, 0),
      captureBytes: removable.reduce((sum, entry) => sum + entry.captureBytes, 0),
      usageRows: removable.reduce((sum, entry) => sum + entry.usageRows, 0),
      usageUsd: removable.reduce((sum, entry) => sum + entry.usageUsd, 0),
      remainingVersions: all.length - removable.length,
    },
  };
}

/** Move a path aside. Returns the quarantine path, or null when there is nothing. */
async function quarantine(path, into) {
  if (!existsSync(path)) return null;
  await mkdir(into, { recursive: true });
  const target = join(into, path.replace(/^[A-Za-z]:/, '').replace(/[\\/]/g, '_'));
  await rename(path, target).catch(async () => {
    // A cross-device move cannot rename. Copy is not worth it for a deletion:
    // report and leave the file, so the records and the files cannot disagree.
  });
  return existsSync(target) ? target : null;
}

export async function pruneFailed({ store, config, apply = false, keepUsage = false, mode = 'failed' }) {
  const plan = planPrune({ store, config, mode });
  if (!apply) return { applied: false, plan };

  const quarantineDir = join(config.dataDir, `pruned-${stamp()}`);
  const moved = [];
  const ids = plan.removable.map((entry) => entry.id);

  // Files first, moved aside. A record is never removed while its file is still
  // in place, and a failure below puts every file back.
  try {
    for (const entry of plan.removable) {
      const captureDir = join(config.dataDir, 'captures', entry.id);
      const workspaceDir = join(config.dataDir, 'workspaces', entry.id);
      const movedCapture = await quarantine(captureDir, join(quarantineDir, 'captures'));
      if (movedCapture) moved.push([captureDir, movedCapture]);
      const movedWorkspace = await quarantine(workspaceDir, join(quarantineDir, 'workspaces'));
      if (movedWorkspace) moved.push([workspaceDir, movedWorkspace]);
    }
    for (const snapshot of plan.orphanSnapshots) {
      const movedSnapshot = await quarantine(snapshot, join(quarantineDir, 'snapshots'));
      if (movedSnapshot) moved.push([snapshot, movedSnapshot]);
    }

    // Records, in one transaction.
    store.db.exec('BEGIN');
    try {
      const removeRounds = store.db.prepare('SELECT run_id, round, candidate_ids_json FROM rounds');
      for (const id of ids) {
        store.db.prepare('DELETE FROM captures WHERE version_id = ?').run(id);
        store.db.prepare('DELETE FROM pair_measurements WHERE version_a = ? OR version_b = ?').run(id, id);
        store.db.prepare('DELETE FROM evaluations WHERE version_id = ?').run(id);
        store.db.prepare('DELETE FROM jobs WHERE version_id = ?').run(id);
        if (keepUsage) {
          // The spend is a fact about the run, not about the node. Keep the row
          // and drop the reference to a node that no longer exists.
          store.db.prepare('UPDATE usage SET version_id = NULL WHERE version_id = ?').run(id);
        } else {
          store.db.prepare('DELETE FROM usage WHERE version_id = ?').run(id);
        }
        store.db.prepare('DELETE FROM versions WHERE id = ?').run(id);
      }
      // A round keeps every candidate it can still name, and drops a winner or a
      // parent that no longer exists instead of pointing at nothing.
      for (const row of removeRounds.all()) {
        const candidates = JSON.parse(row.candidate_ids_json ?? '[]');
        const kept = candidates.filter((id) => !ids.includes(id));
        if (kept.length !== candidates.length) {
          store.db
            .prepare('UPDATE rounds SET candidate_ids_json = ? WHERE run_id = ? AND round = ?')
            .run(JSON.stringify(kept), row.run_id, row.round);
        }
      }
      for (const id of ids) {
        store.db.prepare('UPDATE rounds SET winner_version_id = NULL WHERE winner_version_id = ?').run(id);
        store.db.prepare('UPDATE rounds SET parent_version_id = NULL WHERE parent_version_id = ?').run(id);
      }
      store.db.exec('COMMIT');
    } catch (error) {
      store.db.exec('ROLLBACK');
      for (const [original, aside] of moved) await rename(aside, original).catch(() => {});
      throw error;
    }
  } catch (error) {
    for (const [original, aside] of moved) await rename(aside, original).catch(() => {});
    throw error;
  }

  // The records are committed, so the moved files can go.
  await rm(quarantineDir, { recursive: true, force: true });
  const check = store.db.prepare('PRAGMA integrity_check').get();
  return {
    applied: true,
    plan,
    removed: ids.length,
    movedFiles: moved.length,
    remainingVersions: store.db.prepare('SELECT COUNT(*) AS n FROM versions').get().n,
    integrity: check?.integrity_check,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const store = new Store(join(config.dataDir, 'phygen.db'));
  const apply = process.argv.includes('--apply');
  const keepUsage = process.argv.includes('--keep-usage');
  const mode = process.argv.includes('--stub') ? 'stub' : 'failed';
  const result = await pruneFailed({ store, config, apply, keepUsage, mode });
  const plan = result.plan;

  process.stdout.write(mode === 'stub' ? 'Selection: work produced by the test double, and everything built on it\n' : 'Selection: failed versions\n');
  process.stdout.write(`  removable: ${plan.totals.removable}\n`);
  process.stdout.write(`  kept:      ${plan.totals.kept}\n`);
  process.stdout.write(`Captures to remove: ${plan.totals.captures} (${(plan.totals.captureBytes / 1048576).toFixed(1)} MB)\n`);
  process.stdout.write(`Snapshots nothing else names: ${plan.orphanSnapshots.length}\n`);
  process.stdout.write(`Cost records on those versions: ${plan.totals.usageRows} rows, ${plan.totals.usageUsd.toFixed(4)} USD\n`);
  process.stdout.write(`Versions that would remain: ${plan.totals.remainingVersions}\n`);
  for (const entry of plan.kept) {
    process.stdout.write(`\nKEPT ${entry.id} (${entry.title}): ${entry.blockers.join('; ')}\n`);
  }
  if (plan.removable.length > 0) {
    process.stdout.write('\nA sample of the versions to remove:\n');
    for (const entry of plan.removable.slice(0, 8)) {
      process.stdout.write(`  ${entry.id} round ${entry.round ?? '-'} slot ${entry.slot ?? '-'} ${entry.errorCode ?? ''} captures ${entry.captures}\n`);
    }
  }
  if (!apply) {
    process.stdout.write('\nNothing was changed. Run again with --apply to remove them.\n');
  } else {
    process.stdout.write(`\nRemoved ${result.removed} version(s), ${result.movedFiles} path(s) moved aside.\n`);
    process.stdout.write(`Versions now: ${result.remainingVersions}. Database integrity: ${result.integrity}.\n`);
  }
  store.close();
  void directorySize;
}