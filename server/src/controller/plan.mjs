// ─────────────────────────────────────────────────────────────────────────────
// plan.mjs — the three candidate slots of one round.
//
// The plan fixes the slots: a focused refinement, a structural change, and a
// controlled experiment. The controller never increases the candidate count.
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
      'Try one idea that the other candidates will not try. Write new code for it in src/, and combine it ' +
      'with the configuration the idea needs. The result may fail, and that is acceptable. ' +
      'Do not break the package contract.',
    touchesSource: true,
  },
};

/**
 * @param {object} options
 * @param {number} options.round
 * @param {string} options.direction
 * @param {number} options.unchangedRounds
 * @param {number} [options.redirectAfter] rounds without a change before the
 *        experiment must change the visual structure
 * @param {number} [options.candidatesPerRound]
 * @returns {object[]} one plan per candidate slot
 */
export function planRound({ round, direction, unchangedRounds, redirectAfter = 2, candidatesPerRound = 3 }) {
  const structuralRedirect = unchangedRounds >= redirectAfter;
  const slots = SLOTS.slice(0, Math.max(1, Math.min(candidatesPerRound, SLOTS.length)));
  return slots.map((slot) => {
    const template = TEMPLATES[slot];
    const plan = {
      slot,
      round,
      direction,
      title: template.title,
      instruction: template.instruction,
      touchesSource: template.touchesSource,
      structuralRedirect: structuralRedirect && slot !== 'refinement',
    };
    if (structuralRedirect && slot === 'experiment') {
      plan.instruction +=
        ' The artwork did not change for two rounds. Change the visual structure, not the numbers: ' +
        'alter the sensing or the steering in src/physarum.js, or change the trail resolution and the palette together.';
    }
    return plan;
  });
}
