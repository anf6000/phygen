import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/db.mjs';
import { EventBus } from '../src/events.mjs';
import { Budget, BudgetError } from '../src/budget.mjs';
import { canTransition, transition } from '../src/state.mjs';
import { extractJson } from '../src/providers/json.mjs';
import { lineStats, reviewEdits } from '../src/artwork/workspace.mjs';
import { assignLabels, decideWinner, validateVerdict } from '../src/judge/protocol.mjs';

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

test('the run state machine rejects an illegal transition', () => {
  assert.equal(transition('run', 'queued', 'running'), 'running');
  assert.equal(canTransition('run', 'running', 'paused'), true);
  assert.throws(() => transition('run', 'completed', 'running'), (error) => error.code === 'state_transition_invalid');
  assert.throws(() => transition('run', 'running', 'dancing'), (error) => error.code === 'state_invalid');
  assert.equal(canTransition('version', 'judging', 'promoted'), true);
  assert.equal(canTransition('version', 'promoted', 'capturing'), false);
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
    direction: 'test',
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

  budget.reserve(run, 0.3, 'judge:1');
  const bound = budget.commit(run.id, 'judge:1', { reportedUsd: 0, boundUsd: 0.2 });
  assert.equal(bound.charged, 0.2);
  assert.equal(bound.costSource, 'bound');
});

test('the budget refuses a reservation above the limit', (t) => {
  const config = loadConfig();
  const store = makeStore(t);
  const events = new EventBus(store);
  const budget = new Budget({ store, events, config });
  const artwork = store.createArtwork({ packageId: 'p', title: 't', contractVersion: '1.0.0', packagePath: 'threejs' });
  const run = store.createRun({ artworkId: artwork.id, rootVersionId: 'v', direction: 'd', evolutionsRequested: 1, limitUsd: 0.5, protocol: {}, costBoundUsd: 0.5 });
  budget.reserve(run, 0.4, 'a');
  assert.throws(() => budget.reserve(store.getRun(run.id), 0.4, 'b'), (error) => error instanceof BudgetError && error.code === 'budget_exceeded');
});

test('the cost bound grows with the evolution count', (t) => {
  const config = loadConfig();
  const store = makeStore(t);
  const budget = new Budget({ store, events: new EventBus(store), config });
  const one = budget.boundFor({ evolutions: 1, candidatesPerRound: 3, protocol: { tieBreak: true } });
  const three = budget.boundFor({ evolutions: 3, candidatesPerRound: 3, protocol: { tieBreak: true } });
  assert.equal(three.boundUsd, one.boundUsd * 3);
  // author calls include the one bounded repair attempt per candidate
  assert.equal(one.authorCalls, 6);
  assert.equal(one.judgeCalls, 6);
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

test('line statistics count added and removed lines', () => {
  assert.deepEqual(lineStats('a\nb\nc', 'a\nb\nc'), { added: 0, removed: 0 });
  assert.deepEqual(lineStats('a\nb\nc', 'a\nx\nb\nc'), { added: 1, removed: 0 });
  assert.deepEqual(lineStats('a\nb\nc', 'a\nc'), { added: 0, removed: 1 });
  assert.deepEqual(lineStats('a\nb\nc', 'a\nx\nc'), { added: 1, removed: 1 });
});

test('the edit surface rejects a change to a protected file', async (t) => {
  const { mkdir } = await import('node:fs/promises');
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

test('a malformed judge answer is rejected', () => {
  const entries = [{ versionId: 'v1', captures: [{ stage: 'early', step: 10 }] }, { versionId: 'v2', captures: [{ stage: 'early', step: 10 }] }];
  const { labelToVersion, labels } = assignLabels(entries);
  const [labelA, labelB] = Object.keys(labelToVersion);
  const good = {
    observations: [
      { label: labelA, frame: 'early@10', detail: 'A clear radial structure with even spacing.' },
      { label: labelB, frame: 'early@10', detail: 'A dense field with no clear direction.' },
    ],
    preference: labelA,
    weaknesses: ['the edges are soft'],
    uncertainty: 'low',
    confidence: 0.7,
  };
  assert.equal(validateVerdict(good, { labelToVersion, entries, labels }).preference, labelA);

  assert.throws(() => validateVerdict({ ...good, preference: 'Z' }, { labelToVersion, entries, labels }), (error) => error.code === 'judge_response_invalid');
  assert.throws(() => validateVerdict({ ...good, uncertainty: 'maybe' }, { labelToVersion, entries, labels }), (error) => error.code === 'judge_response_invalid');
  assert.throws(() => validateVerdict({ ...good, confidence: 4 }, { labelToVersion, entries, labels }), (error) => error.code === 'judge_response_invalid');
  assert.throws(
    () => validateVerdict({ ...good, observations: [good.observations[0]] }, { labelToVersion, entries, labels }),
    (error) => error.code === 'judge_response_invalid',
  );
  assert.throws(
    () => validateVerdict({ ...good, observations: [{ ...good.observations[0], frame: 'late@99' }, good.observations[1]] }, { labelToVersion, entries, labels }),
    (error) => error.code === 'judge_response_invalid',
  );
});

test('the winner decision keeps the parent when the comparisons disagree', () => {
  const make = (preference, confidence, uncertainty) => ({ verdict: { preference, confidence, uncertainty }, labelToVersion: { A: 'ver_parent', B: 'ver_candidate' }, labels: { ver_parent: 'A', ver_candidate: 'B' } });
  const agree = decideWinner({ primary: make('B', 0.8, 'low'), reversed: make('B', 0.7, 'low'), parentVersionId: 'ver_parent', promoteMargin: 0.15 });
  assert.equal(agree.promoted, true);
  assert.equal(agree.winnerVersionId, 'ver_candidate');

  const disagree = decideWinner({ primary: make('B', 0.8, 'low'), reversed: make('A', 0.8, 'low'), parentVersionId: 'ver_parent', promoteMargin: 0.15 });
  assert.equal(disagree.promoted, false);

  const weak = decideWinner({ primary: make('B', 0.05, 'high'), reversed: make('B', 0.06, 'high'), parentVersionId: 'ver_parent', promoteMargin: 0.15 });
  assert.equal(weak.promoted, false);

  const tie = decideWinner({
    primary: make('B', 0.8, 'low'),
    reversed: make('A', 0.8, 'low'),
    tieBreak: make('B', 0.6, 'medium'),
    parentVersionId: 'ver_parent',
    promoteMargin: 0.15,
  });
  assert.equal(tie.promoted, true);
  assert.equal(tie.usedTieBreak, true);
});

test('a json object is found inside prose and a code fence', () => {
  assert.deepEqual(extractJson('here: {"a":1} done'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":{"b":2}}\n```'), { a: { b: 2 } });
  assert.deepEqual(extractJson('{"a":"}"}'), { a: '}' });
  assert.equal(extractJson('no object here'), null);
  assert.equal(extractJson(''), null);
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
    status: 'rejected',
    sourceHash: 'hash2',
    snapshotPath: join(dir, 'snap2'),
    configuration: { num: 2 },
  });
  first.close();

  const second = new Store(path);
  const reopened = second.getArtwork(artwork.id);
  assert.equal(reopened.rootVersionId, root.id);
  assert.equal(second.getVersion(child.id).parentId, root.id);
  const lineage = second.lineage(child.id);
  assert.deepEqual(lineage.map((version) => version.id), [root.id, child.id]);
  assert.deepEqual(second.listVersions(artwork.id).length, 2);
  second.close();
});


