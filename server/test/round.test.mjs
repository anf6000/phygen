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
  // The classic contract: the winner of a level is the parent of the next. The
  // autonomous path is tested on its own, in archive.test.mjs and below.
  pinnedParent: true,
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

async function setup
(t, configOverrides = {}, hooks = {}) {
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
  const provider = hooks.provider ?? new FakeProvider({ config });

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
    direction: hooks.direction ?? 'quieter, more directional, fewer crossings',
    evolutionsRequested: configOverrides.evolutions ?? 1,
    limitUsd: hooks.runLimitUsd ?? 100,
    protocol: hooks.protocol ?? PROTOCOL,
    costBoundUsd: hooks.runLimitUsd ?? 100,
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

test('an autonomous run picks its own parent and records why', async (t) => {
  // No pin: the run starts from the seed version and then reads its archive.
  const { store, controller, run, rootVersion } = await setup(
    t,
    { evolutions: 2, variants: 2 },
    { protocol: { ...PROTOCOL, pinnedParent: false } },
  );

  await controller.start(run.id);

  const rounds = store.listRounds(run.id);
  assert.equal(rounds.length, 2, 'both levels ran');

  // Level one starts where the run started, and says so.
  assert.equal(rounds[0].parentVersionId, rootVersion.id);
  assert.match(rounds[0].note, /Chosen by seed: the version this run started from/);

  // Level two is chosen from the archive, not by the lineage rule alone.
  const second = rounds[1];
  assert.match(second.note, /Chosen by (exploit|explore|repair):/, 'the pick explains itself');
  const candidate = store.listVersions(run.artworkId).find((version) => version.round === 2 && version.parentId === second.parentVersionId);
  assert.ok(candidate, 'the level two candidate hangs from the chosen parent');

  // The archive is a record the API can report, and it names the parent.
  const archive = store.listComparisonsByArtwork(run.artworkId);
  assert.ok(archive.length > 0, 'the comparisons behind a pick are kept');
});

test('an autonomous run with no direction writes its own instruction', async (t) => {
  // Nothing from a person: no pin, and no direction. The run has to choose a
  // parent AND say what it wants the next level to do.
  const { store, events, controller, run } = await setup(
    t,
    { evolutions: 1, variants: 2 },
    { protocol: { ...PROTOCOL, pinnedParent: false }, direction: '' },
  );

  await controller.start(run.id);

  const started = events.since(run.id, 0).find((event) => event.type === 'run.round' && event.payload?.phase === 'author');
  assert.ok(started, 'the level announced itself');
  assert.ok(typeof started.payload.direction === 'string' && started.payload.direction.length > 60, 'the run wrote an instruction');
  assert.ok(typeof started.payload.directionSource === 'string' && started.payload.directionSource.length > 0, 'and it names the source');

  const round = store.listRounds(run.id)[0];
  const candidates = store.listVersions(run.artworkId).filter((version) => version.round === 1);
  assert.ok(candidates.length > 0, 'a candidate was authored from the written instruction');
  assert.match(round.note, /Chosen by seed/, 'the level one parent is the seed, and the note says so');
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

/** Poll a condition, so a test waits for a record rather than for a delay. */
async function until(condition, { timeoutMs = 30000, stepMs = 50 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('the condition never became true');
}

/** A provider whose author sessions always fail the way a gateway does. */
function flakyProvider(inner) {
  const calls = { author: 0, judge: 0 };
  return {
    calls,
    detect: (...args) => inner.detect(...args),
    author() {
      calls.author += 1;
      const error = new Error('[kilo] Failed to fetch models at startup: 500 Internal Server Error');
      error.code = 'provider_start_failed';
      throw error;
    },
    judge(options) {
      calls.judge += 1;
      return inner.judge(options);
    },
  };
}

test('a pause does not consume an evolution, and a resume does not repeat paid authoring', async (t) => {
  const { store, events, controller, run, artwork } = await setup(t);
  const loop = controller.start(run.id);

  // Pause as the first variant appears: the author sessions that already
  // started finish, and no new round begins.
  const paused = new Promise((resolve) => {
    const unsubscribe = events.subscribe(run.id, (event) => {
      if (event.type !== 'version.created') return;
      unsubscribe();
      void controller.pause(run.id).then(resolve);
    });
  });
  await paused;
  await until(() => store.listRounds(run.id).some((round) => round.round === 1 && /paused/i.test(round.note ?? '')));

  const pausedRun = store.getRun(run.id);
  assert.equal(pausedRun.state, 'paused');
  assert.equal(pausedRun.evolutionsDone, 0, 'the interrupted round did not consume an evolution');
  const interrupted = store.listRounds(run.id).filter((round) => round.round === 1);
  assert.equal(interrupted.length, 1);
  assert.equal(interrupted[0].promoted, false);

  // Which candidates were durable before the pause: those are the ones Resume
  // must reuse.
  const publishDone = new Set(
    store.listJobs(run.id).filter((job) => job.kind === 'publish' && job.state === 'done' && job.versionId).map((job) => job.versionId),
  );
  assert.ok(publishDone.size >= 1, 'at least one candidate was published before the pause');

  await controller.resume(run.id);
  await loop;

  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.evolutionsDone, 1, 'the round completed once');
  const round = store.listRounds(run.id).filter((entry) => entry.round === 1)[0];
  assert.equal(round.candidateIds.length, 3, 'the round holds one candidate per variant');
  for (const versionId of publishDone) {
    assert.ok(round.candidateIds.includes(versionId), 'a published candidate is reused, not replaced');
    const authorJobs = store.listJobs(run.id).filter((job) => job.kind === 'author' && job.versionId === versionId);
    assert.equal(authorJobs.length, 1, 'a published candidate was not authored a second time');
  }
  const candidates = store.listVersions(artwork.id).filter((version) => round.candidateIds.includes(version.id));
  assert.equal(candidates.length, round.candidateIds.length);
  assert.ok(
    candidates.every((version) => ['promoted', 'rejected', 'failed'].includes(version.status)),
    'no candidate is left in a running state',
  );
  const promoted = store.listVersions(artwork.id).filter((version) => version.status === 'promoted');
  assert.ok(promoted.length >= 1, 'the round names a parent or a winner');
});

test('a configured limit stops the run without consuming an evolution', async (t) => {
  const { store, events, controller, run } = await setup(t, {}, { runLimitUsd: 0.05 });

  await controller.start(run.id);

  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'stopped', 'the run stops at the limit');
  assert.equal(finished.stopReason, 'budget_exceeded');
  assert.equal(finished.evolutionsDone, 0, 'no evolution is spent on a refused request');
  const stops = events.since(run.id, 0).filter((event) => event.type === 'error' && event.payload?.detail?.budgetStop === true);
  assert.equal(stops.length, 1, 'the exact limit reason is recorded');
  assert.match(stops[0].payload.message, /0\.0500 USD/);
});

test('a stop during a retry delay starts no further provider session', async (t) => {
  const { store, events, controller, run } = await setup(t, { evolutions: 3 }, { provider: null });
  const provider = flakyProvider(controller.provider);
  controller.provider = provider;

  const loop = controller.start(run.id);
  await until(() => events.since(run.id, 0).some((event) => event.type === 'log' && /One more try in 20 seconds/.test(event.payload?.message ?? '')));

  // Every variant is already inside its retry delay. A Stop must interrupt the
  // delay and must not let a retry reach the provider.
  const callsAtRetry = provider.calls.author;
  assert.ok(callsAtRetry >= 1);
  const stoppedAt = Date.now();
  await controller.stop(run.id, 'human_stop');
  await loop;

  assert.equal(provider.calls.author, callsAtRetry, 'the retry never reached the provider');
  assert.ok(Date.now() - stoppedAt < 10000, 'the retry delay was interrupted, not waited out');
  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'stopped');
  assert.equal(finished.evolutionsDone, 0, 'a stopped run does not consume an evolution');
});
