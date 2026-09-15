// ─────────────────────────────────────────────────────────────────────────────
// prompts.mjs — what an author session receives.
//
// The author gets its own copy of the artwork package, the direction, and the
// rules of the package. It gets no evaluation prompt, no selection rule, and no
// budget value, because the controller owns those.
// ─────────────────────────────────────────────────────────────────────────────
import { FRAME_HINT } from './plan.mjs';

export const AUTHOR_SYSTEM_PROMPT = [
  'You are an artist-engineer who evolves one generative artwork.',
  'You work only inside the workspace directory you are given.',
  'You write real code. A change that only edits numbers in config.json is not enough on its own.',
  'Change only the files the package manifest allows. Never change a protected file.',
  'Do not add dependencies. Do not run shell commands.',
  'Keep the artwork runnable: the configuration must satisfy the schema in config.schema.json.',
  'When you finish, list the files you changed and write one short paragraph that explains why.',
].join(' ');

/**
 * @param {object} options
 * @param {string} options.direction
 * @param {object} options.plan
 * @param {object} options.manifest
 * @param {object} options.parentConfiguration
 */
export function buildAuthorPrompt({ direction, plan, manifest, parentConfiguration }) {
  const lines = [];
  lines.push(`Evolution direction: ${direction}`);
  lines.push('');
  lines.push(`Your assignment for this candidate: ${plan.title}.`);
  lines.push(plan.instruction);
  if (plan.structuralRedirect) {
    lines.push('');
    lines.push('The last rounds did not change the artwork enough. Direct this candidate toward a different visual structure, not a small deformation of the current one.');
  }
  lines.push('');
  lines.push('The workspace holds one artwork package. Its manifest declares what you may change:');
  lines.push(`- allowed edit paths: ${manifest.allowedEditPaths.join(', ')}`);
  lines.push(`- protected paths: ${manifest.protectedPaths.join(', ')}`);
  lines.push(`- the configuration schema: ${manifest.configuration.schema}`);
  lines.push('');
  lines.push('The artwork source:');
  lines.push('- src/physarum.js holds the simulation: sensing, steering, movement, and the trail.');
  lines.push('- src/renderer.js holds the display: the palette lookup, the gain, and the gamma.');
  lines.push('- config.json holds the parameters that the simulation reads at start.');
  lines.push('- src/adapter.js and manifest.json are protected. The runtime calls them. Do not touch them.');
  lines.push('');
  lines.push('Requirements for this candidate:');
  lines.push('1. Change at least one file under src/. Keep the edit focused and readable.');
  lines.push('2. Keep every public method of your classes: step, reset, resize, checksum, spawn, and the renderer methods that the adapter calls.');
  lines.push('3. Keep the seeded random stream reproducible. The same seed and the same step count must give the same image.');
  lines.push('4. Change config.json when the new code needs different values.');
  lines.push('');
  lines.push('The current configuration of the parent:');
  lines.push('```json');
  lines.push(JSON.stringify(parentConfiguration, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(FRAME_HINT);
  lines.push('');
  lines.push('Work through files. Do not answer with a patch or a description of a patch.');
  lines.push('End your answer with a list of the files you changed.');
  return lines.join('\n');
}

/** One bounded repair attempt after a technical failure. */
export function buildRepairPrompt({ failure }) {
  return [
    'Your change failed a technical check, so the candidate was rejected before judging.',
    `Failure code: ${failure.code}`,
    `Failure text: ${failure.message}`,
    '',
    'Repair the workspace in place. Keep the same artistic intent.',
    'Change only the files the manifest allows, and keep the configuration valid.',
    'If the failure is not repairable in the workspace, say so and stop.',
  ].join('\n');
}
