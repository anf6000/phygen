import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { titleFromExplanation } from '../src/controller/run.mjs';
import { Store } from '../src/db.mjs';
import { EventBus } from '../src/events.mjs';
import { Budget, BudgetError } from '../src/budget.mjs';
import { canTransition, transition } from '../src/state.mjs';
import { isTransientProviderError } from '../src/providers/index.mjs';
import { extractJson } from '../src/providers/json.mjs';
import { lineStats, reviewEdits } from '../src/artwork/workspace.mjs';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'phygen-unit-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeStore(t) {
  const store = new Store(join(process.env.TEMP ?? tmpdir(), `phygen-unit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`));
  t.after(() => store.close());
  return store;
}

test('a card title comes from the agent answer, not from the step number', () => {
  // A bullet and a path label are removed.
  assert.equal(
    titleFromExplanation('- src/physarum.js: added a wind field to the simulation.', 3),
    'added a wind field to the simulation.',
  );
  // A line of code is skipped in favour of a sentence.
  assert.equal(
    titleFromExplanation('const x = 1;\nThe trail now spreads wider.', 4),
    'The trail now spreads wider.',
  );
  // "Files changed" is a list, not a title.
  assert.equal(titleFromExplanation('Files changed: config.json', 5), 'Step 5');
  // A bare path, or a heading with no content, is not a title either.
  assert.equal(titleFromExplanation('src/physarum.js\nA damped turn now holds the direction.', 5), 'A damped turn now holds the direction.');
  assert.equal(titleFromExplanation('Files I changed:\nThe trail spreads wider.', 5), 'The trail spreads wider.');
  // A long prose line is cut.
  const long = 'The trail now spreads wider across the frame and holds its structure for much longer than before.';
  assert.ok(long.length > 72);
  const cut = titleFromExplanation(long, 6);
  assert.equal(cut.length, 72);
  assert.match(cut, /\.\.\.$/);
  // An empty answer falls back to the step number.
  assert.equal(titleFromExplanation('', 7), 'Step 7');
  assert.equal(titleFromExplanation(null, 8), 'Step 8');
  assert.equal(titleFromExplanation('short', 9), 'Step 9');
});

test('the run state machine rejects an illegal transition', () => {
  assert.equal(transition('run', 'queued', 'running'), 'running');
  assert.equal(canTransition('run', 'running', 'paused'), true);
  assert.throws(() => transition('run', 'completed', 'running'), (error) => error.code === 'state_transition_invalid');
  assert.throws(() => transition('run', 'running', 'dancing'), (error) => error.code === 'state_invalid');
  assert.equal(canTransition('version', 'capturing', 'promoted'), true);
  assert.equal(canTransition('version', 'promoted', 'capturing'), false);
  assert.equal(canTransition('version', 'authoring', 'judging'), false, 'there is no judging stage');
});

test('the budget reserves before a request and charges the real cost', (t) => {
  const config = loadConfig({ provider: { driver: 'fake', allowSpend: false } });
  const store = makeStore(t);
  const events = new EventBus(store);
  const budget = new Budget({ store, events, config });
  const artwork = store.createArtwork({ packageId: 'p', title: 't', contractVersion: '1.0.0', packagePath: 'threejs' });
  const run = store.createRun({
    artworkId: artwork.id,
    rootVersionId: 'ver_root',
    evolutionsRequested: 1,
    limitUsd: 1,
    protocol: {},
    costBoundUsd: 1,
  });

  budget.reserve(run, 0.3, 'author:1');
  assert.equal(store.getRun(run.id).reservedUsd, 0.3);
  const committed = budget.commit(run.id, 'author:1', { reportedUsd: 0.12, boundUsd: 0.3, inputTokens: 100, outputTokens: 20 });
  assert.equal(committed.charged, 0.12);
  assert.equal(committed.costSource, 'provider');
  assert.equal(store.getRun(run.id).spentUsd, 0.12);

  budget.reserve(run, 0.15, 'repair:1');
  const bound = budget.commit(run.id, 'repair:1', { reportedUsd: 0, boundUsd: 0.15 });
  assert.equal(bound.charged, 0.15);
  assert.equal(bound.costSource, 'bound');
});

test('the budget refuses a reservation above the limit', (t) => {
  const config = loadConfig();
  const store = makeStore(t);
  const events = new EventBus(store);
  const budget = new Budget({ store, events, config });
  const artwork = store.createArtwork({ packageId: 'p', title: 't', contractVersion: '1.0.0', packagePath: 'threejs' });
  const run = store.createRun({ artworkId: artwork.id, rootVersionId: 'v', evolutionsRequested: 1, limitUsd: 0.5, protocol: {}, costBoundUsd: 0.5 });
  budget.reserve(run, 0.4, 'a');
  assert.throws(() => budget.reserve(store.getRun(run.id), 0.4, 'b'), (error) => error instanceof BudgetError && error.code === 'budget_exceeded');
});

test('the cost bound grows with the step count, one author call per step', (t) => {
  const config = loadConfig();
  const store = makeStore(t);
  const budget = new Budget({ store, events: new EventBus(store), config });
  const one = budget.boundFor({ evolutions: 1, authorModel: 'unknown-model' });
  const three = budget.boundFor({ evolutions: 3, authorModel: 'unknown-model' });
  assert.equal(three.authorCalls, one.authorCalls * 3);
  // the bound holds three times the dollars, to six decimal places
  assert.equal(three.boundUsd, Math.round(one.boundUsd * 3 * 1e6) / 1e6);
  // author calls include the one bounded repair attempt per step
  assert.equal(one.authorCalls, 2);
});

test('the event log replays after a sequence number', (t) => {
  const store = makeStore(t);
  const events = new EventBus(store);
  events.emit('run_1', 'run.state', { state: 'running' });
  events.emit('run_1', 'job.state', { state: 'running' });
  const seen = [];
  const unsubscribe = events.subscribe('run_1', (event) => seen.push(event.seq));
  events.emit('run_1', 'capture.ready', {});
  unsubscribe();
  assert.deepEqual(seen, [3]);
  assert.equal(events.since('run_1', 1).length, 2);
  assert.equal(events.since('run_1', 0).length, 3);
});

test('the agent feed keeps the NEWEST rows, so a long run still shows its step', (t) => {
  const store = makeStore(t);
  for (let index = 0; index < 25; index++) {
    store.appendEvent('run_long', 'agent', { versionId: `ver_${index}`, kind: 'text', text: `row ${index}` });
  }
  const page = store.listEventsByType('run_long', 'agent', 5);
  assert.equal(page.length, 5);
  // The page holds the last five rows, in order.
  assert.deepEqual(
    page.map((event) => event.payload.text),
    ['row 20', 'row 21', 'row 22', 'row 23', 'row 24'],
  );
  // And a page larger than the log returns the whole log.
  assert.equal(store.listEventsByType('run_long', 'agent', 100).length, 25);
});

test('line statistics count added and removed lines', () => {
  assert.deepEqual(lineStats('a\nb\nc', 'a\nb\nc'), { added: 0, removed: 0 });
  assert.deepEqual(lineStats('a\nb\nc', 'a\nx\nb\nc'), { added: 1, removed: 0 });
  assert.deepEqual(lineStats('a\nb\nc', 'a\nc'), { added: 0, removed: 1 });
  assert.deepEqual(lineStats('a\nb\nc', 'a\nx\nc'), { added: 1, removed: 1 });
});

test('the edit surface rejects a change to a protected file', async (t) => {
  const original = await tempDir(t);
  const workspace = await tempDir(t);
  const manifest = {
    allowedEditPaths: ['src/', 'config.json'],
    protectedPaths: ['manifest.json', 'src/adapter.js'],
  };
  await mkdir(join(original, 'src'), { recursive: true });
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(original, 'config.json'), '{}\n', 'utf8');
  await writeFile(join(workspace, 'config.json'), '{"num":1}\n', 'utf8');
  await writeFile(join(original, 'src', 'adapter.js'), 'original\n', 'utf8');
  await writeFile(join(workspace, 'src', 'adapter.js'), 'tampered\n', 'utf8');

  const rejected = await reviewEdits({ originalDir: original, workspaceDir: workspace, manifest });
  assert.equal(rejected.violations.length, 1);
  assert.match(rejected.violations[0], /protects it/);

  await writeFile(join(workspace, 'src', 'adapter.js'), 'original\n', 'utf8');
  const allowed = await reviewEdits({ originalDir: original, workspaceDir: workspace, manifest });
  assert.deepEqual(allowed.violations, []);
  assert.deepEqual(allowed.changed, ['config.json']);
  assert.equal(allowed.changes[0].added, 1);
});

test('a json object is found inside prose and a code fence', () => {
  assert.deepEqual(extractJson('here: {"a":1} done'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":{"b":2}}\n```'), { a: { b: 2 } });
  assert.deepEqual(extractJson('{"a":"}"}'), { a: '}' });
  assert.equal(extractJson('no object here'), null);
  assert.equal(extractJson(''), null);
});

test('a fault that a second try can clear is recognised', () => {
  const transient = [
    new Error('[kilo] Failed to fetch models at startup: 500 Internal Server Error'),
    new Error('Error: Unknown provider "kilo"'),
    new Error('connect ECONNRESET 127.0.0.1:443'),
    new Error('socket hang up'),
  ];
  for (const error of transient) assert.equal(isTransientProviderError(error), true, error.message);
  const permanent = [
    new Error('The workspace has no src directory'),
    new Error('exit code 2: the model refused the task'),
    new Error('ENOENT: no such file or directory, open package.json'),
  ];
  for (const error of permanent) assert.equal(isTransientProviderError(error), false, error.message);
  assert.equal(isTransientProviderError({ code: 'session_timeout' }), true);
  // A three-digit number is not an HTTP status.
  assert.equal(isTransientProviderError(new Error('captured step 500 of 3600 frames')), false);
  assert.equal(isTransientProviderError(new Error('HTTP 503 Service Unavailable')), true);
  assert.equal(isTransientProviderError(new Error('status: 502')), true);
});

test('a run is refused before its records exist when it cannot be afforded', (t) => {
  const store = makeStore(t);
  const events = new EventBus(store);

  const capped = loadConfig({ cost: { maxRunUsd: 1, maxRounds: 0, maxCallsPerRun: 0 } });
  const budget = new Budget({ store, events, config: capped });
  assert.throws(
    () => budget.assertAdmission({ evolutions: 2, limitUsd: 0.5, boundUsd: 2 }),
    (error) => error instanceof BudgetError && error.code === 'budget_exceeded',
  );
  assert.throws(
    () => budget.assertAdmission({ evolutions: 2, limitUsd: 0, boundUsd: 2 }),
    (error) => error.code === 'budget_exceeded',
  );
  assert.equal(store.listRuns(10).length, 0, 'the check never writes a record');

  // A run with no per-run limit and no ceiling is admitted.
  const open = new Budget({ store, events, config: loadConfig({ cost: { maxRunUsd: 0, maxRounds: 0, maxCallsPerRun: 0 } }) });
  assert.equal(open.assertAdmission({ evolutions: 2, limitUsd: 0, boundUsd: 5 }), true);

  const stepLimited = new Budget({ store, events, config: loadConfig({ cost: { maxRounds: 1, maxRunUsd: 0, maxCallsPerRun: 0 } }) });
  assert.throws(
    () => stepLimited.assertAdmission({ evolutions: 3, limitUsd: 0, boundUsd: 0 }),
    (error) => error.code === 'round_limit_reached',
  );
});

test('a startup configuration that cannot run is refused by name', () => {
  assert.throws(
    () => loadConfig({ evolution: { stepSchedule: [] } }),
    (error) => error.code === 'config_invalid' && /stepSchedule/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ evolution: { stepSchedule: [3600, 600] } }),
    (error) => error.code === 'config_invalid' && /PHYGEN_STEP_SCHEDULE/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ evolution: { seeds: [] } }),
    (error) => error.code === 'config_invalid',
  );
  const config = loadConfig();
  assert.equal(config.evolution.authorConcurrency, 1);
  assert.equal(config.evolution.seeds.length, 1);
  assert.equal(config.evolution.frameRoles.length, config.evolution.stepSchedule.length);
  assert.equal(config.provider.authorThinking, 'high');
  assert.match(config.provider.authorModel, /^deepseek\//);
  assert.equal(config.dataDir.endsWith('data-evolve'), true);
});

test('records survive a store reopen', async (t) => {
  const dir = await tempDir(t);
  const path = join(dir, 'phygen.db');
  const first = new Store(path);
  const artwork = first.createArtwork({ packageId: 'p', title: 'T', contractVersion: '1.0.0', packagePath: 'threejs' });
  const root = first.createVersion({
    artworkId: artwork.id,
    parentId: null,
    title: 'Root',
    status: 'promoted',
    sourceHash: 'hash',
    snapshotPath: join(dir, 'snap'),
    configuration: { num: 1 },
    onLineage: true,
  });
  first.setArtworkRoot(artwork.id, root.id);
  const child = first.createVersion({
    artworkId: artwork.id,
    parentId: root.id,
    generation: 1,
    title: 'Child',
    status: 'promoted',
    sourceHash: 'hash2',
    snapshotPath: join(dir, 'snap2'),
    configuration: { num: 2 },
  });
  const failed = first.updateVersion(child.id, { status: 'failed', errorCode: 'package_invalid', errorMessage: 'broken' });
  assert.equal(failed.errorCode, 'package_invalid');
  first.close();

  const second = new Store(path);
  const reopened = second.getArtwork(artwork.id);
  assert.equal(reopened.rootVersionId, root.id);
  assert.equal(second.getVersion(child.id).parentId, root.id);
  assert.equal(second.getVersion(child.id).errorCode, 'package_invalid');
  const lineage = second.lineage(child.id);
  assert.deepEqual(lineage.map((version) => version.id), [root.id, child.id]);
  assert.deepEqual(second.listVersions(artwork.id).length, 2);
  second.close();
});
