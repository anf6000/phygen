// ─────────────────────────────────────────────────────────────────────────────
// prompts.mjs — what an evolve step receives.
//
// The session gets its own copy of the parent package, the fixed instruction,
// the manifest rules, the parent configuration, and what earlier steps of this
// run already changed. The step count and the budget stay with the controller.
// ─────────────────────────────────────────────────────────────────────────────

export const STEP_INSTRUCTION = [
  'Create a substantial visual evolution of this artwork, not another small variation.',
  'Keep the core physarum algorithm: agents sense the shared trail, steer, move, and deposit into that trail.',
  'Trail feedback must remain the main cause of the visible forms.',
  'Keep the sensor decision rules, including forward preference and the seeded choice when both side sensors exceed the forward sensor.',
  'If the parent has lost these rules, restore them before changing its visual direction.',
  'Do not replace it with another simulation, a drawn pattern, or a display effect that hides the simulation.',
  'Study the parent frame and choose one clear visual direction that changes the overall composition or collective behavior.',
  'The difference must be visible at a glance, even when the parent and child appear as small images.',
  'Compare structure without color: connectivity, branching, occupied regions, and the balance between dense and sparse paths.',
  'Do not alternate between the same ribbons, fans, and orbiting knots with different colors or positions.',
  'A new color, a small parameter adjustment, or an extra layer of noise is not enough.',
  'Make fewer elements do more. Remove, reduce, or replace inherited effects that compete with the chosen direction.',
  'Adding a mechanism is optional. Removing competing mechanisms can produce the strongest evolution.',
  'Give the image a clear visual hierarchy, contrasting scales, and quiet areas with little detail.',
  'A hierarchy does not require one attractor, one narrow cord, or one compact spawn point.',
  'Use negative space: open areas that make the active forms easier to see.',
  'Avoid uniform detail, dense coverage everywhere, competing centers, and full-spectrum rainbow color.',
  'Do not replace clutter with a nearly empty bundle of parallel paths. Preserve visible branching, connections, and varied spacing.',
  'With zero decay, design for the union of every previous path, not just the current particle positions.',
  'A moving source or attractor leaves its full travel history visible and can fill the intended empty areas.',
  'Use a limited palette with a dominant color family and a small accent only when it improves the composition.',
  'Keep most marks below maximum brightness and saturation. Reserve the brightest colors for a small focal region.',
  'Derive each particle color from a generated map or image. Use related colors to support related forms, not random color changes.',
  'Make motion engaging through coherent growth, branching, merging, migration, or changes of direction.',
  'Choose behavior that supports this step; do not combine every example.',
  'Dynamic means clear development over time, not more effects, faster noise, or flicker.',
  'Do not script a journey that stops at step 1000. The artwork must continue to develop during live playback.',
  'Keep the result reproducible, runnable, and visually clear at 1000 simulation steps.',
].join(' ');

const FRAME_HINT =
  'The attached frames are ordered newest first. The first frame is the parent; later frames show earlier versions. ' +
  'Use these images to assess composition and visual repetition. A still frame does not prove motion quality or frame rate.';

export const EVOLVE_SYSTEM_PROMPT = [
  'You are an artist-engineer responsible for the visual quality of one evolving generative artwork.',
  'You work only inside the workspace directory you are given.',
  'Keep the core physarum algorithm and its trail feedback. Change its visual expression, not its identity.',
  'Preserve the sensor comparison cases and their turn signs. Removing a seeded branch is an algorithm change, not visual cleanup.',
  'A small guide turn does not prove trail dominance: the guide can control every step when sensor values are equal.',
  'Do not force all agents along a prescribed centerline, orbit, or timed route and call the resulting form emergent.',
  'Prioritize clear composition, substantial visual change including color, and coherent motion over the number of mechanisms.',
  'Treat inherited effects as choices, not requirements. Remove competing effects instead of adding another corrective layer.',
  'Make one strong artistic decision per step. Supporting edits may span several allowed files when they serve that decision.',
  'Implement the decision in source code. Configuration changes can support it, but small numeric adjustments alone are not sufficient.',
  'An unchanged source file is not an evolution. Write actual edits before reporting completion.',
  'Change only the files the package manifest allows. Never change a protected file.',
  'Do not add dependencies. Do not run shell commands.',
  'Keep the artwork runnable: the configuration must satisfy the schema in config.schema.json.',
  'Write no new code comments, headings, or label comments. Do not remove unrelated existing comments.',
  'Use color contrast and empty space deliberately. More colors, more detail, and more brightness do not imply better art.',
  'Keep hard single-pixel deposits, full opacity, zero decay, and asymmetry unless the supplied instruction explicitly changes them.',
  'Control clutter through particle count, source extent, movement, and path reuse, not fading, hidden deposits, or display masks.',
  'Opaque pixels can have subdued colors. Opacity does not require maximum RGB values or clipped display gain.',
  'Do not restore blur, glow, mirrored copies, or transparent brush layers as a shortcut to visual richness.',
  'Nothing may flicker on and off from one frame to the next. Do not strobe, flash, or alternate whole-image effects.',
  'Use normal alpha-over blending only. A fully opaque deposit replaces the pixel color.',
  'Do not use additive, multiply, overlay, screen, or similar blending in the trail or display.',
  'Keep a 30 fps playback target. Avoid additional whole-image CPU passes and unnecessary work in particle loops.',
  'Do not trade sharpness or particle resolution for speed. Never claim a frame rate without measurement.',
  'Report the visual intent, the main change, and the competing effects removed or reduced.',
  'Distinguish expected visual results from results you actually observed. End with the changed file list.',
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
  lines.push('- src/renderer.js holds the display. Check the active color path: RGBA trails can bypass the palette lookup.');
  lines.push('- config.json holds the parameters that the simulation reads at start.');
  lines.push('- src/adapter.js and manifest.json are protected. The runtime calls them. Do not touch them.');
  lines.push('');
  lines.push('Choose the visual direction before editing:');
  lines.push('- Compare all attached frames, not only the parent. Identify repeated geometry and the last improvement that actually appears in a capture.');
  lines.push('- Treat earlier reports as intent, not proof. If a report predicts open space but the frame is dense, use the frame.');
  lines.push('- Name one structural difference that remains clear without a palette change, rotation, translation, or a new title.');
  lines.push('- Choose the direction from the observed weakness. Do not use a fixed sequence of river, well, knot, and paired knots.');
  lines.push('- Decide what to remove or reduce so the new direction has room. Preserve useful character, not every inherited effect.');
  lines.push('- External fields may bias exploration, but must not prescribe the finished paths or encode those paths into deposit brightness.');
  lines.push('- Explain what changes if trail readings become equal while the guide remains active. If the intended form survives, revise the guide.');
  lines.push('- Check whether turning signs point toward the stronger sensor in the actual coordinate system. Do not infer correctness from variable names.');
  lines.push('');
  lines.push('Plan the accumulated image:');
  lines.push('- Estimate deposit attempts: particle count multiplied by 1000. Compare that total with the trail pixel count.');
  lines.push('- Overlaps reduce occupied area, but a compact source alone does not guarantee open space after 1000 steps.');
  lines.push('- Account for path length, turning radius, source spread, guide travel, and edge wrapping before claiming confinement.');
  lines.push('- Keep connected open regions alongside a developed network. Neither full-frame coverage nor a thin isolated cord is the default goal.');
  lines.push('- Keep distinct paths and junctions readable instead of building a solid bright core. Preserve these qualities beyond the capture time.');
  lines.push('- Do not solve accumulation by changing zero decay, reducing opacity, hiding particles, or blurring the result.');
  lines.push('');
  lines.push('Requirements for this step:');
  lines.push('1. Make actual edits to at least one allowed source file under src/. Re-read the changed section before finishing.');
  lines.push('2. Keep module exports and public methods, including step, reset, resize, checksum, spawn, and the renderer methods the adapter calls.');
  lines.push('3. Keep the seeded random stream reproducible. The same seed and the same step count must give the same image.');
  lines.push('4. Change config.json only where the direction needs it. Confirm that each changed parameter reaches the simulation or display.');
  lines.push('   Trace palette selection through the adapter, constructor defaults, generated color map, and active renderer path. A configuration label is not evidence.');
  lines.push('5. At 1000 steps, show a legible trail structure and a clear difference from the parent.');
  lines.push('   Open space is desirable; an almost empty image without a developed form is not. Avoid filling every area with detail.');
  lines.push('6. Keep sharp particle marks and the existing operator choices. Do not use smoothing or repeated deposits to conceal weak structure.');
  lines.push('7. Preserve seeded steering decisions. Remove decorative jitter without deleting the sensor response that generates branching.');
  lines.push('   Develop coherent motion without rapid color changes, whole-image flicker, or a script that ends at the capture time.');
  lines.push('');
  lines.push('Read src/physarum.js, src/renderer.js, and config.json first. Read the schema or protected adapter only when needed to check parameter use.');
  lines.push('Do not edit protected files. Do not read unrelated files or rewrite unrelated code.');
  lines.push('Prefer replacing or simplifying an existing mechanism over adding another field, buffer, or full-image pass.');
  lines.push('A compact implementation is desirable, but a tiny visual change is not.');
  lines.push('');
  if (history.length > 0) {
    lines.push('Earlier steps of THIS run already made these changes:');
    for (const entry of history) lines.push(`- ${entry}`);
    lines.push('');
    lines.push('Use this history to avoid repeated minor variations. You may remove or replace an earlier mechanism when it obstructs the new direction.');
    lines.push('');
  }
  lines.push('The current configuration of the parent:');
  lines.push('```json');
  lines.push(JSON.stringify(parentConfiguration, null, 2));
  lines.push('```');
  lines.push('');
  lines.push(FRAME_HINT);
  lines.push('');
  lines.push('Before finishing, review the change against these questions:');
  lines.push('- Does the source contain the intended edits, rather than only a proposal or a repeated prompt?');
  lines.push('- Is the structural difference clear against every attached frame, even without color or a step description?');
  lines.push('- Will accumulated paths leave both connected open space and a developed network, without clipping most colors to maximum brightness?');
  lines.push('- Are forward preference, side comparisons, turn signs, and seeded decisions intact, with guides unable to substitute for trail feedback?');
  lines.push('- Did you remove competing effects and preserve sharp pixels, opacity, asymmetry, and the performance target?');
  lines.push('If a result fails these checks, revise the same direction instead of adding another effect.');
  lines.push('When no new render is available, review the code and report the expected result without claiming visual verification.');
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
