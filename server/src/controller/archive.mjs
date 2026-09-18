// ─────────────────────────────────────────────────────────────────────────────
// archive.mjs — which versions deserve to be evolved next.
//
// A run no longer follows one line. It keeps an ARCHIVE: a small set of versions
// that are each good enough to keep and each different enough from the others to
// be worth another generation. Every level picks its parents from that archive.
//
// Two numbers decide membership, and both come from records that already exist:
//
//   quality   the win and loss tally of a version across every comparison it
//             took part in. A version that never competed sits at the middle,
//             because nothing is known about it yet.
//   novelty   the distance from a version to the members already in the archive,
//             measured by the caller. A version that is a near-copy of a member
//             adds nothing and is refused.
//
// The module is pure. It reads no store, no clock and no random source, so the
// same input always gives the same picks. That is what makes the policy testable
// and what lets a recorded pick be explained afterwards.
// ─────────────────────────────────────────────────────────────────────────────

/** The middle score of a version that has not competed yet. */
const UNKNOWN_QUALITY = 0.5;

/**
 * The win and loss tally of one version across the comparisons it appears in.
 *
 * A comparison that named no preference is not a vote: the judge abstained, and
 * an abstention must not read as a loss.
 *
 * @param {string} versionId
 * @param {object[]} comparisons records with `labels`, `winnerVersionId` and `verdict`
 */
export function qualityOf(versionId, comparisons) {
  let wins = 0;
  let losses = 0;
  let abstentions = 0;
  let confidenceSum = 0;
  for (const comparison of comparisons) {
    const labels = comparison.labels ?? {};
    if (!Object.prototype.hasOwnProperty.call(labels, versionId)) continue;
    const preference = comparison.verdict?.preference ?? 'none';
    if (preference === 'none' || !comparison.winnerVersionId) {
      abstentions += 1;
      continue;
    }
    if (comparison.winnerVersionId === versionId) {
      wins += 1;
      confidenceSum += typeof comparison.confidence === 'number' ? comparison.confidence : 0;
    } else {
      losses += 1;
    }
  }
  const votes = wins + losses;
  return {
    votes,
    wins,
    losses,
    abstentions,
    // A rate alone lets one lucky win outrank a proven version, so the tally is
    // smoothed: no votes sits at the middle, and one win of one does not.
    score: (wins + 1) / (votes + 2),
    // The mean confidence of the comparisons this version WON. It only breaks
    // ties, because a confidence is a property of one comparison, not of a
    // version.
    confidence: wins === 0 ? 0 : confidenceSum / wins,
  };
}

/**
 * The distance from one version to the nearest version in a set.
 * `distance(a, b)` is supplied by the caller, so the archive does not care which
 * measures exist. An empty set has no nearest member, and the distance is 1.
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
 * Choose the archive.
 *
 * The best-quality version is taken first, then the version furthest from
 * everything taken so far, again and again: the classic greedy spread. A version
 * is refused when it is closer than `noveltyFloor` to a member, because it adds
 * no new territory, and when its quality is below `qualityFloor`, because a
 * version the judge keeps rejecting should not be evolved from.
 *
 * @param {object} options
 * @param {object[]} options.versions candidates, each `{ id, createdAt, status }`
 * @param {object[]} options.comparisons every comparison of the artwork
 * @param {(a: string, b: string) => number} options.distance
 * @param {number} [options.size] the greatest number of members
 * @param {number} [options.noveltyFloor]
 * @param {number} [options.qualityFloor]
 * @returns {{members: object[], refused: object[]}}
 */
export function buildArchive({
  versions,
  comparisons = [],
  distance,
  size = 8,
  noveltyFloor = 0.35,
  qualityFloor = 0.4,
}) {
  const candidates = versions
    .filter((version) => version.status !== 'failed')
    .map((version) => ({ version, quality: qualityOf(version.id, comparisons) }));

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
    (a, b) => b.quality.score - a.quality.score || a.version.createdAt.localeCompare(b.version.createdAt) || a.version.id.localeCompare(b.version.id),
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
  // the archive instead of only listing it. A complete archive refuses a good
  // version for capacity, not for a fault of its own.
  const memberIds = new Set(members.map((member) => member.version.id));
  for (const candidate of candidates) {
    if (memberIds.has(candidate.version.id)) continue;
    const nearest = noveltyOf(candidate.version.id, members.map((member) => member.version.id), distance);
    const reason = candidate.quality.score < qualityFloor ? 'quality' : nearest < noveltyFloor ? 'near duplicate' : 'capacity';
    refused.push({ id: candidate.version.id, reason, quality: candidate.quality.score, novelty: nearest });
  }

  return { members, refused };
}

/** The three kinds of pick, in the order a level uses them. */
export const ROLES = Object.freeze(['exploit', 'explore', 'repair']);

/**
 * Choose the parents for one level.
 *
 * - **exploit** the best quality in the archive: the safe bet.
 * - **explore** the member furthest from the exploit pick: new territory.
 * - **repair** the weakest member that is still worth keeping: fix what is
 *   almost good instead of abandoning it.
 *
 * A level may ask for more variants than the archive has members, or than the
 * three roles. The roles then repeat in order, and a repeated role takes the
 * next member of its own ranking, so nothing is picked twice.
 *
 * @returns {{role: string, versionId: string, kind: string, reason: string}[]}
 */
export function pickParents({ archive, variants = 3, stalled = false, distance }) {
  const members = [...archive.members];
  if (members.length === 0) return [];
  const count = Math.max(1, Math.min(8, Math.round(variants)));

  // One ranking per role, best first, with deterministic tie-breaks.
  const byQuality = [...members].sort(
    (a, b) => b.quality.score - a.quality.score || a.version.createdAt.localeCompare(b.version.createdAt) || a.version.id.localeCompare(b.version.id),
  );
  const weakest = [...members].sort(
    (a, b) => a.quality.score - b.quality.score || a.version.createdAt.localeCompare(b.version.createdAt) || a.version.id.localeCompare(b.version.id),
  );

  const picks = [];
  const counts = new Map();
  /**
   * The next member of one role's preference order. The first use of a role takes
   * the first member that no other role picked yet, so a level works on as many
   * versions as it has variants. When the order is exhausted a member repeats,
   * which is allowed: two variants of one parent still differ from each other.
   */
  const next = (role, order) => {
    const at = counts.get(role) ?? 0;
    counts.set(role, at + 1);
    const taken = new Set(picks.map((pick) => pick.versionId));
    const fresh = order.filter((member) => !taken.has(member.version.id));
    if (fresh.length > at) return fresh[at];
    return order[Math.min(at, order.length - 1)] ?? null;
  };

  // The furthest member from the exploit pick is the explore target.
  const exploitFirst = byQuality[0];
  const exploreOrder = [...members]
    .filter((member) => member.version.id !== exploitFirst.version.id)
    .map((member) => ({ member, gap: distance(member.version.id, exploitFirst.version.id) }))
    .sort((a, b) => b.gap - a.gap || a.member.version.createdAt.localeCompare(b.member.version.createdAt));

  for (let index = 0; index < count; index++) {
    const role = ROLES[index % ROLES.length];
    if (role === 'exploit') {
      const member = next('exploit', byQuality);
      if (!member) continue;
      picks.push({
        role,
        versionId: member.version.id,
        kind: index === 0 ? 'refinement' : 'structure',
        reason: `best quality in the archive (${member.quality.score.toFixed(2)} from ${member.quality.votes} vote(s))`,
      });
      continue;
    }
    if (role === 'explore') {
      const member = next('explore', exploreOrder.map((entry) => entry.member));
      if (!member) continue;
      const gap = distance(member.version.id, exploitFirst.version.id);
      picks.push({
        role,
        versionId: member.version.id,
        kind: 'experiment',
        reason: stalled
          ? 'the archive stalled, so this level explores the most distant member'
          : `furthest from the best version (${gap.toFixed(2)})`,
      });
      continue;
    }
    const member = next('repair', weakest);
    if (!member) continue;
    picks.push({
      role,
      versionId: member.version.id,
      kind: 'refinement',
      reason: `weakest member still worth keeping (${member.quality.score.toFixed(2)})`,
    });
  }

  return picks;
}

/** True when the archive has produced nothing new for `levels` levels. */
export function archiveStalled({ unchangedLevels, redirectAfter = 2 }) {
  return unchangedLevels >= Math.max(1, redirectAfter);
}
