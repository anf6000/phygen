// The playing rule: exactly one version plays live, and it is the newest
// promoted one.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { READING_LINE_FRACTION, autoplayCardId, chainOrder, playingVersionId, stepLabels, visibleCardId } from '../src/chain.ts';

test('the next artwork starts while the one above is a fifth visible', () => {
  assert.equal(READING_LINE_FRACTION, 0.2);
  // The step between two cards: one card, plus the gap the chain leaves.
  const cardHeight = 1093;
  const gap = 24;
  const pitch = cardHeight + gap;
  const line = pitch * READING_LINE_FRACTION;
  // The line sits where the next card's top edge arrives, so the artwork above
  // it still shows what is left of it below the top of the view.
  const upperVisible = Math.max(0, line - gap);
  const share = upperVisible / cardHeight;
  assert.ok(Math.abs(share - 0.2) < 0.03, `the upper artwork shows ${(share * 100).toFixed(0)}%, not about 20%`);
  // The new artwork takes over as it comes on screen: at least its top half.
  const viewHeight = 1000;
  assert.ok((viewHeight - line) / cardHeight > 0.7, 'the new artwork must be nearly all on screen');
});

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

test('the card at the top of the view plays live', () => {
  // Cards are 1024 px tall in the chain, newest first.
  const cards = [
    { id: 'step3', top: 0 },
    { id: 'step2', top: 1060 },
    { id: 'step1', top: 2120 },
    { id: 'root', top: 3180 },
  ];

  // A page that has just loaded: the newest card plays.
  assert.equal(visibleCardId(cards, 0), 'step3');
  assert.equal(visibleCardId(cards, 30), 'step3');

  // Scrolling down stops one and starts the next.
  assert.equal(visibleCardId(cards, 1060), 'step2');
  assert.equal(visibleCardId(cards, 1800), 'step2');
  assert.equal(visibleCardId(cards, 2120), 'step1');
  assert.equal(visibleCardId(cards, 4000), 'root');

  // An empty chain has no live card, and a view above every card keeps the newest.
  assert.equal(visibleCardId([], 0), null);
  assert.equal(visibleCardId(cards, -500), 'step3');
});

test('a card that is still being made cannot play, so the newest finished one does', () => {
  // The newest card is the step the run is working on: no snapshot yet.
  const cards = [
    { id: 'step6', top: 0, playable: false },
    { id: 'step5', top: 1060, playable: true },
    { id: 'step4', top: 2120, playable: true },
    { id: 'root', top: 3180, playable: true },
  ];
  // A page that has just loaded: the newest artwork plays, because the card at
  // the top of the view has nothing to show yet.
  assert.equal(autoplayCardId(cards, 8), 'step5');

  // Scrolling to a card that can play makes THAT card play.
  assert.equal(autoplayCardId(cards, 2120), 'step4');
  assert.equal(autoplayCardId(cards, 3200), 'root');

  // While the view sits on the working card, the newest finished one plays.
  assert.equal(autoplayCardId(cards, 400), 'step5');

  // A chain with nothing playable plays nothing, and an empty chain is safe.
  assert.equal(autoplayCardId(cards.map((card) => ({ ...card, playable: false })), 8), null);
  assert.equal(autoplayCardId([], 0), null);
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
