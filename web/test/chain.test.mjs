// The playing rule: exactly one version plays live, and it is the newest
// promoted one.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { chainOrder, playingVersionId, stepLabels } from '../src/chain.ts';

function node(id, generation, status, createdAt) {
  return {
    id,
    parentId: null,
    generation,
    step: generation,
    title: id,
    status,
    palette: null,
    stillUrl: null,
    stillStage: null,
    stillStep: null,
    livePath: `/live/${id}`,
    liveUrl: `http://live/${id}`,
    sourceHash: 'h',
    createdAt,
    onLineage: status === 'promoted',
    changes: [],
    explanation: null,
    stub: false,
    usageUsd: 0,
    tokens: 0,
    error: null,
  };
}

const CHAIN = [
  node('root', 0, 'promoted', '2026-01-01T00:00:00.000Z'),
  node('step1', 1, 'promoted', '2026-01-01T00:01:00.000Z'),
  node('step2', 2, 'promoted', '2026-01-01T00:02:00.000Z'),
  node('step3', 3, 'failed', '2026-01-01T00:03:00.000Z'),
];

test('the newest promoted version plays, and every other version does not', () => {
  assert.equal(playingVersionId(CHAIN), 'step2');

  // A failed newest version never plays: the newest PROMOTED version does.
  assert.equal(playingVersionId([...CHAIN, node('step4', 4, 'failed', '2026-01-01T00:04:00.000Z')]), 'step2');

  // A version still in progress does not play.
  assert.equal(playingVersionId([...CHAIN, node('step5', 5, 'capturing', '2026-01-01T00:05:00.000Z')]), 'step2');

  // A chain with nothing promoted has no playing version.
  assert.equal(playingVersionId([node('only', 0, 'failed', '2026-01-01T00:00:00.000Z')]), null);
  assert.equal(playingVersionId([]), null);
});

test('two attempts at one step never carry the same name', () => {
  const nodes = [
    node('root', 0, 'promoted', '2026-01-01T00:00:00.000Z'),
    node('step1', 1, 'promoted', '2026-01-01T00:01:00.000Z'),
    // A failed attempt at step 2, then a second attempt from the same parent.
    node('try2a', 2, 'failed', '2026-01-01T00:02:00.000Z'),
    node('try2b', 2, 'promoted', '2026-01-01T00:03:00.000Z'),
    node('step3', 3, 'promoted', '2026-01-01T00:04:00.000Z'),
  ];
  const labels = stepLabels(nodes);
  assert.deepEqual(labels, {
    root: 'Root',
    step1: 'Step 1',
    try2a: 'Step 2a',
    try2b: 'Step 2b',
    step3: 'Step 3',
  });
  // Every card name is unique.
  assert.equal(new Set(Object.values(labels)).size, nodes.length);
});

test('the chain order puts the newest version first', () => {  const ordered = chainOrder([...CHAIN].reverse());
  assert.deepEqual(
    ordered.map((entry) => entry.id),
    ['step3', 'step2', 'step1', 'root'],
  );
  // Two versions of one generation order by creation time.
  const same = chainOrder([
    node('b', 1, 'promoted', '2026-01-01T00:02:00.000Z'),
    node('a', 1, 'promoted', '2026-01-01T00:01:00.000Z'),
  ]);
  assert.deepEqual(
    same.map((entry) => entry.id),
    ['b', 'a'],
  );
});
