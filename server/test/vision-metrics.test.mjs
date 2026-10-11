// The metric functions are the free half of the gate. Each is asserted on a
// synthetic frame with a known answer, so a regression cannot hide behind a
// plausible-looking number.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  blockMap,
  coarseHistogram,
  colorfulness,
  dominantRidgeShare,
  hueSpread,
  luminanceEntropy,
  luminancePlane,
  measureFrame,
  occupiedStats,
  saturationClipFraction,
  sobelEdges,
} from '../src/vision/metrics.mjs';

function frame(width, height, paint) {
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 4;
      const [r, g, b, a] = paint(x, y);
      rgba[at] = r;
      rgba[at + 1] = g;
      rgba[at + 2] = b;
      rgba[at + 3] = a ?? 255;
    }
  }
  return { width, height, rgba };
}

function hsv(hue, saturation = 1, value = 1) {
  const c = value * saturation;
  const hh = ((hue % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = value - c;
  let rgb;
  if (hh < 1) rgb = [c, x, 0];
  else if (hh < 2) rgb = [x, c, 0];
  else if (hh < 3) rgb = [0, c, x];
  else if (hh < 4) rgb = [0, x, c];
  else if (hh < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  return rgb.map((channel) => Math.round((channel + m) * 255));
}

test('a flat frame has no colorfulness, no entropy, no edges, and nothing occupied', () => {
  const flat = frame(8, 8, () => [120, 120, 120]);
  const features = measureFrame(flat);
  assert.equal(features.colorfulness, 0);
  assert.equal(features.luminanceEntropy, 0);
  assert.equal(features.edgeDensity, 0);
  assert.equal(features.occupiedFraction, 0);
  assert.equal(features.dominantRidgeShare, 0);
  assert.equal(features.hueSpread, 0);
});

test('colorfulness is zero for grays and positive for a saturated mix', () => {
  assert.equal(colorfulness(frame(4, 4, () => [40, 40, 40]).rgba, 16), 0);
  const mixed = frame(8, 8, (x, y) => ((x + y) % 2 === 0 ? [255, 0, 0] : [0, 0, 255]));
  assert.ok(colorfulness(mixed.rgba, 64) > 0);
});

test('saturation clipping counts the pixels that hold a maximum channel', () => {
  assert.equal(saturationClipFraction(frame(2, 2, () => [255, 255, 255]).rgba, 4), 1);
  assert.equal(saturationClipFraction(frame(2, 2, () => [10, 10, 10]).rgba, 4), 0);
  assert.equal(saturationClipFraction(frame(2, 2, (x) => (x === 0 ? [255, 0, 0] : [0, 0, 0])).rgba, 4), 0.5);
});

test('luminance entropy is zero for one value and one for two equal values', () => {
  const one = luminancePlane(frame(4, 4, () => [128, 128, 128]).rgba, 16);
  assert.equal(luminanceEntropy(one), 0);
  const two = luminancePlane(frame(2, 1, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255])).rgba, 2);
  assert.equal(luminanceEntropy(two), 1);
});

test('a single edge is dense but one-directional; a grid is balanced', () => {
  const edge = frame(16, 16, (x) => (x < 8 ? [0, 0, 0] : [255, 255, 255]));
  const edgeLuma = luminancePlane(edge.rgba, 256);
  const edgeStats = sobelEdges(edgeLuma, 16, 16, 0.08);
  assert.ok(edgeStats.density > 0);
  assert.ok(edgeStats.balance < 0.5, 'a vertical edge spreads over few directions');

  const grid = frame(16, 16, (x, y) => ((x % 4 < 2) !== (y % 4 < 2) ? [255, 255, 255] : [0, 0, 0]));
  const gridStats = sobelEdges(luminancePlane(grid.rgba, 256), 16, 16, 0.08);
  assert.ok(gridStats.balance > edgeStats.balance, 'a grid spreads over more directions');
});

test('occupancy finds the background and the pixels that leave it', () => {
  // A black frame with a red block over one quarter of the area.
  const painted = frame(4, 4, (x, y) => (x < 2 && y < 2 ? [255, 0, 0] : [0, 0, 0]));
  const stats = occupiedStats(painted.rgba, 4, 4, 0.09);
  assert.equal(stats.background[0] < 16, true);
  assert.equal(stats.occupiedPixels, 4);
  assert.equal(stats.occupiedFraction, 0.25);
});

test('the dominant ridge share separates one block from two', () => {
  const one = occupiedStats(frame(64, 16, (x, y) => (x < 16 && y < 16 ? [255, 0, 0] : [0, 0, 0])).rgba, 64, 16, 0.09);
  assert.equal(dominantRidgeShare(one.mask, 64, 16, 64), 1);
  const two = occupiedStats(
    frame(64, 16, (x) => ((x < 16 || x >= 48) ? [255, 0, 0] : [0, 0, 0])).rgba,
    64,
    16,
    0.09,
  );
  assert.equal(dominantRidgeShare(two.mask, 64, 16, 64), 0.5);
});

test('hue spread is zero for one hue and near one for a full rainbow', () => {
  const single = frame(32, 32, () => hsv(20));
  assert.ok(hueSpread(single.rgba, 1024) < 0.05);
  const rainbow = frame(360, 4, (x) => hsv(x));
  assert.ok(hueSpread(rainbow.rgba, 1440) > 0.8);
});

test('the histogram sums to one and the block map is a coarse average', () => {
  const half = frame(2, 1, (x) => (x === 0 ? [0, 0, 0] : [255, 255, 255]));
  const histogram = coarseHistogram(luminancePlane(half.rgba, 2), 16);
  const sum = [...histogram].reduce((total, value) => total + value, 0);
  assert.ok(Math.abs(sum - 1) < 1e-6);

  const map = blockMap(luminancePlane(half.rgba, 2), 2, 1, 16);
  assert.equal(map.length, 256);
  const total = [...map].reduce((sumValue, value) => sumValue + value, 0);
  assert.ok(Math.abs(total - 1) < 1e-6, 'one black and one white pixel average to one over the grid');
});
