// Measurement records: bounded candidate generation, deterministic measures,
// reuse of unchanged evidence, and restart recovery.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/db.mjs';
import { RelationshipAnalysis, configurationHashOf } from '../src/analysis/service.mjs';
import { MEASURES, bandFor, fullPairCount, measurePair, pairKey, planPairs, revisionOf } from '../src/analysis/relationships.mjs';

function version(id, { parentId = null, generation = 0, round = 1, slot = 'refinement', createdAt = '2026-01-01T00:00:00.000Z', configuration = {}, sourceHash = 'h', snapshotPath = null } = {}) {
  return { id, parentId, generation, round, slot, createdAt, configuration, sourceHash, snapshotPath };
}

function tree(count) {
  const versions = [version('v0', { generation: 0, round: 0, createdAt: '2026-01-01T00:00:00.000Z' })];
  for (let index = 1; index < count; index++) {
    const parent = `v${index - 1}`;
    versions.push(version(`v${index}`, { parentId: parent, generation: index, round: index, createdAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z`, slot: ['refinement', 'structure', 'experiment'][index % 3] }));
  }
  return versions;
}

async function tempStore(t) {
  const dir = await mkdtemp(join(tmpdir(), 'phygen-analysis-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  });
  const store = new Store(join(dir, 'phygen.db'));
  t.after(() => store.close());
  return { store, dir };
}

test('the measure catalog states the method and the direction of every score', () => {
  for (const measure of MEASURES) {
    assert.ok(measure.id && measure.label);
    assert.ok(['deterministic', 'model'].includes(measure.method));
    assert.ok(measure.direction.length > 10, `${measure.id} says what a high score means`);
    if (!measure.available) assert.ok(measure.unavailableReason, `${measure.id} states why it is unavailable`);
  }
  // An unavailable model measure is refused by name, and never approximated.
  assert.throws(
    () => measurePair({ measure: 'appearance', a: version('a'), b: version('b') }),
    (error) => error.code === 'measure_not_enabled',
  );
  assert.throws(() => measurePair({ measure: 'nope', a: version('a'), b: version('b') }), (error) => error.code === 'measure_unknown');
});

test('the configuration distance counts the fields that differ', () => {
  const a = version('a', { configuration: { speed: 1, decay: 5, palette: 'white' } });
  const b = version('b', { configuration: { speed: 2, decay: 5, palette: 'white' } });
  const close = measurePair({ measure: 'configuration', a, b });
  assert.ok(Math.abs(close.score - 1 / 3) < 1e-9);
  const same = measurePair({ measure: 'configuration', a, b: a });
  assert.equal(same.score, 0);
  assert.equal(same.band, 'near');
  assert.deepEqual(close.evidence.changedKeys.map((entry) => entry.key), ['speed']);
});

test('the source distance is symmetric, zero for equal code, and grows with change', () => {
  const base = { files: new Map([['src/main.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;']]) };
  const tweaked = { files: new Map([['src/main.js', 'const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 99;']]) };
  const rewritten = { files: new Map([['src/main.js', 'function run(x) { return x * 2; }\nrun(21);']]) };
  const a = version('a');
  const b = version('b');
  const identical = measurePair({ measure: 'source', a, b, aSources: base, bSources: base });
  assert.equal(identical.score, 0);
  const small = measurePair({ measure: 'source', a, b, aSources: base, bSources: tweaked });
  const large = measurePair({ measure: 'source', a, b, aSources: base, bSources: rewritten });
  assert.ok(small.score > 0 && small.score < 1, `a small change is a small distance, got ${small.score}`);
  assert.ok(large.score > small.score, 'a rewrite is further than an edit');
  const reversed = measurePair({ measure: 'source', a: b, b: a, aSources: rewritten, bSources: base });
  assert.ok(Math.abs(reversed.score - large.score) < 1e-9, 'the score does not depend on the order');
});

test('candidate generation is bounded, deterministic, and keeps lineage first', () => {
  const versions = tree(30);
  const first = planPairs({ versions, measure: 'configuration', limit: 40 });
  const shuffled = planPairs({ versions: [...versions].reverse(), measure: 'configuration', limit: 40 });
  assert.equal(first.pairs.length, 40);
  assert.deepEqual(first.pairs, shuffled.pairs, 'the same input gives the same sample');
  assert.equal(first.considered, fullPairCount(30));

  const lineage = first.pairs.filter((pair) => pair.group === 'lineage');
  assert.equal(lineage.length, 29, 'every parent link is measured first');
  for (const pair of first.pairs) {
    assert.ok(pair.a !== pair.b);
    assert.equal(pair.group === 'lineage' || pair.group === 'round' || pair.group === 'generation' || pair.group === 'slot' || pair.group === 'sampled', true);
  }
  const keys = new Set(first.pairs.map((pair) => pairKey(pair.a, pair.b)));
  assert.equal(keys.size, first.pairs.length, 'no pair appears twice');

  const generous = planPairs({ versions, measure: 'configuration', limit: 1000 });
  assert.equal(generous.pairs.length, 435, 'the whole set when the budget allows it');
});

test('a measurement run records every pair and can be rebuilt', async (t) => {
  const { store } = await tempStore(t);
  const config = loadConfig({ analysis: { maxPairs: 50 } });
  const analysis = new RelationshipAnalysis({ store, config });
  const artwork = store.createArtwork({ packageId: 'p', title: 'T', contractVersion: '1.0.0', packagePath: 'threejs' });
  const versions = tree(12);
  for (const entry of versions) {
    const record = store.createVersion({ ...entry, artworkId: artwork.id, title: entry.id, status: 'rejected', snapshotPath: join(tmpdir(), 'nope') });
    store.db.prepare('UPDATE versions SET configuration_json = ? WHERE id = ?').run(JSON.stringify(entry.configuration), record.id);
  }
  const records = store.listVersions(artwork.id);
  assert.equal(records.length, 12);

  const run = await analysis.start({ artwork, measureId: 'configuration', limit: 40 });
  assert.equal(run.measure, 'configuration');
  await new Promise((resolve) => setTimeout(resolve, 400));

  const finished = store.getAnalysisRun(run.id);
  assert.equal(finished.state, 'succeeded', finished.errorMessage ?? '');
  assert.equal(finished.progress.total, 40);
  assert.equal(finished.progress.done, 40);
  assert.equal(finished.progress.failed, 0);
  assert.match(finished.revision, /^[0-9a-f]{64}$/);

  const view = analysis.status(artwork.id, 'configuration');
  assert.equal(view.pairs.length, 40);
  assert.equal(view.stale, false, view.reason ?? '');
  for (const pair of view.pairs) {
    assert.ok(pair.versionA !== pair.versionB);
    assert.equal(pair.outcome, 'ok');
    assert.equal(typeof pair.score, 'number');
    assert.ok(['near', 'close', 'distinct', 'far'].includes(pair.band));
  }

  // A second run reuses the records it already holds.
  const again = await analysis.start({ artwork, measureId: 'configuration', limit: 40 });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const second = store.getAnalysisRun(again.id);
  assert.equal(second.state, 'succeeded');
  assert.equal(second.progress.done, 40);
  assert.equal(second.progress.reused, 40, 'unchanged evidence is reused, not measured again');
  // Exactly one record per pair: the new run replaces its own rows only.
  const pairs = store.listPairMeasurements(second.id, { limit: 500 });
  assert.equal(new Set(pairs.map((pair) => pair.pairKey)).size, pairs.length);
});

test('a changed version makes the last measurement stale', async (t) => {
  const { store } = await tempStore(t);
  const config = loadConfig({ analysis: { maxPairs: 20 } });
  const analysis = new RelationshipAnalysis({ store, config });
  const artwork = store.createArtwork({ packageId: 'p2', title: 'T2', contractVersion: '1.0.0', packagePath: 'threejs' });
  for (const entry of tree(5)) store.createVersion({ ...entry, artworkId: artwork.id, title: entry.id, status: 'rejected', snapshotPath: join(tmpdir(), 'nope') });

  await analysis.start({ artwork, measureId: 'configuration' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(analysis.status(artwork.id, 'configuration').stale, false);

  store.createVersion({ ...version('v9', { parentId: 'v4', generation: 9 }), artworkId: artwork.id, title: 'v9', status: 'rejected', snapshotPath: join(tmpdir(), 'nope') });
  const view = analysis.status(artwork.id, 'configuration');
  assert.equal(view.stale, true);
  assert.match(view.reason, /changed/);
});

test('a restart marks an unfinished measurement failed instead of leaving it half-done', async (t) => {
  const { store } = await tempStore(t);
  const config = loadConfig({ analysis: { maxPairs: 20 } });
  const analysis = new RelationshipAnalysis({ store, config });
  const artwork = store.createArtwork({ packageId: 'p3', title: 'T3', contractVersion: '1.0.0', packagePath: 'threejs' });
  const running = store.createAnalysisRun({ artworkId: artwork.id, measure: 'configuration', state: 'running', startedAt: new Date().toISOString() });

  const interrupted = analysis.recover();
  assert.deepEqual(interrupted, [running.id]);
  const after = store.getAnalysisRun(running.id);
  assert.equal(after.state, 'failed');
  assert.equal(after.errorCode, 'interrupted_by_restart');
  assert.ok(after.finishedAt);
  assert.equal(analysis.status(artwork.id, 'configuration').stale, true);
});

test('a run with too few versions and an unknown measure are refused by name', async (t) => {
  const { store } = await tempStore(t);
  const analysis = new RelationshipAnalysis({ store, config: loadConfig() });
  const artwork = store.createArtwork({ packageId: 'p4', title: 'T4', contractVersion: '1.0.0', packagePath: 'threejs' });
  await assert.rejects(analysis.start({ artwork, measureId: 'configuration' }), (error) => error.code === 'measure_too_few_versions');
  await assert.rejects(analysis.start({ artwork, measureId: 'nope' }), (error) => error.code === 'measure_unknown');
  await assert.rejects(analysis.start({ artwork, measureId: 'appearance' }), (error) => error.code === 'measure_not_enabled');
});

test('the source measure reads the published snapshot of each version', async (t) => {
  const { store, dir } = await tempStore(t);
  const analysis = new RelationshipAnalysis({ store, config: loadConfig({ analysis: { maxPairs: 10 } }) });
  const artwork = store.createArtwork({ packageId: 'p5', title: 'T5', contractVersion: '1.0.0', packagePath: 'threejs' });
  const left = join(dir, 'snap-a', 'files');
  const right = join(dir, 'snap-b', 'files');
  await mkdir(join(left, 'src'), { recursive: true });
  await mkdir(join(right, 'src'), { recursive: true });
  await writeFile(join(left, 'src', 'main.js'), 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf8');
  await writeFile(join(right, 'src', 'main.js'), 'const a = 1;\nconst b = 2;\nconst c = 9;\n', 'utf8');
  store.createVersion({ ...version('s0', { sourceHash: 'h0' }), artworkId: artwork.id, title: 's0', status: 'rejected', snapshotPath: join(dir, 'snap-a') });
  store.createVersion({ ...version('s1', { parentId: 's0', sourceHash: 'h1' }), artworkId: artwork.id, title: 's1', status: 'rejected', snapshotPath: join(dir, 'snap-b') });

  const run = await analysis.start({ artwork, measureId: 'source' });
  await new Promise((resolve) => setTimeout(resolve, 400));
  const finished = store.getAnalysisRun(run.id);
  assert.equal(finished.state, 'succeeded', finished.errorMessage ?? '');
  const pairs = store.listPairMeasurements(run.id, { limit: 10 });
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].outcome, 'ok');
  assert.ok(pairs[0].score > 0 && pairs[0].score < 1);
  assert.ok(pairs[0].evidence.unionShingles >= 1);
});

test('a band is a stable name for a score, and an unknown score is its own band', () => {
  assert.equal(bandFor(0), 'near');
  assert.equal(bandFor(0.2), 'close');
  assert.equal(bandFor(0.5), 'distinct');
  assert.equal(bandFor(0.9), 'far');
  assert.equal(bandFor(null), 'unknown');
});

test('the revision follows the evidence of every version, not the order', () => {
  const versions = tree(6);
  const hashes = new Map(versions.map((entry) => [entry.id, configurationHashOf(entry)]));
  const first = revisionOf({ measure: 'configuration', versions, hashes });
  const shuffled = revisionOf({ measure: 'configuration', versions: [...versions].reverse(), hashes });
  assert.equal(first, shuffled);
  const changed = new Map(hashes);
  changed.set('v3', 'different');
  assert.notEqual(first, revisionOf({ measure: 'configuration', versions, hashes: changed }));
});
