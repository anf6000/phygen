// ─────────────────────────────────────────────────────────────────────────────
// prompts.mjs — what an evolve step receives.
//
// The session gets its own copy of the parent package, the fixed instruction,
// the manifest rules, the parent configuration, and what earlier steps of this
// run already changed. The step count and the budget stay with the controller.
// ─────────────────────────────────────────────────────────────────────────────

export const STEP_INSTRUCTION = [
  'Evolve this artwork one visible step further. Keep the physarum system:',
  'agents that sense a trail, steer, move, and deposit. Never replace it with',
  'another system. Change the simulation, the trail, or the display so that the',
  'result looks clearly different from the parent, and add a new mechanism to the',
  'system when that is what novelty needs. Derive the particle color from a',
  'generated color map or an image, and make the color per particle, not global.',
  'You can add or remove forces that change behavior, like wind, noise, or',
  'attractors, and you can change the stroke weight and the transparency. The',
  'buffer can be cleared or can accumulate. You can modify particle transparency',
  'and behavior from generated textures. Particles can change their appearance',
  'and behavior over time, with no quick changes that lead to strobing or',
  'flickering. Favor bold colors: a strong palette with real contrast beats a',
  'safe or muddy one. Keep it reproducible from the seed, keep the schema valid,',
  'and keep the artwork runnable. Do not repeat a change an earlier step already',
  'made.',
].join(' ');

const FRAME_HINT =
  'The artwork is a seeded simulation. The newest attached frame is the parent; ' +
  'the frames before it show the steps before the parent. Judgement reads only these images.';

export const EVOLVE_SYSTEM_PROMPT = [
  'You are an artist-engineer who evolves one generative artwork.',
  'You work only inside the workspace directory you are given.',
  'You write real code. A change that only edits numbers in config.json is not enough on its own.',
  'Change only the files the package manifest allows. Never change a protected file.',
  'Do not add dependencies. Do not run shell commands.',
  'Keep the artwork runnable: the configuration must satisfy the schema in config.schema.json.',
  'Write no code comments. Do not add a comment to explain a change, and do not add a heading or a label comment.',
  'Favor bold colors. Choose a strong palette with real contrast, and avoid a muddy or washed-out result.',
  'Nothing may flicker on and off from one frame to the next. Do not strobe and do not flash. A person must see an artwork evolve, not flicker.',
  'Use only the normal blending mode. Do not use multiply, add, overlay, screen, or similar blend modes, and do not use them in the display or in how a deposit meets the trail. A deposit blends with the trail like normal alpha-over, and the display writes its result straight out.',
  'When you finish, list the files you changed and write one short paragraph that explains why.',
].join(' ');

/**
 * @param {object} options
 * @param {string} options.instruction  the fixed step instruction
 * @param {object} options.manifest
 * @param {object} options.parentConfiguration
 * @param {string[]} options.history    one line per earlier step of this run
 */
export function buildEvolvePrompt({ instruction, manifest, parentConfiguration, history = [] }) {
  const lines = [];
  lines.push(instruction);
  lines.push('');
  lines.push('The attached frames show the chain, newest first. The first frame is the parent you evolve.');
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
  lines.push('Requirements for this step:');
  lines.push('1. Change at least one file under src/. Keep the edit focused and readable.');
  lines.push('2. Keep every public method of your classes: step, reset, resize, checksum, spawn, and the renderer methods that the adapter calls.');
  lines.push('3. Keep the seeded random stream reproducible. The same seed and the same step count must give the same image.');
  lines.push('4. Change config.json when the new code needs different values.');
  lines.push('5. Keep the network visible. After 1000 steps the frame must still show a trail with real structure, never an almost empty field. A step whose frame is nearly empty is refused.');
  lines.push('6. Write no code comments. Remove any comment you would have added, and do not write a heading or a label comment. Keep a comment that already exists only when the code below it does not say the same thing.');
  lines.push('7. Nothing may flicker on and off from one frame to the next. Do not add a display effect that strobes or flashes between frames. A person must see an artwork evolve, not flicker.');
  lines.push('');
  lines.push('Work efficiently. Read only src/physarum.js, src/renderer.js, and config.json. Do not read the tests or the other package files. Do not write long code: one focused change is enough.');
  lines.push('');
  if (history.length > 0) {
    lines.push('Earlier steps of THIS run already made these changes:');
    for (const entry of history) lines.push(`- ${entry}`);
    lines.push('');
    lines.push('Do not repeat one of those changes. Move the artwork somewhere it has not been.');
    lines.push('');
  }
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

export const REFACTOR_SYSTEM_PROMPT = [
  'You are an artist-engineer who refactors one generative artwork.',
  'You work only inside the workspace directory you are given.',
  'You change the SHAPE of the code, never its behaviour.',
  'The artwork must render the same image from the same seed and step count.',
  'Do not change a number in config.json.',
  'Write no code comments.',
  'Change only the files the package manifest allows. Never change a protected file.',
  'Do not add dependencies. Do not run shell commands.',
].join(' ');

/** One refactor session: same artwork, clearer code, no comments. */
export function buildRefactorPrompt({ manifest, configuration }) {
  const lines = [];
  lines.push('Refactor this artwork. Make the code clearer and smaller without changing what it draws.');
  lines.push('');
  lines.push('Hard rules, in order of importance:');
  lines.push('1. The same seed and the same step count MUST give the same image. Do not touch the seeded random stream, the order in which it is read, or any arithmetic that feeds the trail.');
  lines.push('2. Do not change config.json. Every value stays as it is, including the keys that are already there.');
  lines.push('3. Remove EVERY comment. The file header, the block comments, the line comments, the JSDoc: all of them go. The code must stand alone. Keep no comment at all, not even a short one.');
  lines.push('4. Keep every public method of every class: step, reset, resize, checksum, spawn, and the renderer methods the adapter calls. Keep the file names and the module exports.');
  lines.push('5. Change only the files the manifest allows. The protected paths are: ' + manifest.protectedPaths.join(', ') + '.');
  lines.push('');
  lines.push('What to do:');
  lines.push('- Read src/physarum.js and src/renderer.js fully.');
  lines.push('- Delete every comment.');
  lines.push('- Split a long method into named private methods. Remove dead code, unused variables, and duplicated expressions.');
  lines.push('- Give a value one name and use that name everywhere. Replace a repeated expression with one local.');
  lines.push('- Keep the hot loops tight: this runs a few million steps per frame.');
  lines.push('- Do not rename a public method or a file.');
  lines.push('');
  lines.push('The configuration stays exactly as it is:');
  lines.push('```json');
  lines.push(JSON.stringify(configuration, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('Work through files. Do not answer with a patch or a description of a patch.');
  lines.push('End your answer with the list of files you changed and one sentence per file.');
  return lines.join('\n');
}

/** One bounded repair attempt after a technical failure. */
export function buildRepairPrompt({ failure }) {
  return [
    'Your change failed a technical check, so the candidate was rejected.',
    `Failure code: ${failure.code}`,
    `Failure text: ${failure.message}`,
    '',
    'Repair the workspace in place. Keep the same artistic intent.',
    'Change only the files the manifest allows, and keep the configuration valid.',
    'If the failure is not repairable in the workspace, say so and stop.',
  ].join('\n');
}
