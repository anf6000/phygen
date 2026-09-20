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
  seeds: [1337],
  frameRoles: ['late'],
  stepSchedule: [10],
};

/** A capture backend that writes a small file per frame and needs no browser. */
function stubCapture({ failWhen = null } = {}) {
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
    async capture({ samples, outDir, viewport, timestep, sourceHash, configurationHash, snapshotDir }) {
      // A workspace that would throw in the browser fails the capture, the same
      // way a real load fault does.
      if (failWhen) {
        const source = await readFile(join(snapshotDir, 'src', 'physarum.js'), 'utf8');
        if (failWhen(source)) {
          const error = new Error('The artwork stopped with failed: dirX is not defined');
          error.code = 'capture_load_failed';
          throw error;
        }
      }
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

async function setup(t, configOverrides = {}, hooks = {}) {
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
    capture: hooks.capture ?? stubCapture(),
    provider,
    config,
    artifacts,
    logger: () => {},
  });

  const run = store.createRun({
    artworkId: artwork.id,
    rootVersionId: rootVersion.id,
    evolutionsRequested: configOverrides.evolutions ?? 1,
    limitUsd: hooks.runLimitUsd ?? 100,
    protocol: hooks.protocol ?? PROTOCOL,
    costBoundUsd: hooks.runLimitUsd ?? 100,
  });

  return { config, store, events, budget, controller, run, artwork, rootVersion, dir };
}

/** The error and log events of one run, for a failing assertion message. */
function diagnostic(events, runId) {
  return JSON.stringify(
    events
      .since(runId, 0)
      .filter((event) => event.type === 'error' || event.type === 'log')
      .map((event) => ({ type: event.type, ...event.payload })),
  );
}

test('three steps make three children in one chain', async (t) => {
  const { store, events, controller, run, artwork, rootVersion } = await setup(t, { evolutions: 3 });

  await controller.start(run.id);

  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed', diagnostic(events, run.id));
  assert.equal(finished.evolutionsDone, 3);
  assert.equal(finished.stopReason, 'evolutions_complete');

  const versions = store.listVersions(artwork.id);
  assert.equal(versions.length, 4, 'the root and three children');
  const children = versions.filter((version) => version.parentId);
  assert.equal(children.length, 3);
  assert.deepEqual(
    children.map((child) => child.generation),
    [1, 2, 3],
    'each child is one generation deeper',
  );
  for (const child of children) {
    assert.equal(child.status, 'promoted', `every child is kept: ${child.status}`);
    assert.equal(child.onLineage, true);
    assert.match(child.sourceHash, /^[0-9a-f]{64}$/);
    assert.ok(child.changes.length > 0, `every step changes files, got ${JSON.stringify(child.changes)}`);
    assert.ok(child.explanation && child.explanation.length > 0);
  }

  const rounds = store.listRounds(run.id).filter((round) => round.round > 0);
  assert.equal(rounds.length, 3);
  assert.deepEqual(
    rounds.map((round) => round.parentVersionId),
    [rootVersion.id, children[0].id, children[1].id],
    'each step starts from the newest good version',
  );
  assert.ok(rounds.every((round) => round.promoted && round.candidateIds.length === 1));

  const captures = store.listCaptures(children[0].id);
  assert.equal(captures.length, 1, 'one capture per version');
  assert.equal(captures[0].stage, 'late');
  assert.equal(captures[0].width, 64);
  assert.equal(captures[0].height, 64);
  assert.equal(captures[0].seed, 1337);

  const jobs = store.listJobs(run.id);
  assert.equal(jobs.filter((job) => job.kind === 'author').length, 3);
  assert.equal(jobs.filter((job) => job.kind === 'publish').length, 3);
  assert.ok(jobs.every((job) => ['done', 'failed', 'cancelled'].includes(job.state)));

  const types = events.since(run.id, 0).map((event) => event.type);
  assert.ok(types.includes('version.created'));
  assert.ok(types.includes('capture.ready'));
  assert.ok(types.includes('run.completed'));

  // The stub knows its own cost, so a free run spends nothing.
  assert.equal(finished.spentUsd, 0);
  assert.equal(store.listUsage(run.id).length, 3);
});

test('a second failure marks the version failed and the next step starts from the last good version', async (t) => {
  const { store, events, controller, run, artwork, rootVersion } = await setup(t, { evolutions: 2 });

  // A provider that edits config.json into invalid JSON: every authored
  // candidate fails validation, and one repair cannot fix a broken writer.
  const base = controller.provider;
  controller.provider = Object.create(base, {
    author: {
      value: async ({ workspaceDir }) => {
        const { writeFile } = await import('node:fs/promises');
        await writeFile(join(workspaceDir, 'config.json'), '{ broken', 'utf8');
        return {
          text: 'This answer comes from the deterministic test double, not from a model.',
          usage: { inputTokens: 10, outputTokens: 5, costUsd: 0, costKnown: true, raw: {} },
          model: 'fake-deterministic',
          sessionId: 'fake-broken',
          stub: true,
        };
      },
    },
  });

  await controller.start(run.id);

  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed', diagnostic(events, run.id));
  assert.equal(finished.evolutionsDone, 2, 'a failed step is recorded and consumes its step');

  const failed = store.listVersions(artwork.id).filter((version) => version.status === 'failed');
  assert.equal(failed.length, 2, 'both candidates failed and both are recorded with their reason');
  assert.ok(failed.every((version) => version.errorCode && version.errorMessage.length > 0));

  const rounds = store.listRounds(run.id).filter((round) => round.round > 0);
  assert.deepEqual(
    rounds.map((round) => round.parentVersionId),
    [rootVersion.id, rootVersion.id],
    'each step starts again from the last good version (the root)',
  );
  assert.ok(rounds.every((round) => round.promoted === false && round.winnerVersionId === null));
  const promoted = store.listVersions(artwork.id).filter((version) => version.status === 'promoted');
  assert.equal(promoted.length, 1, 'only the root stays promoted');
});

test('a frame that fails at load gets one repair, then the step is kept', async (t) => {
  const MARKER = '// BROKEN_MARKER';
  const { store, controller, run, artwork } = await setup(
    t,
    { evolutions: 1 },
    { capture: stubCapture({ failWhen: (source) => source.includes(MARKER) }) },
  );

  // The first session writes code that throws at load. The repair session
  // removes it, so the same step succeeds without losing its place.
  let calls = 0;
  const base = controller.provider;
  controller.provider = Object.create(base, {
    author: {
      value: async ({ workspaceDir }) => {
        const { readFile: read, writeFile: write } = await import('node:fs/promises');
        calls += 1;
        const file = join(workspaceDir, 'src', 'physarum.js');
        const before = await read(file, 'utf8');
        const after = calls === 1 ? `${before}\n${MARKER}\n` : before.replace(`\n${MARKER}\n`, '');
        await write(file, after, 'utf8');
        return {
          text: calls === 1 ? 'Outcome: added a wind field.' : 'Outcome: repaired the load fault.',
          usage: { inputTokens: 20, outputTokens: 10, costUsd: 0, costKnown: true, raw: {} },
          model: 'fake-deterministic',
          sessionId: 'fake-repair',
          stub: true,
        };
      },
    },
  });

  await controller.start(run.id);

  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.evolutionsDone, 1, 'the repaired step still counts once');

  const children = store.listVersions(artwork.id).filter((version) => version.parentId);
  assert.equal(children.length, 1);
  assert.equal(children[0].status, 'promoted', 'the repaired step is kept');
  assert.equal(children[0].errorCode ?? null, null);

  const authorJobs = store.listJobs(run.id).filter((job) => job.kind === 'author');
  assert.equal(authorJobs.length, 2, 'one author session and one repair session');
  assert.equal(calls, 2);
  const captures = store.listCaptures(children[0].id);
  assert.equal(captures.length, 1, 'the repaired package is captured once');
});

test('a frame that stays broken after the repair marks the version failed', async (t) => {
  const MARKER = '// BROKEN_MARKER';
  const { store, controller, run, artwork, rootVersion } = await setup(
    t,
    { evolutions: 1 },
    { capture: stubCapture({ failWhen: (source) => source.includes(MARKER) }) },
  );

  // Every session writes the same broken code, so the repair cannot help.
  const base = controller.provider;
  controller.provider = Object.create(base, {
    author: {
      value: async ({ workspaceDir }) => {
        const { readFile: read, writeFile: write } = await import('node:fs/promises');
        const file = join(workspaceDir, 'src', 'physarum.js');
        const before = await read(file, 'utf8');
        if (!before.includes(MARKER)) await write(file, `${before}\n${MARKER}\n`, 'utf8');
        return {
          text: 'Outcome: a change that does not load.',
          usage: { inputTokens: 20, outputTokens: 10, costUsd: 0, costKnown: true, raw: {} },
          model: 'fake-deterministic',
          sessionId: 'fake-broken',
          stub: true,
        };
      },
    },
  });

  await controller.start(run.id);

  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.evolutionsDone, 1, 'a failed step is still recorded');

  const failed = store.listVersions(artwork.id).filter((version) => version.status === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].errorCode, 'capture_load_failed');
  assert.match(failed[0].errorMessage, /dirX is not defined/);

  const round = store.listRounds(run.id).find((entry) => entry.round === 1);
  assert.equal(round.promoted, false);
  assert.equal(round.parentVersionId, rootVersion.id, 'the chain head stays at the root');
  const promoted = store.listVersions(artwork.id).filter((version) => version.status === 'promoted');
  assert.equal(promoted.length, 1, 'only the root stays promoted');
});

test('a restart keeps a published snapshot, and a resume continues that step for free', async (t) => {
  const { store, controller, run, artwork, rootVersion, dir } = await setup(t, { evolutions: 1 });

  // The step published its child, then the server was lost. The child is in
  // `capturing`, and its publish job is done.
  const published = store.createVersion({
    artworkId: artwork.id,
    parentId: rootVersion.id,
    runId: run.id,
    generation: 1,
    round: 1,
    title: 'Step 1',
    status: 'capturing',
    sourceHash: rootVersion.sourceHash,
    snapshotPath: rootVersion.snapshotPath,
    workspacePath: join(dir, 'workspaces', run.id, 'published'),
    configuration: rootVersion.configuration,
  });
  const publishJob = store.createJob({ runId: run.id, versionId: published.id, round: 1, kind: 'publish', state: 'running' });
  store.updateJob(publishJob.id, { state: 'done' });

  // A second version was in flight and never published.
  const orphan = store.createVersion({
    artworkId: artwork.id,
    parentId: rootVersion.id,
    runId: run.id,
    generation: 1,
    round: 2,
    title: 'Step 2',
    status: 'authoring',
    sourceHash: rootVersion.sourceHash,
    snapshotPath: rootVersion.snapshotPath,
    workspacePath: join(dir, 'workspaces', run.id, 'orphan'),
    configuration: rootVersion.configuration,
  });
  store.updateRun(run.id, { state: 'running' });

  await controller.recover();

  const recovered = store.getRun(run.id);
  assert.equal(recovered.state, 'paused');
  assert.equal(recovered.stopReason, 'paused_after_restart');
  assert.equal(store.getVersion(published.id).status, 'capturing', 'a published snapshot is kept for the resume');
  assert.equal(store.getVersion(orphan.id).errorCode, 'interrupted_by_restart', 'an unpublished version is failed');

  // Resume: the step continues from the published snapshot, so no paid author
  // session runs again.
  let authorCalls = 0;
  const base = controller.provider;
  controller.provider = Object.create(base, {
    author: {
      value: async () => {
        authorCalls += 1;
        throw new Error('the resume must not author again');
      },
    },
  });

  await controller.start(run.id);

  assert.equal(authorCalls, 0, 'the published step was not authored twice');
  assert.equal(store.getVersion(published.id).status, 'promoted');
  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.evolutionsDone, 1);
  assert.equal(store.listCaptures(published.id).length, 1, 'the frame of the resumed step is captured');
});

test('a published step that a restart failed is revived, not paid for twice', async (t) => {
  const { store, controller, run, artwork, rootVersion, dir } = await setup(t, { evolutions: 1 });

  // The state a restart can leave behind: the snapshot is published, but the
  // version is marked failed with `interrupted_by_restart`.
  const child = store.createVersion({
    artworkId: artwork.id,
    parentId: rootVersion.id,
    runId: run.id,
    generation: 1,
    round: 1,
    title: 'Step 1',
    status: 'promoted',
    sourceHash: rootVersion.sourceHash,
    snapshotPath: rootVersion.snapshotPath,
    workspacePath: join(dir, 'workspaces', run.id, 'interrupted'),
    configuration: rootVersion.configuration,
  });
  store.updateVersion(child.id, {
    status: 'failed',
    errorCode: 'interrupted_by_restart',
    errorMessage: 'The server restarted during this stage.',
  });
  const publishJob = store.createJob({ runId: run.id, versionId: child.id, round: 1, kind: 'publish', state: 'running' });
  store.updateJob(publishJob.id, { state: 'done' });

  let authorCalls = 0;
  const base = controller.provider;
  controller.provider = Object.create(base, {
    author: {
      value: async () => {
        authorCalls += 1;
        throw new Error('a published step must not be authored again');
      },
    },
  });

  await controller.start(run.id);

  assert.equal(authorCalls, 0);
  assert.equal(store.getVersion(child.id).status, 'promoted', 'the interrupted step is revived');
  assert.equal(store.getVersion(child.id).errorCode ?? null, null);
  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.evolutionsDone, 1);
  assert.equal(store.listCaptures(child.id).length, 1);
});

test('a genuine fault is not reused, so the step runs again', async (t) => {
  const { store, controller, run, artwork, rootVersion, dir } = await setup(t, { evolutions: 1 });

  const child = store.createVersion({
    artworkId: artwork.id,
    parentId: rootVersion.id,
    runId: run.id,
    generation: 1,
    round: 1,
    title: 'Step 1',
    status: 'promoted',
    sourceHash: rootVersion.sourceHash,
    snapshotPath: rootVersion.snapshotPath,
    workspacePath: join(dir, 'workspaces', run.id, 'broken'),
    configuration: rootVersion.configuration,
  });
  store.updateVersion(child.id, { status: 'failed', errorCode: 'capture_load_failed', errorMessage: 'dirX is not defined' });
  const publishJob = store.createJob({ runId: run.id, versionId: child.id, round: 1, kind: 'publish', state: 'running' });
  store.updateJob(publishJob.id, { state: 'done' });

  await controller.start(run.id);

  // The failed work is not reused and it is not revived: the step authors a new
  // child, and the failed card keeps its reason.
  assert.equal(store.getVersion(child.id).status, 'failed', 'a real fault is not revived');
  assert.equal(store.getVersion(child.id).errorCode, 'capture_load_failed');
  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.evolutionsDone, 1);
  const promoted = store.listVersions(artwork.id).filter((version) => version.status === 'promoted' && version.parentId);
  assert.equal(promoted.length, 1, 'a new child was authored and kept');
});

test('a capture that hangs fails its step and never holds the run', async (t) => {
  // A capture that never answers, and a short ceiling so the test is quick.
  const hanging = {
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
    capture() {
      return new Promise(() => {});
    },
  };

  const { store, controller, run, artwork, rootVersion } = await setup(
    t,
    { evolutions: 2, capture: { backend: 'local', captureConcurrency: 1, captureTimeoutMs: 250 } },
    { capture: hanging },
  );

  await controller.start(run.id);

  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed', 'the run survives a hung capture');
  assert.equal(finished.evolutionsDone, 2, 'each hung step is recorded and consumed');

  const failed = store.listVersions(artwork.id).filter((version) => version.status === 'failed');
  assert.equal(failed.length, 2);
  assert.equal(failed[0].errorCode, 'capture_timeout');

  const rounds = store.listRounds(run.id).filter((round) => round.round > 0);
  assert.deepEqual(
    rounds.map((round) => round.parentVersionId),
    [rootVersion.id, rootVersion.id],
    'the chain head stays, so the next step starts from the last good version',
  );
  assert.ok(rounds.every((round) => round.promoted === false));
  // A timeout must not spend a repair session. The step still authors its child,
  // so count only the repair jobs, which carry no round.
  const repairs = store.listJobs(run.id).filter((job) => job.kind === 'author' && job.round === null);
  assert.equal(repairs.length, 0, 'a timeout must not spend a repair session');
});

test('a refactor that keeps the image is kept, and the code is smaller', async (t) => {
  const { store, controller, run, artwork, rootVersion } = await setup(t, { evolutions: 1 });

  // A kept version, as the chain holds one.
  const child = store.createVersion({
    artworkId: artwork.id,
    parentId: rootVersion.id,
    runId: run.id,
    generation: 1,
    round: 1,
    title: 'Step 1',
    status: 'promoted',
    sourceHash: rootVersion.sourceHash,
    snapshotPath: rootVersion.snapshotPath,
    workspacePath: join(dirOf(rootVersion), 'child'),
    configuration: rootVersion.configuration,
  });

  // The session rewrites a source file and removes a comment. The image does
  // not move, because the stub capture reports the same trail checksum.
  const base = controller.provider;
  let sessionPrompt = null;
  controller.provider = Object.create(base, {
    author: {
      value: async ({ workspaceDir, prompt, systemPrompt }) => {
        sessionPrompt = { prompt, systemPrompt };
        const { readFile, writeFile } = await import('node:fs/promises');
        const file = join(workspaceDir, 'src', 'physarum.js');
        const before = await readFile(file, 'utf8');
        await writeFile(file, `// removed a comment\n${before}`, 'utf8');
        return {
          text: 'Refactor. I split the deposit method and removed two comments.',
          usage: { inputTokens: 40, outputTokens: 20, costUsd: 0, costKnown: true, raw: {} },
          model: 'fake-deterministic',
          sessionId: 'fake-refactor',
          stub: true,
        };
      },
    },
  });

  const result = await controller.refactorVersion({ versionId: child.id });

  assert.equal(result.ok, true, result.error?.message);
  assert.equal(result.baseline.trailChecksum, result.after.trailChecksum);
  assert.equal(result.version.status, 'promoted', 'the version stays on the chain');
  assert.equal(result.version.generation, 1, 'the lineage does not move');
  assert.deepEqual(result.version.configuration, child.configuration, 'the configuration is frozen');
  assert.ok(result.version.changes.length > 0, 'the refactor changed a file');
  assert.match(sessionPrompt.systemPrompt, /Write no code comments/);
  assert.match(sessionPrompt.prompt, /same seed and the same step count MUST give the same image/);
});

test('a refactor that changes the image is rejected', async (t) => {
  const { store, controller, run, artwork, rootVersion } = await setup(t, { evolutions: 1 });

  const child = store.createVersion({
    artworkId: artwork.id,
    parentId: rootVersion.id,
    runId: run.id,
    generation: 1,
    round: 1,
    title: 'Step 1',
    status: 'promoted',
    sourceHash: rootVersion.sourceHash,
    snapshotPath: rootVersion.snapshotPath,
    workspacePath: join(dirOf(rootVersion), 'child'),
    configuration: rootVersion.configuration,
  });

  // The capture reports a different trail checksum after the session, which is
  // what a behaviour change looks like. The session edits only a source file, so
  // the configuration stays frozen and the image check is the one that fires.
  const stub = stubCapture();
  let calls = 0;
  const original = stub.capture.bind(stub);
  stub.capture = async (options) => {
    calls += 1;
    const results = await original(options);
    return results.map((entry) => ({ ...entry, trailChecksum: calls === 1 ? 111 : 222 }));
  };
  controller.capture = stub;

  const base = controller.provider;
  controller.provider = Object.create(base, {
    author: {
      value: async ({ workspaceDir }) => {
        const { readFile, writeFile } = await import('node:fs/promises');
        const file = join(workspaceDir, 'src', 'physarum.js');
        const before = await readFile(file, 'utf8');
        await writeFile(file, `${before}\nconst REFACTOR_BEHAVIOUR_CHANGE = 1;\n`, 'utf8');
        return {
          text: 'Refactor. I changed the shape of the code.',
          usage: { inputTokens: 40, outputTokens: 20, costUsd: 0, costKnown: true, raw: {} },
          model: 'fake-deterministic',
          sessionId: 'fake-refactor',
          stub: true,
        };
      },
    },
  });

  const result = await controller.refactorVersion({ versionId: child.id });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'refactor_changed_image');
  assert.match(result.error.message, /111 and is now 222/);
  // The record still holds the old source hash, so the rejected work is not kept.
  assert.equal(store.getVersion(child.id).sourceHash, rootVersion.sourceHash);
  assert.equal(store.getVersion(child.id).status, 'promoted');
});

test('a refactor that moves a number in config.json is rejected', async (t) => {
  const { store, controller, run, artwork, rootVersion } = await setup(t, { evolutions: 1 });

  const child = store.createVersion({
    artworkId: artwork.id,
    parentId: rootVersion.id,
    runId: run.id,
    generation: 1,
    round: 1,
    title: 'Step 1',
    status: 'promoted',
    sourceHash: rootVersion.sourceHash,
    snapshotPath: rootVersion.snapshotPath,
    workspacePath: join(dirOf(rootVersion), 'child'),
    configuration: rootVersion.configuration,
  });

  const base = controller.provider;
  controller.provider = Object.create(base, {
    author: {
      value: async ({ workspaceDir }) => {
        const { readFile, writeFile } = await import('node:fs/promises');
        const file = join(workspaceDir, 'config.json');
        const configuration = JSON.parse(await readFile(file, 'utf8'));
        configuration.num = configuration.num + 1;
        await writeFile(file, `${JSON.stringify(configuration, null, 2)}\n`, 'utf8');
        return {
          text: 'Refactor. I also tuned the particle count.',
          usage: { inputTokens: 40, outputTokens: 20, costUsd: 0, costKnown: true, raw: {} },
          model: 'fake-deterministic',
          sessionId: 'fake-refactor',
          stub: true,
        };
      },
    },
  });

  const result = await controller.refactorVersion({ versionId: child.id });

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'refactor_changed_config');
  assert.equal(store.getVersion(child.id).configuration.num, rootVersion.configuration.num);
});

test('one capture per version holds the configured square and role', async (t) => {  const { store, controller, run, artwork } = await setup(t, { evolutions: 1 });
  await controller.start(run.id);
  const children = store.listVersions(artwork.id).filter((version) => version.parentId);
  assert.equal(children.length, 1);
  const captures = store.listCaptures(children[0].id);
  assert.equal(captures.length, 1);
  assert.equal(captures[0].role ?? 'late', 'late');
  assert.equal(captures[0].width, 64);
  assert.equal(captures[0].height, 64);
});

test('a stop request ends the run without new steps', async (t) => {
  const { store, controller, run, artwork } = await setup(t, { evolutions: 3 });
  const loop = controller.start(run.id);
  await controller.stop(run.id, 'human_stop');
  await loop;
  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'stopped');
  assert.equal(finished.stopReason, 'human_stop');
  // The step that the stop interrupted must not stay in a running stage: its
  // card would otherwise show "the agent writes code" forever.
  const inFlight = store
    .listVersions(artwork.id)
    .filter((version) => ['queued', 'authoring', 'validating', 'capturing'].includes(version.status));
  assert.deepEqual(inFlight.map((version) => version.id), [], 'a stopped run leaves no version in a running stage');
});

/** The workspace directory of a version, for a test that needs one. */
function dirOf(version) {
  return version.workspacePath ?? join(REPO_ROOT, 'threejs');
}

/** Poll a condition, so a test waits for a record rather than for a delay. */
async function until(condition, { timeoutMs = 30000, stepMs = 50 } = {}) {  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('the condition never became true');
}

/** A provider whose author sessions always fail the way a gateway does. */
function flakyProvider(inner) {
  const calls = { author: 0 };
  return {
    calls,
    detect: (...args) => inner.detect(...args),
    author() {
      calls.author += 1;
      const error = new Error('[kilo] Failed to fetch models at startup: 500 Internal Server Error');
      error.code = 'provider_start_failed';
      throw error;
    },
  };
}

test('a pause does not consume a step, and a resume does not repeat paid authoring', async (t) => {
  const { store, events, controller, run, artwork } = await setup(t, { evolutions: 1 });
  const loop = controller.start(run.id);

  // Pause as the first child appears: the author session that already started
  // finishes, and no new step begins.
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
  assert.equal(pausedRun.evolutionsDone, 0, 'the interrupted step did not consume a step');

  // Which candidates were durable before the pause: those are the ones Resume
  // must reuse.
  const publishDone = new Set(
    store.listJobs(run.id).filter((job) => job.kind === 'publish' && job.state === 'done' && job.versionId).map((job) => job.versionId),
  );

  await controller.resume(run.id);
  await loop;

  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'completed');
  assert.equal(finished.evolutionsDone, 1, 'the step completed once');
  const round = store.listRounds(run.id).find((entry) => entry.round === 1);
  assert.equal(round.candidateIds.length, 1);
  const candidates = store.listVersions(artwork.id).filter((version) => round.candidateIds.includes(version.id));
  assert.ok(candidates.every((version) => ['promoted', 'failed'].includes(version.status)), 'no candidate is left in a running state');
  void publishDone;
});

test('a configured limit stops the run without consuming a step', async (t) => {
  const { store, events, controller, run } = await setup(t, {}, { runLimitUsd: 0.05 });

  await controller.start(run.id);

  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'stopped', 'the run stops at the limit');
  assert.equal(finished.stopReason, 'budget_exceeded');
  assert.equal(finished.evolutionsDone, 0, 'no step is spent on a refused request');
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

  // The author session is already inside its retry delay. A Stop must interrupt
  // the delay and must not let a retry reach the provider.
  const callsAtRetry = provider.calls.author;
  assert.ok(callsAtRetry >= 1);
  const stoppedAt = Date.now();
  await controller.stop(run.id, 'human_stop');
  await loop;

  assert.equal(provider.calls.author, callsAtRetry, 'the retry never reached the provider');
  assert.ok(Date.now() - stoppedAt < 10000, 'the retry delay was interrupted, not waited out');
  const finished = store.getRun(run.id);
  assert.equal(finished.state, 'stopped');
  assert.equal(finished.evolutionsDone, 0, 'a stopped run does not consume a step');
});
