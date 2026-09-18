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
import { isTransientProviderError } from '../src/providers/index.mjs';
import { extractJson } from '../src/providers/json.mjs';
import { lineStats, reviewEdits } from '../src/artwork/workspace.mjs';
import { assignLabels, decideWinner, validateVerdict, MAX_COMPARISON_ENTRIES } from '../src/judge/protocol.mjs';

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

test('the novelty branch promotes a distinct candidate that the margin would refuse', () => {
  const make = (preference, confidence, uncertainty) => ({ verdict: { preference, confidence, uncertainty }, labelToVersion: { A: 'ver_parent', B: 'ver_candidate' }, labels: { ver_parent: 'A', ver_candidate: 'B' } });
  const novelty = { candidateVersionId: 'ver_candidate', distance: 0.62, floor: 0.35, tolerance: 0.1 };

  // A clear quality win still promotes through the quality branch, with novelty unused.
  const clear = decideWinner({ primary: make('B', 0.8, 'low'), reversed: make('B', 0.7, 'low'), parentVersionId: 'ver_parent', promoteMargin: 0.15, novelty });
  assert.equal(clear.branch, 'quality');
  assert.equal(clear.promoted, true);

  // A preference too weak to permit promotion now permits it when the candidate is distinct.
  const weakButNovel = decideWinner({ primary: make('B', 0.06, 'high'), reversed: make('B', 0.05, 'high'), parentVersionId: 'ver_parent', promoteMargin: 0.15, novelty });
  assert.equal(weakButNovel.promoted, true);
  assert.equal(weakButNovel.branch, 'novelty');
  assert.equal(weakButNovel.winnerVersionId, 'ver_candidate');
  assert.match(weakButNovel.reason, /novel at 0\.62/);

  // The same weak preference keeps the parent when the candidate is a near copy.
  const weakAndClose = decideWinner({
    primary: make('B', 0.06, 'high'),
    reversed: make('B', 0.05, 'high'),
    parentVersionId: 'ver_parent',
    promoteMargin: 0.15,
    novelty: { ...novelty, distance: 0.1 },
  });
  assert.equal(weakAndClose.promoted, false);
  assert.equal(weakAndClose.branch, 'none');

  // A parent that wins weakly is within tolerance, so a distinct candidate takes the lineage.
  const parentWonWeakly = decideWinner({ primary: make('A', 0.08, 'high'), reversed: make('A', 0.05, 'high'), parentVersionId: 'ver_parent', promoteMargin: 0.15, novelty });
  assert.equal(parentWonWeakly.promoted, true);
  assert.equal(parentWonWeakly.branch, 'novelty');
  assert.equal(parentWonWeakly.winnerVersionId, 'ver_candidate');

  // A parent that wins clearly is never overridden by novelty.
  const parentWonClearly = decideWinner({ primary: make('A', 0.9, 'low'), reversed: make('A', 0.85, 'low'), parentVersionId: 'ver_parent', promoteMargin: 0.15, novelty });
  assert.equal(parentWonClearly.promoted, false);
  assert.equal(parentWonClearly.branch, 'none');

  // A disagreement is not evidence that the candidate is good, so novelty cannot act on it.
  const disagreement = decideWinner({ primary: make('B', 0.9, 'low'), reversed: make('A', 0.9, 'low'), parentVersionId: 'ver_parent', promoteMargin: 0.15, novelty });
  assert.equal(disagreement.promoted, false);
  assert.equal(disagreement.novelty.distance, 0.62, 'the numbers are recorded even when the branch does not fire');

  // Without novelty the behaviour is exactly as before.
  const withoutNovelty = decideWinner({ primary: make('B', 0.06, 'high'), reversed: make('B', 0.05, 'high'), parentVersionId: 'ver_parent', promoteMargin: 0.15 });
  assert.equal(withoutNovelty.promoted, false);
  assert.equal(withoutNovelty.branch, 'none');
});

test('a reversed comparison that never answered keeps the parent instead of throwing', () => {
  // A live run failed with "Cannot read properties of undefined (reading
  // 'preference')" when the reversed comparison did not complete. A missing
  // verdict must read as no opinion.
  const primary = { verdict: { preference: 'B', confidence: 0.8, uncertainty: 'low' }, labelToVersion: { A: 'ver_parent', B: 'ver_candidate' }, labels: { ver_parent: 'A', ver_candidate: 'B' } };
  const decision = decideWinner({ primary, reversed: null, parentVersionId: 'ver_parent', promoteMargin: 0.15 });
  assert.equal(decision.promoted, false);
  assert.equal(decision.winnerVersionId, 'ver_parent');
  assert.match(decision.reason, /reversed comparison did not complete/);
  assert.equal(decision.branch, 'none');

  // A comparison with no verdict at all is an abstention, not a crash.
  const abstained = decideWinner({
    primary: { verdict: { preference: 'none', confidence: 0, uncertainty: 'high' }, labelToVersion: { A: 'ver_parent' }, labels: { ver_parent: 'A' } },
    reversed: undefined,
    parentVersionId: 'ver_parent',
    promoteMargin: 0.15,
  });
  assert.equal(abstained.promoted, false);
  assert.equal(abstained.winnerVersionId, 'ver_parent');
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

test('a comparison holds a parent and all eight supported variants', () => {
  assert.equal(MAX_COMPARISON_ENTRIES, 9);
  const entries = Array.from({ length: 9 }, (_, index) => ({ versionId: `v${index}` }));
  const { labels, labelToVersion } = assignLabels(entries);
  assert.equal(Object.keys(labelToVersion).length, 9);
  assert.deepEqual(Object.values(labels).sort(), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']);
  assert.throws(() => assignLabels([...entries, { versionId: 'v9' }]), (error) => error.code === 'too_many_entries');
});

test('a run is refused before its records exist when it cannot be afforded or judged', (t) => {
  const store = makeStore(t);
  const events = new EventBus(store);

  const capped = loadConfig({ cost: { maxRunUsd: 1, maxRounds: 0, maxCallsPerRun: 0 } });
  const budget = new Budget({ store, events, config: capped });
  assert.throws(
    () => budget.assertAdmission({ evolutions: 2, variants: 3, limitUsd: 0.5, boundUsd: 2 }),
    (error) => error instanceof BudgetError && error.code === 'budget_exceeded',
  );
  assert.throws(
    () => budget.assertAdmission({ evolutions: 2, variants: 3, limitUsd: 0, boundUsd: 2 }),
    (error) => error.code === 'budget_exceeded',
  );
  assert.equal(store.listRuns(10).length, 0, 'the check never writes a record');

  // A run with no per-run limit and no ceiling is admitted.
  const open = new Budget({ store, events, config: loadConfig({ cost: { maxRunUsd: 0, maxRounds: 0, maxCallsPerRun: 0 } }) });
  assert.equal(open.assertAdmission({ evolutions: 2, variants: 3, limitUsd: 0, boundUsd: 5 }), true);

  const roundLimited = new Budget({ store, events, config: loadConfig({ cost: { maxRounds: 1, maxRunUsd: 0, maxCallsPerRun: 0 } }) });
  assert.throws(
    () => roundLimited.assertAdmission({ evolutions: 3, variants: 2, limitUsd: 0, boundUsd: 0 }),
    (error) => error.code === 'round_limit_reached',
  );
});

test('a startup configuration that cannot run is refused by name', () => {
  assert.throws(
    () => loadConfig({ evolution: { stepSchedule: [] } }),
    (error) => error.code === 'config_invalid' && /stepSchedule/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ evolution: { stepSchedule: [1800, 600, 3600] } }),
    (error) => error.code === 'config_invalid' && /PHYGEN_STEP_SCHEDULE/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ evolution: { stepSchedule: [600, 1800] } }),
    (error) => error.code === 'config_invalid' && /same length/.test(error.message),
  );
  assert.throws(
    () => loadConfig({ evolution: { variants: 9 } }),
    (error) => error.code === 'config_invalid',
  );
  assert.throws(
    () => loadConfig({ evolution: { seeds: [] } }),
    (error) => error.code === 'config_invalid',
  );
  assert.equal(loadConfig().evolution.variants, 3);
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


