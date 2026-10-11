// ─────────────────────────────────────────────────────────────────────────────
// gate.mjs — measure a captured frame and reach a keep/park verdict.
//
// The measuring half reads the PNG from disk and decodes it in Node, so the same
// code serves the local capture and the container capture, and the artifact that
// is measured is the artifact a person sees. Decode failures are recorded, not
// turned into zeros.
//
// The deciding half is pure: it runs the hard tests, the coherence score, and
// the novelty distance, then returns the decision table. No store, no clock, no
// random source.
// ─────────────────────────────────────────────────────────────────────────────
import { readFile, stat } from 'node:fs/promises';

import { perceptualDistance } from '../vision/distance.mjs';
import { measureBlockMap, measureFrame } from '../vision/metrics.mjs';
import { PngError, decodePng } from '../vision/png.mjs';
import { coherenceScore, decideGate, noveltyOf } from '../vision/rubric.mjs';
import { runHardTests } from '../vision/tests.mjs';
import { buildArchive } from './archive.mjs';

/** A captured frame is a PNG of about 1 MB; refuse an oversized file early. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/**
 * Decode and measure one PNG file.
 *
 * @param {string} path
 * @param {object} [options] the metric options
 * @returns {Promise<{ok: true, features: object} | {ok: false, code: string, message: string}>}
 */
export async function measurePngFile(path, { maxPixels, ...options } = {}) {
  const frame = await readFrame(path, maxPixels);
  if (!frame.ok) return frame;
  return { ok: true, features: measureFrame(frame.frame, options) };
}

/**
 * Decode one PNG file and measure only the coarse block map.
 *
 * The ordered-frame test reads one field of the early frame, so the early frame
 * does not need the full feature set.
 */
export async function measurePngBlockMap(path, { maxPixels } = {}) {
  const frame = await readFrame(path, maxPixels);
  if (!frame.ok) return frame;
  return { ok: true, features: measureBlockMap(frame.frame) };
}

async function readFrame(path, maxPixels) {
  try {
    const info = await stat(path);
    if (info.size > MAX_FRAME_BYTES) {
      return { ok: false, code: 'frame_too_large', message: `the frame is ${info.size} bytes, above the limit of ${MAX_FRAME_BYTES}` };
    }
    const buffer = await readFile(path);
    return { ok: true, frame: decodePng(buffer, { maxPixels }) };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof PngError ? error.code : error?.code ?? 'measure_failed',
      message: error?.message ?? String(error),
    };
  }
}

/**
 * Build the archive for one artwork, with the options the gate uses.
 *
 * The controller and the API route share this, so the archive the interface
 * shows is the archive the run explores from. A version with no measured
 * features never enters: a judgment with empty features is a recorded skip, not
 * a maximally distant member.
 *
 * @returns {{archive: object, judgments: object[], featuresById: Map, usable: (id: string) => object|null}}
 */
export function gateArchive({ store, config, artworkId, excludeVersionId = null, versions = null }) {
  const judgments = store.listJudgmentsByArtwork(artworkId);
  const featuresById = new Map();
  for (const judgment of judgments) {
    const features = judgment.features;
    if (features && Object.keys(features).length > 0) featuresById.set(judgment.versionId, features);
  }
  const usable = (id) => featuresById.get(id) ?? null;
  const distance = (a, b) => {
    const left = usable(a);
    const right = usable(b);
    return left && right ? perceptualDistance(left, right) : 1;
  };
  const candidates = (versions ?? store.listVersions(artworkId)).filter((version) => version.status === 'promoted' && version.id !== excludeVersionId && usable(version.id));
  const archive = buildArchive({
    versions: candidates,
    judgments,
    distance,
    size: config.gate.archiveSize,
    noveltyFloor: config.gate.noveltyFloor,
    qualityFloor: config.gate.qualityFloor,
  });
  return { archive, judgments, featuresById, usable };
}


/**
 * Reach the verdict for one candidate.
 *
 * @param {object} options
 * @param {object} options.candidate      the measured candidate frame (late)
 * @param {object|null} [options.early]   the measured early frame
 * @param {object[]} [options.references] `{ id, role, features }` for the parent and archive
 * @param {object} [options.floors]
 * @param {object} [options.rubric]
 * @returns {object} the tests, the scores, the novelty, and the decision
 */
export function evaluateCandidate({ candidate, early = null, references = [], floors = {}, rubric = {} }) {
  const hard = runHardTests({ features: candidate, early, floors });
  const coherence = coherenceScore(candidate, rubric);
  const novelty = noveltyOf(candidate, references, perceptualDistance);
  return {
    tests: hard.tests,
    tripped: hard.tripped,
    testsAvailable: hard.available,
    coherence: coherence.score,
    coherenceTerms: coherence.terms,
    novelty: novelty.novelty,
    nearest: novelty.nearest,
    distances: novelty.distances,
  };
}

/** The keep/park decision from an evaluated candidate. */
export function decideFromEvaluation({ evaluation, quality = null, parentQuality = null, rubric = {} }) {
  return decideGate({
    tripped: evaluation.tripped,
    coherence: evaluation.coherence,
    novelty: evaluation.novelty,
    quality,
    parentQuality,
    rubric,
  });
}

/** True when a free metric sits within `margin` of one of its floors. */
export function isBorderline(evaluation, { rubric = {}, margin = 0.08 } = {}) {
  if (evaluation.tripped.length > 0) return true;
  const near = (value, floor) => typeof value === 'number' && typeof floor === 'number' && Math.abs(value - floor) <= margin;
  if (near(evaluation.coherence, rubric.coherenceFloor)) return true;
  if (near(evaluation.novelty, rubric.noveltyFloor)) return true;
  return evaluation.tests.some((test) => {
    if (!test.available) return false;
    if (typeof test.value === 'number' && typeof test.floor === 'number') return Math.abs(test.value - test.floor) <= margin;
    if (test.value && typeof test.value === 'object' && test.floor && typeof test.floor === 'object') {
      return Object.entries(test.value).some(([key, value]) => typeof test.floor[key] === 'number' && Math.abs(value - test.floor[key]) <= margin);
    }
    return false;
  });
}
