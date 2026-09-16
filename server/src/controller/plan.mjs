// ─────────────────────────────────────────────────────────────────────────────
// plan.mjs — the plans for one evolution level.
//
// Vocabulary: a VARIANT is one child version that a parent spawns. An EVOLUTION
// is one level: the level creates its variants from the parent, then the winner
// becomes the parent of the next level.
//
// The templates are the same three ideas every level. A level may ask for more
// than three variants, and the ideas then repeat with a number.
// ─────────────────────────────────────────────────────────────────────────────

export const FRAME_HINT =
  'The artwork is a seeded simulation. Evaluation captures early, middle, and late ' +
  'states under a fixed viewport, and judges the images. It never reads your source code.';

export const SLOTS = Object.freeze(['refinement', 'structure', 'experiment']);

const TEMPLATES = {
  refinement: {
    title: 'Focused refinement',
    instruction:
      'Make one small, deliberate change. Prefer a real change in src/physarum.js or src/renderer.js, ' +
      'for example one constant, one branch, or one deposit rule. A parameter-only change is acceptable ' +
      'only when it carries the same intent. Keep the current visual language.',
    touchesSource: true,
  },
  structure: {
    title: 'Structural change',
    instruction:
      'Change how the artwork is built. Edit src/physarum.js or src/renderer.js: the sensing, the steering, ' +
      'the trail, or the palette mapping. Also change the parameters that the new structure needs. ' +
      'The result must stay recognisable as this artwork family.',
    touchesSource: true,
  },
  experiment: {
    title: 'Controlled experiment',
    instruction:
      'Try one idea that the other variants will not try. Write new code for it in src/, and combine it ' +
      'with the configuration the idea needs. The result may fail, and that is acceptable. ' +
      'Do not break the package contract.',
    touchesSource: true,
  },
};

/**
 * @param {object} options
 * @param {number} options.level          the evolution number, from 1
 * @param {string} options.direction
 * @param {number} options.variants       children to spawn at this level
 * @param {number} options.unchangedLevels levels without a change so far
 * @param {number} [options.redirectAfter] levels before the experiment must
 *        change the visual structure
 * @returns {object[]} one plan per variant
 */
export function planRound({ level, direction, variants = 3, unchangedLevels = 0, redirectAfter = 2 }) {
  const count = Math.max(1, Math.min(8, Math.round(variants)));
  const structuralRedirect = unchangedLevels >= redirectAfter;
  const plans = [];

  for (let index = 0; index < count; index++) {
    const slot = SLOTS[index % SLOTS.length];
    const template = TEMPLATES[slot];
    const repeat = Math.floor(index / SLOTS.length);
    const plan = {
      slot,
      variantIndex: index + 1,
      level,
      direction,
      title: repeat === 0 ? template.title : `${template.title} ${index + 1}`,
      instruction: template.instruction,
      touchesSource: template.touchesSource,
      structuralRedirect: structuralRedirect && slot !== 'refinement',
    };
    if (structuralRedirect && slot === 'experiment') {
      plan.instruction +=
        ' The artwork did not change for two evolutions. Change the visual structure, not the numbers: ' +
        'alter the sensing or the steering in src/physarum.js, or change the trail resolution and the palette together.';
    }
    plans.push(plan);
  }

  return plans;
}
