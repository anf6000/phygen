// The judge parser must accept one good answer and refuse every malformed class.
// A refusal is a recorded failure, never a silent pass and never a silent zero.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CRITERIA, JudgeError, assignBlindLabels, judgeCandidate, parseJudgeAnswer, validateJudgeAnswer } from '../src/vision/judge.mjs';

const entries = [
  { versionId: 'cand', captures: [{ stage: 'late', step: 1000 }] },
  { versionId: 'par', captures: [{ stage: 'early', step: 500 }, { stage: 'late', step: 1000 }] },
];

function contextOf(labels) {
  const labelToVersion = {};
  for (const [versionId, label] of Object.entries(labels)) labelToVersion[label] = versionId;
  return { entries, labels, labelToVersion };
}

function citationFor(versionId, labels, frame) {
  return `${labels[versionId]}|${frame}`;
}

function goodAnswer(labels) {
  return {
    observations: [
      { label: labels.cand, frame: 'late@1000', detail: 'The candidate holds one connected ribbon with open space.' },
      { label: labels.par, frame: 'early@500', detail: 'The parent holds a denser, older structure.' },
    ],
    scores: CRITERIA.map((criterion, index) => ({
      criterion,
      score: 0.5 + index * 0.05,
      frames: [citationFor('cand', labels, 'late@1000')],
    })),
    weaknesses: ['The candidate leaves one region too quiet.'],
    distinctiveness: 'high',
    uncertainty: 'low',
    confidence: 0.7,
    notes: 'A clear structural change.',
  };
}

test('labels are assigned in a randomized, complete order', () => {
  const { labels, labelToVersion, ordered } = assignBlindLabels(entries, { random: () => 0 });
  assert.equal(ordered.length, 2);
  assert.deepEqual(Object.keys(labels).sort(), ['cand', 'par']);
  assert.equal(labelToVersion[labels.cand], 'cand');
  assert.notEqual(labels.cand, labels.par);
});

test('a good answer is accepted and its mean is computed', () => {
  const { labels, labelToVersion } = assignBlindLabels(entries, { random: () => 0 });
  const verdict = validateJudgeAnswer(goodAnswer(labels), { entries, labels, labelToVersion });
  assert.equal(verdict.scores.length, CRITERIA.length);
  assert.ok(verdict.mean > 0.5 && verdict.mean < 0.8);
  assert.equal(verdict.observations.length, 2);
});

test('a frame that was not sent is refused', () => {
  const { labels, labelToVersion } = assignBlindLabels(entries, { random: () => 0 });
  const bad = goodAnswer(labels);
  bad.observations[0].frame = 'late@7777';
  assert.throws(() => validateJudgeAnswer(bad, { entries, labels, labelToVersion }), (error) => error instanceof JudgeError && error.code === 'judge_response_invalid');
});

test('an unknown label is refused', () => {
  const { labels, labelToVersion } = assignBlindLabels(entries, { random: () => 0 });
  const bad = goodAnswer(labels);
  bad.observations[0].label = 'Z';
  assert.throws(() => validateJudgeAnswer(bad, { entries, labels, labelToVersion }), (error) => error.code === 'judge_response_invalid');
});

test('a missing criterion is refused', () => {
  const { labels, labelToVersion } = assignBlindLabels(entries, { random: () => 0 });
  const bad = goodAnswer(labels);
  bad.scores = bad.scores.slice(1);
  assert.throws(() => validateJudgeAnswer(bad, { entries, labels, labelToVersion }), (error) => error.code === 'judge_response_invalid');
});

test('a score outside 0..1 and a citation with no frame are refused', () => {
  const { labels, labelToVersion } = assignBlindLabels(entries, { random: () => 0 });
  const high = goodAnswer(labels);
  high.scores[0].score = 1.5;
  assert.throws(() => validateJudgeAnswer(high, { entries, labels, labelToVersion }), (error) => error.code === 'judge_response_invalid');
  const uncited = goodAnswer(labels);
  uncited.scores[0].frames = [];
  assert.throws(() => validateJudgeAnswer(uncited, { entries, labels, labelToVersion }), (error) => error.code === 'judge_response_invalid');
});

test('text without a JSON object is a recorded failure', () => {
  const { labels, labelToVersion } = assignBlindLabels(entries, { random: () => 0 });
  assert.throws(() => parseJudgeAnswer('I think the candidate is better.', { entries, labels, labelToVersion }), (error) => error.code === 'judge_response_invalid');
});

test('judgeCandidate sends every frame and validates the answer', async () => {
  const seen = [];
  const ask = async (request) => {
    seen.push(request);
    return { text: JSON.stringify(goodAnswer(request.labels)), usage: { inputTokens: 1, outputTokens: 1, costUsd: 0 }, model: 'test' };
  };
  const result = await judgeCandidate({
    ask,
    candidate: { versionId: 'cand', frames: [{ stage: 'late', step: 1000, path: 'a.png' }] },
    parent: { versionId: 'par', frames: [{ stage: 'early', step: 500, path: 'b.png' }, { stage: 'late', step: 1000, path: 'c.png' }] },
    random: () => 0,
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].images.length, 3);
  assert.equal(result.scores.length, CRITERIA.length);
  assert.equal(result.frames.length, 3);
});
