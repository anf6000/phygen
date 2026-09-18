// ─────────────────────────────────────────────────────────────────────────────
// direction.mjs — the instruction a run writes for itself.
//
// A person may write the direction, and usually will. When they do not, the run
// has to say what it wants from the next level, and it must say it from evidence
// rather than from a mood. Three sources exist in the records already:
//
//   weaknesses    what the judge said was wrong with the parent
//   axes          the configuration fields the archive has moved least
//   a stall       levels passed without a promotion, so a refinement will not do
//
// This module is text assembly. It calls no model, costs nothing, and returns the
// evidence with the text, so a direction can always be traced to the record that
// produced it.
// ─────────────────────────────────────────────────────────────────────────────
import { flattenConfiguration } from '../analysis/relationships.mjs';

/**
 * The configuration fields the archive has moved least.
 *
 * A field every member shares is an unexplored axis: changing it is the cheapest
 * way to reach territory the archive does not cover. Fields are ordered by
 * distinct-value count, then by name, so the answer is stable.
 *
 * @param {object[]} versions the archive members
 * @param {number} [limit]
 * @returns {{ field: string, values: string[], distinct: number }[]}
 */
export function unexploredAxes(versions, limit = 4) {
  const perField = new Map();
  for (const version of versions) {
    const leaves = flattenConfiguration(version.configuration);
    for (const [field, value] of leaves) {
      const seen = perField.get(field) ?? new Set();
      seen.add(value);
      perField.set(field, seen);
    }
  }
  return [...perField.entries()]
    .map(([field, values]) => ({ field, values: [...values].sort(), distinct: values.size }))
    .sort((a, b) => a.distinct - b.distinct || a.field.localeCompare(b.field))
    .slice(0, limit);
}

/** The weaknesses the judge recorded about the versions of a lineage, newest first. */
export function recordedWeaknesses(comparisons, versionIds, limit = 3) {
  const wanted = new Set(versionIds);
  const found = [];
  for (const comparison of [...comparisons].reverse()) {
    const labels = comparison.labels ?? {};
    if (!Object.keys(labels).some((id) => wanted.has(id))) continue;
    for (const weakness of comparison.verdict?.weaknesses ?? []) {
      const text = String(weakness).trim();
      if (text.length > 0 && !found.includes(text)) found.push(text);
      if (found.length >= limit) return found;
    }
  }
  return found;
}

/**
 * Write the instruction for one level.
 *
 * @param {object} options
 * @param {string} options.role        exploit, explore, repair, or seed
 * @param {string} options.kind        refinement, structure, or experiment
 * @param {object} options.parent      the version the level starts from
 * @param {string[]} [options.weaknesses] what the judge said was wrong
 * @param {object[]} [options.axes]    the least-moved configuration fields
 * @param {boolean} [options.stalled]  levels passed with no promotion
 * @returns {{text: string, source: string, evidence: object}}
 */
export function writeDirection({ role, kind = 'refinement', parent, weaknesses = [], axes = [], stalled = false }) {
  const title = parent?.title ? `the current version (${parent.title})` : 'the current version';
  const axisNames = axes.slice(0, 3).map((axis) => axis.field);
  const axisLine = axisNames.length > 0 ? `The archive has moved ${axisNames.join(', ')} least, so those are the axes with room left.` : '';

  if (stalled || kind === 'experiment') {
    const text = [
      `Explore rather than refine: change how ${title} is built, not the numbers it is built with.`,
      'Alter the sensing or the steering, or change the trail representation together with the palette.',
      stallLine(stalled),
      axisLine,
      'The result may fail. Keep the package contract.',
    ]
      .filter(Boolean)
      .join(' ');
    return { text, source: stalled ? 'stall' : 'explore role', evidence: { role, kind, stalled, axes: axisNames } };
  }

  if (role === 'repair' && weaknesses.length > 0) {
    const text = [
      `Repair what the comparison already found: ${weaknesses.map((item) => `"${item}"`).join('; ')}.`,
      `Change the part of ${title} that causes that, and leave everything else as it is.`,
      axisLine,
    ]
      .filter(Boolean)
      .join(' ');
    return { text, source: 'judge weakness', evidence: { role, kind, weaknesses, axes: axisNames } };
  }

  const text = [
    kind === 'structure'
      ? `Change how ${title} is built: the sensing, the steering, the trail, or the palette mapping.`
      : `Make one small, deliberate change to ${title}: a rule, a branch, or a constant.`,
    'Keep the current visual language, so the level can be compared with its parent.',
    axisLine,
  ]
    .filter(Boolean)
    .join(' ');
  return { text, source: role === 'repair' ? 'repair without a recorded weakness' : 'the level kind', evidence: { role, kind, axes: axisNames } };
}

function stallLine(stalled) {
  return stalled ? 'The archive has not gained a member for two levels, so a refinement will not do.' : '';
}
