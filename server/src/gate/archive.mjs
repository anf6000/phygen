// ─────────────────────────────────────────────────────────────────────────────
// archive.mjs — which kept versions deserve to be evolved again.
//
// The chain is a line, but it does not have to follow it forever. This module
// keeps a small ARCHIVE: a set of kept versions that are each coherent enough to
// keep and each different enough from the others to be worth another step. When
// the chain stalls, a step explores from a member instead of the head.
//
// Both numbers come from records that already exist. The quality is the judged
// score of a kept version; a version with no judged score sits at the middle,
// because nothing is known about it yet. The novelty is the distance from a
// version to the members already taken, supplied by the caller.
//
// The module is pure. It reads no store, no clock, and no random source, so the
// same input always gives the same picks and a recorded pick stays explainable.
// It is ported from the `simple` branch, which used comparison records instead
// of judgments.
// ─────────────────────────────────────────────────────────────────────────────
import { meanScore } from '../vision/rubric.mjs';

/** The middle score of a version whose quality is not known. */
const UNKNOWN_QUALITY = 0.5;

/**
 * The quality of one version, from its judgment.
 *
 * A kept version scores its judged mean when a judge ran, and the middle when it
 * did not. A parked version scores zero: the gate refused it.
 *
 * @param {string} versionId
 * @param {object[]} judgments each with `versionId`, `status`, and `scores`
 */
export function qualityOf(versionId, judgments) {
  const judgment = judgments.find((entry) => entry.versionId === versionId);
  if (!judgment) {
    return { votes: 0, wins: 0, losses: 0, abstentions: 0, score: UNKNOWN_QUALITY, confidence: 0, known: false };
  }
  const mean = meanScore(judgment.scores);
  if (judgment.status === 'parked') {
    return { votes: 1, wins: 0, losses: 1, abstentions: 0, score: 0, confidence: 0, known: mean !== null };
  }
  return {
    votes: mean === null ? 0 : 1,
    wins: mean === null ? 0 : 1,
    losses: 0,
    abstentions: 0,
    score: mean === null ? UNKNOWN_QUALITY : mean,
    confidence: 0,
    known: mean !== null,
  };
}

/**
 * The distance from one version to the nearest version in a set.
 * An empty set has no nearest member, and the distance is 1.
 */
export function noveltyOf(versionId, others, distance) {
  let nearest = 1;
  let measured = false;
  for (const other of others) {
    if (other === versionId) continue;
    const value = distance(versionId, other);
    if (typeof value !== 'number' || Number.isNaN(value)) continue;
    nearest = measured ? Math.min(nearest, value) : value;
    measured = true;
  }
  return measured ? nearest : 1;
}

/**
 * Choose the archive: the best-quality version first, then the version furthest
 * from everything taken, again and again. A version is refused when it is closer
 * than `noveltyFloor` to a member, or when its quality is below `qualityFloor`.
 *
 * @param {object} options
 * @param {object[]} options.versions candidates, each `{ id, createdAt, status }`
 * @param {object[]} [options.judgments]
 * @param {(a: string, b: string) => number} options.distance
 * @param {number} [options.size]
 * @param {number} [options.noveltyFloor]
 * @param {number} [options.qualityFloor]
 * @returns {{members: object[], refused: object[]}}
 */
export function buildArchive({ versions, judgments = [], distance, size = 8, noveltyFloor = 0.35, qualityFloor = 0.4 }) {
  const candidates = versions
    .filter((version) => version.status !== 'failed' && version.status !== 'parked')
    .map((version) => ({ version, quality: qualityOf(version.id, judgments) }));

  const members = [];
  const refused = [];
  const taken = new Set();

  const consider = (candidate, reason) => {
    const nearest = members.length === 0 ? 1 : noveltyOf(candidate.version.id, members.map((member) => member.version.id), distance);
    if (candidate.quality.score < qualityFloor) {
      refused.push({ id: candidate.version.id, reason: 'quality', quality: candidate.quality.score, novelty: nearest });
      return false;
    }
    if (members.length >= size) {
      refused.push({ id: candidate.version.id, reason: 'capacity', quality: candidate.quality.score, novelty: nearest });
      return false;
    }
    if (members.length > 0 && nearest < noveltyFloor) {
      refused.push({ id: candidate.version.id, reason: 'near duplicate', quality: candidate.quality.score, novelty: nearest });
      return false;
    }
    members.push({ ...candidate, novelty: nearest, addedBy: reason });
    taken.add(candidate.version.id);
    return true;
  };

  // The best quality first, with a deterministic tie-break so a recorded pick is
  // reproducible: a later version never outranks an earlier one on a tie.
  const byQuality = [...candidates].sort(
    (a, b) => b.quality.score - a.quality.score || String(a.version.createdAt).localeCompare(String(b.version.createdAt)) || a.version.id.localeCompare(b.version.id),
  );
  const best = byQuality[0];
  if (best) consider(best, 'best quality');

  // Then the furthest from the members, until the archive is full or nothing
  // else clears the floors.
  for (let added = members.length; added < size; added++) {
    let pick = null;
    let pickNovelty = -1;
    for (const candidate of candidates) {
      if (taken.has(candidate.version.id)) continue;
      const nearest = noveltyOf(candidate.version.id, members.map((member) => member.version.id), distance);
      if (nearest < noveltyFloor) continue;
      if (candidate.quality.score < qualityFloor) continue;
      if (nearest > pickNovelty + 1e-9 || (Math.abs(nearest - pickNovelty) <= 1e-9 && pick && candidate.version.createdAt < pick.version.createdAt)) {
        pick = candidate;
        pickNovelty = nearest;
      }
    }
    if (!pick) break;
    consider(pick, 'furthest');
  }

  // Every version that is not a member gets a reason, so the report can explain
  // the archive instead of only listing it. A version already refused above is
  // not reported twice.
  const memberIds = new Set(members.map((member) => member.version.id));
  const refusedIds = new Set(refused.map((entry) => entry.id));
  for (const candidate of candidates) {
    if (memberIds.has(candidate.version.id) || refusedIds.has(candidate.version.id)) continue;
    const nearest = noveltyOf(candidate.version.id, members.map((member) => member.version.id), distance);
    const reason = candidate.quality.score < qualityFloor ? 'quality' : nearest < noveltyFloor ? 'near duplicate' : 'capacity';
    refused.push({ id: candidate.version.id, reason, quality: candidate.quality.score, novelty: nearest });
    refusedIds.add(candidate.version.id);
  }

  return { members, refused };
}

// ─────────────────────────────────────────────────────────────────────────────
// The parent pick below is wired when the step loop starts to choose an explore
// parent from a stalled archive. The pure functions and their tests are in place
// now; `buildArchive` above is the part the gate uses today.
// ─────────────────────────────────────────────────────────────────────────────

/** The three kinds of pick, in the order a run uses them. */
export const ROLES = Object.freeze(['exploit', 'explore', 'repair']);

/**
 * Choose the archive member a step starts from.
 *
 * - **exploit** the best quality in the archive: the safe bet.
 * - **explore** the member furthest from the exploit pick: new territory.
 * - **repair** the weakest member that is still worth keeping.
 *
 * @returns {{role: string, versionId: string, kind: string, reason: string}}
 */
export function pickParent({ archive, role = 'exploit', stalled = false, distance }) {
  const members = [...archive.members];
  if (members.length === 0) return null;
  const byQuality = [...members].sort(
    (a, b) => b.quality.score - a.quality.score || String(a.version.createdAt).localeCompare(String(b.version.createdAt)) || a.version.id.localeCompare(b.version.id),
  );
  if (role === 'repair') {
    const weakest = [...members].sort((a, b) => a.quality.score - b.quality.score || a.version.id.localeCompare(b.version.id))[0];
    return { role, versionId: weakest.version.id, kind: 'refinement', reason: `weakest member still worth keeping (${weakest.quality.score.toFixed(2)})` };
  }
  const best = byQuality[0];
  if (role === 'explore' && members.length > 1) {
    const furthest = members
      .filter((member) => member.version.id !== best.version.id)
      .map((member) => ({ member, gap: distance(member.version.id, best.version.id) }))
      .sort((a, b) => b.gap - a.gap || a.member.version.id.localeCompare(b.member.version.id))[0];
    return {
      role,
      versionId: furthest.member.version.id,
      kind: 'experiment',
      reason: stalled ? 'the archive stalled, so this step explores the most distant member' : `furthest from the best version (${furthest.gap.toFixed(2)})`,
    };
  }
  return { role: 'exploit', versionId: best.version.id, kind: 'structure', reason: `best quality in the archive (${best.quality.score.toFixed(2)})` };
}

/** True when the archive has produced nothing new for `levels` levels. */
export function archiveStalled({ unchangedLevels, redirectAfter = 2 }) {
  return unchangedLevels >= Math.max(1, redirectAfter);
}
