// The hard tests, the coherence score, and the decision are pure tables. Each
// row below is one crafted case: a park on each hard test, a park on low
// coherence, a park on a near-copy, and a keep on a coherent novel step.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { blockDistance, frameDelta, histogramDistance, perceptualDistance } from '../src/vision/distance.mjs';
import { coherenceScore, decideGate, meanScore, noveltyOf, opennessTerm } from '../src/vision/rubric.mjs';
import { DEFAULT_FLOORS, runHardTests } from '../src/vision/tests.mjs';
import { configDistance, sourceSimilarity } from '../src/vision/relationships.mjs';

function histogram(values) {
  const out = new Float32Array(16);
  for (const [bin, value] of values) out[bin] = value;
  return out;
}

function blockMap(fill, values = []) {
  const out = new Float32Array(256).fill(fill);
  values.forEach(([index, value]) => {
    out[index] = value;
  });
  return out;
}

/** A frame that passes every hard test. */
function goodFeatures(overrides = {}) {
  return {
    colorfulness: 0.6,
    saturationClipFraction: 0.05,
    luminanceEntropy: 0.7,
    edgeDensity: 0.2,
    edgeBalance: 0.6,
    occupiedFraction: 0.25,
    dominantRidgeShare: 0.4,
    hueSpread: 0.3,
    histogram: histogram([[3, 1]]),
    blockMap: blockMap(0.5),
    ...overrides,
  };
}

test('the distance is symmetric and zero for one frame', () => {
  const a = goodFeatures();
  const b = goodFeatures({ histogram: histogram([[9, 1]]), blockMap: blockMap(0.1) });
  assert.equal(histogramDistance(a.histogram, a.histogram), 0);
  assert.equal(blockDistance(a.blockMap, a.blockMap), 0);
  assert.equal(perceptualDistance(a, a), 0);
  assert.ok(Math.abs(perceptualDistance(a, b) - perceptualDistance(b, a)) < 1e-9);
  assert.ok(perceptualDistance(a, b) > 0);
  assert.equal(histogramDistance(histogram([[3, 1]]), histogram([[9, 1]])), 1);
  assert.equal(frameDelta(null, a), null);
});

test('each hard test trips on its own crafted frame', () => {
  const cases = [
    ['saturation_clipping', { saturationClipFraction: DEFAULT_FLOORS.saturationClipMax + 0.1 }],
    ['uniform_noise', { edgeDensity: DEFAULT_FLOORS.uniformEdgeMin + 0.1, luminanceEntropy: DEFAULT_FLOORS.uniformEntropyMax - 0.1 }],
    ['empty_or_cord', { occupiedFraction: DEFAULT_FLOORS.emptyOccupiedMin - 0.01 }],
    ['empty_or_cord', { dominantRidgeShare: DEFAULT_FLOORS.cordRidgeMax + 0.05 }],
    ['rainbow', { hueSpread: DEFAULT_FLOORS.rainbowHueSpreadMax + 0.05 }],
  ];
  for (const [name, overrides] of cases) {
    const result = runHardTests({ features: goodFeatures(overrides) });
    assert.ok(result.tripped.includes(name), `${name} must trip for ${JSON.stringify(overrides)}`);
  }
  assert.deepEqual(runHardTests({ features: goodFeatures() }).tripped, []);
});

test('the ordered-frame test trips on no development and on a violent change', () => {
  const still = runHardTests({ features: goodFeatures({ blockMap: blockMap(0.2) }), early: goodFeatures({ blockMap: blockMap(0.2) }) });
  assert.ok(still.tripped.includes('strobing'));
  const violent = runHardTests({ features: goodFeatures({ blockMap: blockMap(1) }), early: goodFeatures({ blockMap: blockMap(0) }) });
  assert.ok(violent.tripped.includes('strobing'));
  const developed = runHardTests({ features: goodFeatures({ blockMap: blockMap(0.3) }), early: goodFeatures({ blockMap: blockMap(0.25) }) });
  assert.equal(developed.tripped.includes('strobing'), false);
});

test('a missing early frame is a recorded skip, not a pass and not a zero', () => {
  const result = runHardTests({ features: goodFeatures() });
  const strobing = result.tests.find((entry) => entry.name === 'strobing');
  assert.equal(strobing.available, false);
  assert.equal(strobing.value, null);
  assert.equal(strobing.tripped, false);
  assert.equal(result.available, false);
});

test('coherence rises with a developed, open, varied frame', () => {
  const rich = coherenceScore(goodFeatures());
  const flat = coherenceScore(goodFeatures({ colorfulness: 0, luminanceEntropy: 0, edgeBalance: 0, occupiedFraction: 0, dominantRidgeShare: 0 }));
  assert.ok(rich.score > 0.5);
  assert.equal(flat.score, 0);
  assert.equal(opennessTerm(goodFeatures({ occupiedFraction: 0, dominantRidgeShare: 0 })), 0);
  assert.ok(opennessTerm(goodFeatures({ occupiedFraction: 0.35, dominantRidgeShare: 0.1 })) > 0.9);
  assert.equal(opennessTerm(goodFeatures({ occupiedFraction: 0.35, dominantRidgeShare: 1 })), 0);
});

test('novelty is the nearest distance to the parent and every archive member', () => {
  const parent = goodFeatures();
  const distant = goodFeatures({ histogram: histogram([[9, 1]]), blockMap: blockMap(0) });
  const candidate = goodFeatures();
  const { novelty, nearest, distances } = noveltyOf(candidate, [
    { id: 'parent', role: 'parent', features: parent },
    { id: 'member', role: 'archive', features: distant },
  ]);
  assert.equal(distances.length, 2);
  assert.equal(novelty, 0, 'the candidate is a copy of its parent');
  assert.equal(nearest.id, 'parent');
  assert.equal(noveltyOf(candidate, []).novelty, 1);
});

test('the decision table parks and keeps on the crafted numbers', () => {
  const table = [
    // park on each hard test
    { input: { tripped: ['rainbow'], coherence: 0.9, novelty: 0.9 }, verdict: 'parked' },
    { input: { tripped: ['saturation_clipping'], coherence: 0.9, novelty: 0.9 }, verdict: 'parked' },
    // park on low coherence
    { input: { coherence: 0.1, novelty: 0.9 }, verdict: 'parked' },
    // park on a near-copy
    { input: { coherence: 0.9, novelty: 0.02 }, verdict: 'parked' },
    // park on a quality regression with weak novelty
    { input: { coherence: 0.9, novelty: 0.2, quality: 0.4, parentQuality: 0.8 }, verdict: 'parked' },
    // keep: coherent and novel
    { input: { coherence: 0.7, novelty: 0.5, quality: 0.7, parentQuality: 0.7 }, verdict: 'kept', branch: 'both' },
    // keep: coherent, novelty not strong
    { input: { coherence: 0.7, novelty: 0.2, quality: 0.7, parentQuality: 0.7 }, verdict: 'kept', branch: 'quality' },
    // keep: a quality drop that strong novelty excuses
    { input: { coherence: 0.7, novelty: 0.5, quality: 0.4, parentQuality: 0.8 }, verdict: 'kept', branch: 'novelty' },
    // keep: the root's first child has no parent quality
    { input: { coherence: 0.7, novelty: 0.5, quality: null, parentQuality: null }, verdict: 'kept', branch: 'novelty' },
  ];
  for (const row of table) {
    const result = decideGate(row.input);
    assert.equal(result.verdict, row.verdict, JSON.stringify(row.input));
    if (row.branch) assert.equal(result.branch, row.branch, JSON.stringify(row.input));
    assert.match(result.reason, /^(Kept|Parked):/);
  }
  assert.equal(meanScore([{ score: 0.4 }, { score: 0.6 }]), 0.5);
  assert.equal(meanScore([]), null);
});

test('the deterministic record measures are pure and bounded', () => {
  const a = { configuration: { palette: 'ember', count: 4000, nested: { wind: 0.2 } } };
  const b = { configuration: { palette: 'inferno', count: 4000, nested: { wind: 0.2 } } };
  assert.equal(configDistance(a, a).score, 0);
  assert.ok(configDistance(a, b).score > 0);
  assert.equal(configDistance(a, b).score, configDistance(b, a).score);
  const files = (text) => ({ files: new Map([['src/physarum.js', text]]) });
  assert.equal(sourceSimilarity(files('alpha beta gamma delta epsilon'), files('alpha beta gamma delta epsilon')).score, 1);
  assert.equal(sourceSimilarity(files('alpha beta gamma delta epsilon'), files('zeta eta theta iota kappa')).score, 0);
});
