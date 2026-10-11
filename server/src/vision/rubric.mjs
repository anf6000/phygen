// ─────────────────────────────────────────────────────────────────────────────
// rubric.mjs — the coherence score and the keep/park decision. Pure.
//
// The decision is a table of numbers: no store, no clock, no random source. The
// same features and the same floors always give the same verdict, and the reason
// names the exact number that failed, so a parked step can be explained.
// ─────────────────────────────────────────────────────────────────────────────
import { perceptualDistance } from './distance.mjs';

const clamp01 = (value) => (Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0);

/** The coherence weights and the decision floors. Warn mode uses these as-is. */
export const DEFAULT_RUBRIC = Object.freeze({
  coherenceFloor: 0.32,
  noveltyFloor: 0.12,
  qualityTolerance: 0.12,
  strongNovelty: 0.3,
  weightColorfulness: 0.2,
  weightEntropy: 0.3,
  weightEdgeBalance: 0.25,
  weightOpenness: 0.25,
  /** The occupancy that counts as fully developed for the openness term. */
  developmentOccupied: 0.35,
  /** The ridge share below which openness is not reduced. */
  opennessRidgeFree: 0.3,
});

/**
 * The "open but developed" term: a frame that holds a developed structure AND
 * leaves open area. A frame with nothing occupied, or one held by a single cord,
 * scores near zero.
 */
export function opennessTerm(features, rubric = {}) {
  const r = { ...DEFAULT_RUBRIC, ...rubric };
  const development = clamp01(features.occupiedFraction / r.developmentOccupied);
  const ridge = clamp01((features.dominantRidgeShare - r.opennessRidgeFree) / (1 - r.opennessRidgeFree));
  return clamp01(development * (1 - ridge));
}

/**
 * The coherence score in 0..1, as a weighted mean of four normalized terms.
 *
 * @returns {{score: number, terms: object}}
 */
export function coherenceScore(features, rubric = {}) {
  const r = { ...DEFAULT_RUBRIC, ...rubric };
  const terms = {
    colorfulness: clamp01(features.colorfulness),
    luminanceEntropy: clamp01(features.luminanceEntropy),
    edgeBalance: clamp01(features.edgeBalance),
    openness: opennessTerm(features, r),
  };
  const totalWeight = r.weightColorfulness + r.weightEntropy + r.weightEdgeBalance + r.weightOpenness;
  const score =
    (r.weightColorfulness * terms.colorfulness +
      r.weightEntropy * terms.luminanceEntropy +
      r.weightEdgeBalance * terms.edgeBalance +
      r.weightOpenness * terms.openness) /
    (totalWeight || 1);
  return { score: clamp01(score), terms };
}

/**
 * The novelty of a candidate: the smallest perceptual distance from the
 * candidate to its parent and to every archive member.
 *
 * @param {object} candidate the measured candidate frame
 * @param {object[]} references each `{ id, features }`
 * @param {(a: object, b: object) => number} [distance]
 * @returns {{novelty: number, nearest: object|null, distances: object[]}}
 */
export function noveltyOf(candidate, references, distance = perceptualDistance) {
  const distances = [];
  for (const reference of references) {
    if (!reference || !reference.features) continue;
    distances.push({ id: reference.id, role: reference.role ?? null, distance: clamp01(distance(candidate, reference.features)) });
  }
  if (distances.length === 0) return { novelty: 1, nearest: null, distances };
  const nearest = distances.reduce((best, entry) => (entry.distance < best.distance ? entry : best));
  return { novelty: nearest.distance, nearest, distances };
}

/** The mean of the judge's per-criterion scores, or null when there are none. */
export function meanScore(scores) {
  if (!Array.isArray(scores) || scores.length === 0) return null;
  const values = scores.map((entry) => Number(entry?.score)).filter((value) => Number.isFinite(value));
  if (values.length === 0) return null;
  return clamp01(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * The keep/park decision.
 *
 * A step is parked when a hard test tripped, or the coherence is below its
 * floor, or the novelty is below its floor, or the quality fell by more than the
 * tolerance while the novelty is not strong.
 *
 * @param {object} options
 * @param {string[]} options.tripped        the hard tests that tripped
 * @param {number} options.coherence
 * @param {number} options.novelty
 * @param {number|null} [options.quality]      the judge's mean score, or null
 * @param {number|null} [options.parentQuality] the parent's stored mean score, or null
 * @param {object} [options.rubric]
 * @returns {{verdict: 'kept'|'parked', branch: 'quality'|'novelty'|'both'|'none', reason: string, coherence: number, novelty: number}}
 */
export function decideGate({ tripped = [], coherence, novelty, quality = null, parentQuality = null, rubric = {} }) {
  const r = { ...DEFAULT_RUBRIC, ...rubric };
  const reasons = [];
  const strongNovelty = novelty >= r.strongNovelty;
  const qualityKnown = typeof quality === 'number' && typeof parentQuality === 'number';
  const qualityPass = !qualityKnown || quality >= parentQuality - r.qualityTolerance;

  if (tripped.length > 0) reasons.push(`a hard test tripped: ${tripped.join(', ')}`);
  if (coherence < r.coherenceFloor) reasons.push(`the coherence ${coherence.toFixed(2)} is below the floor ${r.coherenceFloor.toFixed(2)}`);
  if (novelty < r.noveltyFloor) reasons.push(`the novelty ${novelty.toFixed(2)} is below the floor ${r.noveltyFloor.toFixed(2)}`);
  if (!qualityPass && !strongNovelty) {
    reasons.push(`the quality ${quality.toFixed(2)} is below the parent ${parentQuality.toFixed(2)} by more than ${r.qualityTolerance.toFixed(2)}, and the novelty is not strong`);
  }

  let branch;
  if (!qualityKnown) branch = 'novelty';
  else if (qualityPass && strongNovelty) branch = 'both';
  else if (qualityPass) branch = 'quality';
  else branch = 'novelty';
  if (reasons.length > 0) {
    return { verdict: 'parked', branch: 'none', reason: `Parked: ${reasons.join('; ')}.`, coherence, novelty };
  }
  const label = !qualityKnown ? 'novel, judged on metrics only' : branch === 'both' ? 'coherent and novel' : branch === 'novelty' ? 'novel' : 'coherent';
  return { verdict: 'kept', branch, reason: `Kept: the step is ${label} (coherence ${coherence.toFixed(2)}, novelty ${novelty.toFixed(2)}).`, coherence, novelty };
}
