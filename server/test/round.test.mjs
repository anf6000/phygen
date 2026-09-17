import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { REPO_ROOT, loadConfig } from '../src/config.mjs';
import { Store } from '../src/db.mjs';
import { EventBus } from '../src/events.mjs';
import { Budget } from '../src/budget.mjs';
import { RunController } from '../src/controller/run.mjs';
import { FakeProvider } from '../src/providers/fake.mjs';
import { publishSnapshot } from '../src/artwork/workspace.mjs';
import { checkPackage } from '../../runtime/node/package-checks.js';

const PACKAGE_DIR = join(REPO_ROOT, 'threejs');
const PROTOCOL = {
  viewport: { width: 64, height: 64, dpr: 1 },
  seeds: [1337, 7],
  frameRoles: ['early', 'middle', 'late'],
  stepSchedule: [10, 20, 30],
  denseFrameRoles: ['early', 'middle', 'late'],
  denseStepSchedule: [10, 20, 30],
  tieBreak: true,
};

/** A capture backend that writes a small file per frame and needs no browser. */
function stubCapture() {
  return {
    backend: 'stub',
    isolated: false,
    async available() {
      return {
        backend: 'stub',
        available: true,
        isolated: false,
        detail: 'stub',
        docker: { available: false, image: null, detail: 'stub' },
        browser: { available: true, detail: 'stub' },
      };
    },
    async capture({ samples, outDir, viewport, timestep, sourceHash, configurationHash }) {
      await mkdir(outDir, { recursive: true });
      const results = [];
      for (const sample of samples) {
        const path = join(outDir, `${sample.stage}-s${sample.seed}-n${sample.step}.png`);
        await writeFile(path, Buffer.from(`png|${sourceHash}|${sample.stage}|${sample.seed}|${sample.step}`), 'utf8');
        results.push({
          ...sample,
          path,
          width: viewport.width,
          height: viewport.height,
          dpr: viewport.dpr,
          timestep,
          sourceHash,
          configurationHash,
          rendererBackend: 'stub',
          iteration: sample.step,
          fps: 60,
          trailChecksum: 1,
          agentChecksum: 2,
          consoleErrors: [],
          url: 'http://stub/',
        });
      }
      return results;
    },
  };
}

async function setup(t, configOverrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'phygen-round-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  });

  const config = loadConfig({
    dataDir: join(dir, 'data'),
    artifactsDir: join(dir, 'snapshots'),
    capture: { backend: 'local', captureConcurrency: 2 },
    provider: { driver: 'fake', allowSpend: false },
    ...configOverrides,
  });

  const store = new Store(join(config.dataDir, 'phygen.db'));
  t.after(() => store.close());
  const events = new EventBus(store);
  const budget = new Budget({ store, events, config });
  const provider = new FakeProvider({ config });

  const check = await checkPackage({ packageDir: PACKAGE_DIR });
  assert.equal(check.ok, true, check.problems.join('; '));
  const published = await publishSnapshot({
    workspaceDir: PACKAGE_DIR,
    snapshotRoot: config.artifactsDir,
    artworkId: check.manifest.id,
    packageHash: check.packageHash,
  });

  const rootVersion = store.createVersion({
    artworkId: 'pending',
    parentId: null,
    generation: 0,
    title: 'Root',
    status: 'promoted',
    sourceHash: check.packageHash,
    snapshotPath: published.path,
    workspacePath: PACKAGE_DIR,
    configuration: JSON.parse(await readFile(join(PACKAGE_DIR, check.manifest.configuration.baseline), 'utf8')),
    onLineage: true,
  });
  const artwork = store.createArtwork({
    packageId: check.manifest.id,
    title: check.manifest.title,
    contractVersion: check.manifest.contractVersion,
    packagePath: 'threejs',
    rootVersionId: rootVersion.id,
  });
  store.db.prepare('UPDATE versions SET artwork_id = ? WHERE id = ?').run(artwork.id, rootVersion.id);

  const artifacts = {
    runtimeDir: join(REPO_ROOT, 'runtime'),
    liveUrlFor: (versionId) => `http://stub/${versionId}/`,
    snapshotDirFor: (version) => join(version.snapshotPath, 'files'),
    nodeModulesDir: () => join(PACKAGE_DIR, 'node_modules'),
    artworkContext: (record) => ({
      artwork: record,
      packageDir: PACKAGE_DIR,
      manifest: check.manifest,
      schema: JSON.parse(readFileSync(join(PACKAGE_DIR, check.manifest.configuration.schema), 'utf8')),
      baseline: JSON.parse(readFileSync(join(PACKAGE_DIR, check.manifest.configuration.baseline), 'utf8')),
    }),
  };

  const controller = new RunController({
    store,
    events,
    budget,
    capture: stubCapture(),
    provider,
    config,
    artifacts,
    logger: () => {},
  });

  const run = store.createRun({
    artworkId: artwork.id,
    rootVersionId: rootVersion.id,
    direction: 'quieter, more directional, fewer crossings',
    evolutionsRequested: configOverrides.evolutions ?? 1,
    limitUsd: 100,
    protocol: PROTOCOL,
    costBoundUsd: 100,
  });

  return { config, store, events, budget, controller, run, artwork, rootVersion, dir };
}

test('one round authors three candidates, captures, judges, and records the outcome', async (t) => {
  const { store, events, controller, run, artwork, rootVersion } = await setup(t);

  await controller.start(run.id);

  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.evolutionsDone, 1);
  assert.equal(finished.stopReason, 'evolutions_complete');

  const versions = store.listVersions(artwork.id);
  assert.equal(versions.length, 4, 'the root and three candidates');
  const candidates = versions.filter((version) => version.parentId === rootVersion.id);
  assert.equal(candidates.length, 3);
  assert.deepEqual(candidates.map((candidate) => candidate.slot).sort(), ['experiment', 'refinement', 'structure']);
  for (const candidate of candidates) {
    assert.ok(['promoted', 'rejected'].includes(candidate.status), `candidate status ${candidate.status}`);
    assert.match(candidate.sourceHash, /^[0-9a-f]{64}$/);
    const paths = candidate.changes.map((change) => change.path);
    assert.ok(paths.includes('src/physarum.js'), `every candidate writes code, got ${paths.join(', ')}`);
    assert.ok(candidate.explanation.includes('round 1'));
  }

  const rounds = store.listRounds(run.id).filter((round) => round.round === 1);
  assert.equal(rounds.length, 1);
  assert.equal(rounds[0].candidateIds.length, 3);
  assert.ok(rounds[0].note.length > 0);

  const promoted = versions.filter((version) => version.status === 'promoted');
  const expectedPromoted = rounds[0].promoted ? 2 : 1;
  assert.equal(promoted.length, expectedPromoted, 'the root, and the winner when a candidate is promoted');

  const comparisons = store.listComparisons(run.id);
  assert.equal(comparisons.length, 3, 'the round comparison and the two finalist comparisons');
  assert.deepEqual(comparisons.map((comparison) => comparison.kind).sort(), ['finalist', 'finalist-reversed', 'round']);
  for (const comparison of comparisons) {
    assert.ok(Object.keys(comparison.labels).length >= 2);
    assert.equal(comparison.verdict.stub, true);
  }

  const captures = store.listCaptures(candidates[0].id);
  // six round frames, and six more when this candidate was the finalist
  assert.ok([6, 12].includes(captures.length), `expected 6 or 12 captures, got ${captures.length}`);
  const roundStages = new Set(captures.filter((capture) => !capture.stage.startsWith('dense-')).map((capture) => capture.stage));
  assert.deepEqual([...roundStages].sort(), ['early', 'late', 'middle']);
  for (const capture of captures) {
    assert.ok(capture.sourceHash.length === 64);
    assert.equal(capture.width, 64);
  }

  const jobs = store.listJobs(run.id);
  assert.equal(jobs.filter((job) => job.kind === 'author').length, 3);
  assert.equal(jobs.filter((job) => job.kind === 'publish').length, 3);
  assert.ok(jobs.filter((job) => job.kind === 'capture').length >= 4);
  assert.ok(jobs.every((job) => ['done', 'failed', 'cancelled'].includes(job.state)));

  const types = events.since(run.id, 0).map((event) => event.type);
  assert.ok(types.includes('version.created'));
  assert.ok(types.includes('capture.ready'));
  assert.ok(types.includes('comparison.result'));
  assert.ok(types.includes('run.completed'));

  // The stub knows its own cost, so a free run spends nothing.
  assert.equal(finished.spentUsd, 0);
  assert.equal(store.listUsage(run.id).length, 6);
});

test('a run that branches from a version makes children of that version', async (t) => {
  const { store, controller, run, artwork, rootVersion } = await setup(t);
  await controller.start(run.id);

  const firstRound = store.listRounds(run.id).filter((round) => round.round === 1)[0];
  assert.equal(firstRound.promoted, true, 'the first round must promote a candidate for this test');
  const parent = store.getVersion(firstRound.winnerVersionId);
  assert.equal(parent.generation, 1);

  // a second run that starts from the promoted version
  const branched = store.createRun({
    artworkId: artwork.id,
    rootVersionId: parent.id,
    direction: 'evolve the winner further',
    evolutionsRequested: 1,
    limitUsd: 100,
    protocol: {},
    costBoundUsd: 100,
  });
  await controller.start(branched.id);

  const secondRound = store.listRounds(branched.id).filter((round) => round.round === 1)[0];
  assert.equal(secondRound.candidateIds.length, 3);
  for (const candidateId of secondRound.candidateIds) {
    const candidate = store.getVersion(candidateId);
    assert.equal(candidate.parentId, parent.id, 'the child points at the branched version');
    assert.equal(candidate.generation, parent.generation + 1, 'the child is one generation deeper');
  }

  const tree = store.listVersions(artwork.id);
  const grandchildren = tree.filter((version) => version.parentId === parent.id);
  assert.equal(grandchildren.length, 3);
  assert.ok(grandchildren.every((version) => version.runId === branched.id));
  assert.ok(rootVersion.generation === 0);
});

test('two variants over two evolutions build two levels', async (t) => {
  const { store, controller, run, artwork, rootVersion } = await setup(t);
  const withVariants = store.getRun(run.id);
  store.updateRun(run.id, {});
  store.db
    .prepare('UPDATE runs SET evolutions_requested = ?, protocol_json = ? WHERE id = ?')
    .run(2, JSON.stringify({ ...withVariants.protocol, variantsPerEvolution: 2 }), run.id);

  await controller.start(run.id);

  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.evolutionsDone, 2);

  const rounds = store.listRounds(run.id).filter((round) => round.round > 0);
  assert.equal(rounds.length, 2, 'two evolution levels');
  assert.equal(rounds[0].candidateIds.length, 2, 'level 1 spawns two variants');
  assert.equal(rounds[1].candidateIds.length, 2, 'level 2 spawns two variants');

  for (const id of rounds[0].candidateIds) {
    const version = store.getVersion(id);
    assert.equal(version.parentId, rootVersion.id);
    assert.equal(version.generation, 1);
  }
  for (const id of rounds[1].candidateIds) {
    const version = store.getVersion(id);
    assert.equal(version.generation, 2, 'level 2 is one generation deeper');
    assert.equal(version.parentId, rounds[0].winnerVersionId, 'level 2 spawns from the level 1 winner');
  }

  const tree = store.listVersions(artwork.id);
  assert.equal(tree.length, 5, 'the root, two variants, and two grandchildren');
});

test('a run keeps the parent when nothing can be captured', async (t) => {
  const { store, controller, run, artwork, rootVersion } = await setup(t);
  controller.capture = {
    backend: 'stub',
    isolated: false,
    async available() {
      return { backend: 'stub', available: true, isolated: false, detail: 'stub', docker: { available: false, image: null }, browser: { available: true } };
    },
    async capture() {
      const { ArtworkError } = await import('../../runtime/contract.js');
      throw new ArtworkError('capture_failed', 'the stub refused to capture');
    },
  };

  await controller.start(run.id);

  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.evolutionsDone, 1);
  const rounds = store.listRounds(run.id).filter((round) => round.round === 1);
  assert.equal(rounds[0].promoted, false);
  assert.equal(rounds[0].winnerVersionId, rootVersion.id, 'the round names the retained parent');
  const promoted = store.listVersions(artwork.id).filter((version) => version.status === 'promoted');
  assert.equal(promoted.length, 1, 'only the root stays promoted');
  const candidates = store.listVersions(artwork.id).filter((version) => version.parentId === rootVersion.id);
  assert.equal(candidates.length, 3);
  assert.ok(
    candidates.every((version) => ['failed', 'rejected'].includes(version.status)),
    'every candidate is recorded, and none is left in a running state',
  );
});

test('a provider that cannot answer pauses the run instead of failing it', async (t) => {
  const { store, controller, run } = await setup(t);
  // A provider whose catalog does not answer, like a gateway error at startup.
  controller.provider = {
    async probe() {
      return { ok: false, status: 503, detail: '503 from the catalog' };
    },
    async author() {
      throw new Error('the author session must not start');
    },
    async judge() {
      throw new Error('the judge session must not start');
    },
  };

  await controller.start(run.id);

  const paused = store.getRun(run.id);
  assert.equal(paused.state, 'paused', 'the run waits for the provider');
  assert.equal(paused.stopReason, 'provider_unavailable');
  assert.equal(paused.evolutionsDone, 0, 'no evolution was spent');
  const jobs = store.listJobs(run.id);
  assert.equal(jobs.filter((job) => job.kind === 'author').length, 0, 'no author session started');
});

test('a stop request ends the run without new rounds', async (t) => {
  const { store, controller, run } = await setup(t, { evolutions: 3 });
  const loop = controller.start(run.id);
  await controller.stop(run.id, 'human_stop');
  await loop;
  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'stopped');
  assert.equal(finished.stopReason, 'human_stop');
});
