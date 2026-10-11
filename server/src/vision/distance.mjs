// ─────────────────────────────────────────────────────────────────────────────
// distance.mjs — how far apart two frames look, from their features alone.
//
// Every function is pure and symmetric: `d(a, b) === d(b, a)`, and `d(a, a)`
// is 0. That is what makes a novelty floor a real threshold, and what lets a
// recorded distance be reproduced later.
// ─────────────────────────────────────────────────────────────────────────────

function clamp01(value) {
  if (!Number.isFinite(value)) return 1;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Total-variation distance between two normalized histograms, in 0..1. */
export function histogramDistance(a, b) {
  if (!a || !b) return 1;
  const length = Math.min(a.length, b.length);
  if (length === 0) return 1;
  let sum = 0;
  for (let index = 0; index < length; index++) sum += Math.abs(a[index] - b[index]);
  return clamp01(sum / 2);
}

/** Mean absolute difference of two block maps, in 0..1. */
export function blockDistance(a, b) {
  if (!a || !b) return 1;
  const length = Math.min(a.length, b.length);
  if (length === 0) return 1;
  let sum = 0;
  for (let index = 0; index < length; index++) sum += Math.abs(a[index] - b[index]);
  return clamp01(sum / length);
}

/** The whole-image change used by the ordered-frame test, in 0..1. */
export function frameDelta(a, b) {
  if (!a || !b) return null;
  return blockDistance(a.blockMap, b.blockMap);
}

/**
 * The perceptual distance between two measured frames.
 *
 * The histogram distance sees a palette or tone change; the block distance sees
 * a change of structure. Neither alone is enough, so they are weighted.
 *
 * @param {object} a a `measureFrame` result
 * @param {object} b another `measureFrame` result
 * @param {{histogramWeight?: number}} [options]
 */
export function perceptualDistance(a, b, { histogramWeight = 0.5 } = {}) {
  if (!a || !b) return 1;
  const histogram = histogramDistance(a.histogram, b.histogram);
  const blocks = blockDistance(a.blockMap, b.blockMap);
  return clamp01(histogramWeight * histogram + (1 - histogramWeight) * blocks);
}
