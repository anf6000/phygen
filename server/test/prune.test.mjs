// Removing failed versions: what may go, what must stay, and what the records
// look like afterwards. The tool is destructive, so the refusals are tested as
// carefully as the deletions.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/db.mjs';
import { planPrune, pruneFailed } from '../tools/prune-failed.mjs';

async function makeWorld(t) {
  const root = await mkdtemp(join(tmpdir(), 'phygen-prune-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  });
  const config = loadConfig({ dataDir: join(root, 'data'), artifactsDir: join(root, 'snapshots') });
  const store = new Store(join(config.dataDir, 'phygen.db'));
  t.after(() => store.close());
  const artwork = store.createArtwork({ packageId: 'physarum', title: 'T', contractVersion: '1.0.0', packagePath: 'threejs' });

  const snapshot = async (hash) => {
    const dir = join(config.artifactsDir, artwork.packageId, hash);
    await mkdir(join(dir, 'files', 'src'), { recursive: true });
    await writeFile(join(dir, 'files', 'src', 'main.js'), `// ${hash}\n`, 'utf8');
    return dir;
  };
  const captures = async (versionId, count) => {
    const dir = join(config.dataDir, 'captures', versionId);
    await mkdir(dir, { recursive: true });
    for (let index = 0; index < count; index++) {
      const file = join(dir, `${versionId}-${index}.png`);
      await writeFile(file, 'png', 'utf8');
      store.createCapture({
        versionId,
        stage: 'early',
        seed: 1337,
        step: 600,
        width: 8,
        height: 8,
        dpr: 1,
        rendererBackend: 'webgl',
        sourceHash: 'h',
        configurationHash: 'c',
        path: file,
        bytes: 3,
        meta: {},
      });
    }
  };
  const version = (id, extra) => {
    const row = store.createVersion({
      id,
      artworkId: artwork.id,
      title: id,
      status: 'rejected',
      sourceHash: `h-${id}`,
      snapshotPath: join(config.artifactsDir, artwork.packageId, `h-${id}`),
      configuration: {},
      generation: 1,
      ...extra,
    });
    return row;
  };

  return { root, config, store, artwork, snapshot, captures, version };
}

test('a failed version goes only when nothing of the record depends on it', async (t) => {
  const { config, store, artwork, snapshot, captures, version } = await makeWorld(t);

  const keep = version('keep', { status: 'promoted', parentId: null, generation: 0 });
  const dead = version('deadLeaf', { status: 'failed', parentId: keep.id, errorCode: 'session_failed' });
  await snapshot(keep.sourceHash);
  await snapshot(dead.sourceHash);
  await captures(dead.id, 3);

  // Refusals: children, a round win, a round parent, and the lineage.
  const parentOfSomething = version('deadParent', { status: 'failed', parentId: keep.id });
  const child = version('orphan', { status: 'rejected', parentId: parentOfSomething.id });
  const winner = version('deadWinner', { status: 'failed', parentId: keep.id });
  const onLineage = version('deadLineage', { status: 'failed', parentId: keep.id, onLineage: true });

  const run = store.createRun({
    artworkId: artwork.id,
    rootVersionId: keep.id,
    direction: 'test',
    evolutionsRequested: 1,
    limitUsd: 0,
    protocol: {},
    costBoundUsd: 0,
  });
  store.upsertRound({
    runId: run.id,
    round: 1,
    parentVersionId: keep.id,
    candidateIds: [dead.id, child.id, winner.id, onLineage.id],
    winnerVersionId: winner.id,
    promoted: false,
    note: 'test round',
  });
  store.createUsage({ runId: run.id, versionId: dead.id, kind: 'author', model: 'm', costUsd: 0.5, inputTokens: 1, outputTokens: 1, raw: {} });
  store.upsertPairMeasurement({
    analysisRunId: 'ana_test',
    artworkId: artwork.id,
    measure: 'configuration',
    versionA: dead.id,
    versionB: keep.id,
    pairKey: `${dead.id}~${keep.id}`,
    outcome: 'ok',
    score: 0.5,
    band: 'distinct',
    evidence: {},
  });

  const plan = planPrune({ store, config });
  assert.deepEqual(plan.removable.map((entry) => entry.id), [dead.id]);
  assert.equal(plan.kept.length, 3);
  const reasons = new Map(plan.kept.map((entry) => [entry.id, entry.blockers.join(' ') ]));
  assert.match(reasons.get(parentOfSomething.id), /child version/);
  assert.match(reasons.get(winner.id), /won a round/);
  assert.match(reasons.get(onLineage.id), /lineage/);
  assert.equal(plan.totals.captures, 3);
  assert.deepEqual(plan.orphanSnapshots, [join(config.artifactsDir, artwork.packageId, dead.sourceHash)]);

  const result = await pruneFailed({ store, config, apply: true, keepUsage: true });
  assert.equal(result.applied, true);
  assert.equal(result.removed, 1);

  // The version and everything it owned are gone.
  assert.equal(store.getVersion(dead.id), null);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM captures WHERE version_id = ?').get(dead.id).n, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM pair_measurements WHERE version_a = ? OR version_b = ?').get(dead.id, dead.id).n, 0);
  assert.equal(existsSync(join(config.dataDir, 'captures', dead.id)), false);
  assert.equal(existsSync(join(config.artifactsDir, artwork.packageId, dead.sourceHash)), false);
  // The cost of a spent run is a fact, so it is kept without the dead reference.
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM usage WHERE version_id IS NULL').get().n, 1);
  // The round keeps the candidates it can still name.
  const round = store.listRounds(run.id)[0];
  assert.deepEqual(round.candidateIds, [child.id, winner.id, onLineage.id]);
  // Everything that was refused is untouched.
  for (const blocked of [parentOfSomething, winner, onLineage, child]) {
    assert.ok(store.getVersion(blocked.id), `${blocked.id} must survive`);
  }
  // The snapshot of a version that stays is never removed with a failed one.
  assert.equal(existsSync(join(config.artifactsDir, artwork.packageId, keep.sourceHash)), true);
  assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
});

test('a snapshot shared with a version that stays is kept', async (t) => {
  const { config, store, artwork, snapshot, version } = await makeWorld(t);
  const keep = version('keep', { status: 'promoted', parentId: null, generation: 0 });
  const shared = version('deadShared', { status: 'failed', parentId: keep.id, sourceHash: keep.sourceHash, snapshotPath: keep.snapshotPath });
  await snapshot(keep.sourceHash);
  await snapshot(shared.sourceHash);

  const plan = planPrune({ store, config });
  assert.equal(plan.removable.length, 1);
  assert.deepEqual(plan.orphanSnapshots, [], 'the directory is named by a version that stays');

  await pruneFailed({ store, config, apply: true });
  assert.equal(store.getVersion(shared.id), null);
  assert.equal(existsSync(join(config.artifactsDir, artwork.packageId, keep.sourceHash)), true);
});

test('a plan with nothing to remove changes nothing', async (t) => {
  const { store, config, artwork, version } = await makeWorld(t);
  const keep = version('keep', { status: 'promoted', parentId: null, generation: 0 });
  version('rejectedOne', { status: 'rejected', parentId: keep.id });

  const plan = planPrune({ store, config });
  assert.equal(plan.removable.length, 0);
  const result = await pruneFailed({ store, config, apply: true });
  assert.equal(result.removed, 0);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM versions').get().n, 2);
  void artwork;
});
