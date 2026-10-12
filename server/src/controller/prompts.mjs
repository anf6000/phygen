// ─────────────────────────────────────────────────────────────────────────────
// prompts.mjs — what an evolve step receives.
//
// The session gets its own copy of the parent package, the fixed instruction,
// the manifest rules, the parent configuration, and what earlier steps of this
// run already changed. The step count and the budget stay with the controller.
// ─────────────────────────────────────────────────────────────────────────────

export const STEP_INSTRUCTION = [
  'Create a substantial visual evolution of this artwork, not another small variation.',
  'Keep the core physarum simulation as the source of the forms: agents sense the shared trail, steer, move, and deposit into that trail, and trail feedback stays the main cause of what you see.',
  'The display stage above the simulation is yours to change. You may add a feedback pass, a warp, a composite of the trail with its earlier state, or a grain.',
  'A display pass must process the simulation trail. A pass that hides the trail, or that draws forms the simulation did not produce, is not a display pass; it replaces the artwork.',
  'Keep the sensor decision rules, including forward preference and the seeded choice when both side sensors exceed the forward sensor.',
  'If the parent has lost these rules, restore them before changing its visual direction.',
  'Do not replace the simulation with another simulation or a drawn pattern.',
  'Study the parent frame and choose one clear visual direction that changes the overall composition, the color, the collective behavior, or the display stage.',
  'The difference must be visible at a glance, even when the parent and child appear as small images.',
  'Compare structure AND color: connectivity, branching, occupied regions, the balance between dense and sparse paths, and the palette.',
  'Do not alternate between the same ribbons, fans, and orbiting knots with different colors or positions.',
  'A small parameter adjustment or an extra layer of noise is not enough. A real change to the color mapping or to the composition is required.',
  'A palette that never changes across steps is a fault, not restraint. Change the color mapping when the step calls for it.',
  'This step names its change axis below. Obey that axis: a color step must change the palette; a structure, display, or texture step must leave the palette as it is.',
  'Make fewer elements do more. Remove, reduce, or replace inherited effects that compete with the chosen direction.',
  'Adding a mechanism is optional. Removing competing mechanisms can produce the strongest evolution.',
  'Give the image a clear visual hierarchy, contrasting scales, and quiet areas with little detail.',
  'A hierarchy does not require one attractor, one narrow cord, or one compact spawn point.',
  'Use negative space: open areas that make the active forms easier to see.',
  'Avoid uniform detail, dense coverage everywhere, competing centers, and full-spectrum rainbow color.',
  'Do not replace clutter with a nearly empty bundle of parallel paths. Preserve visible branching, connections, and varied spacing.',
  'With zero decay, design for the union of every previous path, not just the current particle positions.',
  'A moving source or attractor leaves its full travel history visible and can fill the intended empty areas.',
  'Use MANY colors, not one color family. Spread a wide range of hues across the image, distributed by trail value, structure, or depth.',
  'Keep the colors natural and muted: no full-spectrum rainbow, no neon or dayglo hues, and no color that is both fully saturated and fully bright at once.',
  'Let lightness do the main work. Use hue as a second axis, so the forms stay readable even in a grayscale view of the frame.',
  'A step that keeps the parent palette when the axis is color is a failed step. Change the ramp and make the difference obvious.',
  'Keep most marks below maximum brightness and saturation. Reserve the brightest colors for a small focal region.',
  'Derive each particle color from a generated map or image, or build a richer ramp in src/renderer.js. Use related colors to support related forms, not random color changes.',
  'Make motion engaging through coherent growth, branching, merging, migration, or changes of direction.',
  'Choose behavior that supports this step; do not combine every example.',
  'Dynamic means clear development over time, not more effects, faster noise, or flicker.',
  'Do not script a journey that stops at step 1000. The artwork must continue to develop during live playback.',
  'Keep the result reproducible, runnable, and visually clear at 1000 simulation steps.',
  'Keep the lineage traceable: a person must follow the chain by eye. Keep the simulation structure visible in the frame, keep the viewport, seed, and step count, and keep at least one recognizable element of the parent in every step.',
  'The configuration schema is closed and protected. Do not add configuration keys; put a new parameter in a source constant.',
].join(' ');

const FRAME_HINT =
  'The attached frames are ordered newest first. The first frame is the parent; later frames show earlier versions. ' +
  'Use these images to assess composition and visual repetition. A still frame does not prove motion quality or frame rate.';

export const EVOLVE_SYSTEM_PROMPT = [
  'You are an artist-engineer responsible for the visual quality of one evolving generative artwork.',
  'You work only inside the workspace directory you are given.',
  'Keep the core physarum simulation as the source of the forms. Trail feedback stays the main cause of what you see.',
  'You may change the display stage above the simulation. A post-process or feedback shader that treats the simulation trail is allowed and encouraged.',
  'three.js and WebGL2 are available. src/renderer.js is editable, and you may add new files under src/.',
  'A display pass must process the trail. A pass that hides the trail, or that draws forms the simulation did not produce, replaces the artwork and is not allowed.',
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
  'Use a WIDE range of colors and empty space deliberately. Value and contrast create hierarchy; adding hues alone does not.',
  'A rich, many-hued image is wanted. A single-hue, duotone, or one-family image is not the goal.',
  'Keep every hue natural and muted. Do not use full-spectrum rainbow color, neon or dayglo hues (magenta, cyan, lime), or a hue that is both fully saturated and fully bright.',
  'You may build a ramp in src/renderer.js instead of only choosing a name from config.json. The schema is closed, so a new ramp is selected in code.',
  'Keep the composition asymmetric unless the step direction asks for symmetry.',
  'Keep hard single-pixel deposits, full opacity, and a palette lookup over trail value, unless the step axis explicitly changes one of them.',
  'Control clutter through particle count, source extent, movement, and path reuse, not fading or hidden deposits.',
  'Opaque pixels can have subdued colors. Opacity does not require maximum RGB values or clipped display gain.',
  'Do not add blur, glow, or mirrored copies as decoration. A stated feedback, warp, or composite with one purpose is different from decoration.',
  'Nothing may flicker on and off from one frame to the next. Do not strobe, flash, or alternate whole-image effects.',
  'The trail deposit stays alpha-over. Above the trail, a display pass may accumulate, warp, or re-map the trail when the step axis calls for it.',
  'One display treatment per step. Remove a competing treatment instead of stacking another.',
  'A display pass must settle: the same seed and step count must give the same image, and the image must not strobe or diverge over 1000 steps.',
  'The chain must stay traceable by eye. Keep the simulation structure visible in the frame, keep the viewport, seed, and step count, and keep at least one recognizable element of the parent in every step.',
  'The configuration schema is closed and protected. Do not add configuration keys; put a new parameter in a source constant.',
  'Keep a 30 fps playback target. Avoid additional whole-image CPU passes and unnecessary work in particle loops.',
  'Do not trade sharpness or particle resolution for speed. Never claim a frame rate without measurement.',
  'Report the visual intent, the main change, and the competing effects removed or reduced.',
  'Distinguish expected visual results from results you actually observed. End with the changed file list.',
].join(' ');

/**
 * The change axes a step can be told to use.
 *
 * A color step must change the palette. A structure, display, or texture step
 * keeps it, so that change can be judged on its own. The cycle visits every axis,
 * and two rules keep color honest: a palette that has not changed for two steps
 * forces a color step, and a color step never directly follows another one.
 */
export const CHANGE_CYCLE = Object.freeze(['color', 'structure', 'display', 'texture']);

/** Two steps without a palette change force the next step to be a color step. */
export const STALE_PALETTE_STEPS = 2;

const FOCUS_TEXT = {
  color: (palette) => ({
    axis: 'color',
    headline: 'THIS STEP IS A COLOR STEP. The ramp must change and must carry many colors.',
    points: [
      `Change the color ramp. Choose a different named palette than the parent${palette ? ` ("${palette}")` : ''}, or rebuild the ramp in src/renderer.js. Do not keep the parent ramp unchanged.`,
      'Use MANY hues, not one color family. Spread a wide range of colors across trail value, structure, or depth, so the frame reads as rich in color rather than duotone.',
      'Keep the hues natural and muted: no full-spectrum rainbow, no neon or dayglo hues, and nothing both fully saturated and fully bright. Let lightness carry the forms, so the image still reads in grayscale.',
      `Keep the colors related to the parent so the lineage stays visible: stay in a neighboring family (white to bone, bone to ember, ember to magma to inferno), or keep the parent value ramp and widen only its hue range${palette ? ` beyond "${palette}"` : ''}.`,
      'Adjust gamma and gain so the ramp reads with contrast: a bright focal region against a subdued ground, not a uniformly bright field.',
      'The color change must be obvious in a small thumbnail, with the composition still legible.',
      'Change the color mapping and its display path only. Do not change the sensor rules or the deposit policy to make the colors look different.',
      'Trace the ramp through the renderer before finishing: confirm that the trail actually uses the new colors.',
    ],
  }),
  structure: (palette) => ({
    axis: 'structure',
    headline: 'THIS STEP IS A STRUCTURE STEP. Keep the palette.',
    points: [
      `Keep the palette of the parent${palette ? ` ("${palette}")` : ''}, so the structural change can be judged on its own.`,
      'Change the collective behavior: branching, merging, migration, confinement, or the balance of dense and open regions.',
      'The structural difference must be visible at a glance without color, in the same palette.',
    ],
  }),
  display: (palette) => ({
    axis: 'display',
    headline: 'THIS STEP IS A DISPLAY STEP. Change the display stage above the simulation.',
    points: [
      `Keep the palette of the parent${palette ? ` ("${palette}")` : ''} and keep the simulation rules.`,
      'Add, replace, or remove ONE display treatment: a feedback pass that mixes the trail with its earlier state, a warp, a composite, or a grain.',
      'Treat the simulation trail. Do not synthesize forms the simulation did not produce. Keep the trail structure visible and legible.',
      'Keep the renderer methods the adapter calls: the constructor, setSize, bindTrailData, present, setPalette, setGain, setGamma, and toDataURL.',
      'A display pass must settle: the same seed and step count must give the same image, and the frame must not strobe or blow out over 1000 steps.',
    ],
  }),
  texture: (palette) => ({
    axis: 'texture',
    headline: 'THIS STEP IS A TEXTURE STEP. Keep the palette and change the scale.',
    points: [
      `Keep the palette of the parent${palette ? ` ("${palette}")` : ''}.`,
      'Change the scale of the marks or the ground: deposit size, sensor distance, particle count class, trail resolution (scale), spawn extent, or gamma and gain contrast.',
      'The texture change must alter how coarse or fine the image reads, not only its brightness.',
    ],
  }),
};

/**
 * Choose the change axis for one step.
 *
 * The cycle rotates the axis by round. When the last two versions already share
 * one palette value, the axis is forced to `color`, so a chain that has stopped
 * changing color is pushed back to it. A color step never directly follows
 * another color step. Pure: the same inputs give the same axis.
 *
 * @param {object} options
 * @param {number} options.round
 * @param {object} options.parentConfiguration
 * @param {object[]} [options.recentConfigurations] the parent first, then older versions
 * @returns {{axis: string, forced: boolean, palette: string|null, unchangedRun: number, headline: string, points: string[]}}
 */
export function chooseAppearanceFocus({ round = 1, parentConfiguration = {}, recentConfigurations = [] } = {}) {
  const palette = parentConfiguration?.palette ?? null;
  let unchangedRun = 0;
  if (palette !== null) {
    for (const configuration of recentConfigurations) {
      if (configuration?.palette === palette) unchangedRun += 1;
      else break;
    }
  }
  const forcedByStaleness = palette !== null && unchangedRun > STALE_PALETTE_STEPS;
  const parent = recentConfigurations[0] ?? null;
  const grandparent = recentConfigurations[1] ?? null;
  const paletteChangedLastStep = Boolean(parent && grandparent && parent.palette !== grandparent.palette);

  let axis = CHANGE_CYCLE[(Math.max(1, round) - 1) % CHANGE_CYCLE.length];
  let forced = false;
  if (forcedByStaleness && axis !== 'color') {
    axis = 'color';
    forced = true;
  } else if (axis === 'color' && paletteChangedLastStep) {
    // Do not change the palette twice in a row; take the next axis instead.
    axis = 'structure';
  }
  return { ...FOCUS_TEXT[axis](palette), forced, palette, unchangedRun };
}

/**
 * @param {object} options
 * @param {string} options.instruction  the fixed step instruction
 * @param {object} options.manifest
 * @param {object} options.parentConfiguration
 * @param {string[]} options.history    one line per earlier step of this run
 * @param {object} [options.focus]      the change axis for this step, from `chooseAppearanceFocus`
 */
export function buildEvolvePrompt({ instruction, manifest, parentConfiguration, history = [], focus = null }) {
  const lines = [];
  lines.push(instruction);
  if (focus) {
    lines.push('');
    lines.push(focus.headline);
    if (focus.forced) lines.push('The palette has not changed for two steps, so this step MUST change it.');
    for (const point of focus.points) lines.push(`- ${point}`);
  }
  lines.push('');
  lines.push('The controller measures the candidate frame against the parent. A frame that keeps the same palette and the same structure reads as a copy and is refused.');
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
  lines.push('- src/renderer.js holds the display. It renders the trail through a palette lookup in one shader. You may extend it with a post-process or feedback pass.');
  lines.push('- You may add new files under src/, such as a shader or a post-process module, and import them from renderer.js.');
  lines.push('- Keep the renderer methods that the adapter calls: the constructor, setSize, bindTrailData, present, setPalette, setGain, setGamma, and toDataURL.');
  lines.push('- config.json holds the parameters that the simulation reads at start. Its schema is closed and protected, so you cannot add a key. Put a new parameter in a source constant.');
  lines.push('- src/adapter.js and manifest.json are protected. The runtime calls them. Do not touch them.');
  lines.push('');
  lines.push('Keep the lineage traceable by eye:');
  lines.push('- Keep the simulation structure visible in the frame. A display pass that hides the trail breaks the chain.');
  lines.push('- Keep the viewport, the seed, and the 1000-step count. They are the common scale of the whole chain.');
  lines.push('- Keep at least one recognizable element of the parent: a shape family, a scale band, or a composition rhythm. Change one stage at a time.');
  lines.push('- A bold change is expected. An arbitrary change that breaks the chain is not.');
  lines.push('');
  lines.push('Choose the visual direction before editing:');
  lines.push('- Compare all attached frames, not only the parent. Identify repeated geometry and the last improvement that actually appears in a capture.');
  lines.push('- Treat earlier reports as intent, not proof. If a report predicts open space but the frame is dense, use the frame.');
  lines.push('- Name one change that is clear at a glance in a small thumbnail, and state which change axis this step uses.');
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
  lines.push('- Do not solve accumulation by hiding the trail, blurring it, or flooding the frame with a wash.');
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
  lines.push('8. If this step changes the display, keep the trail legible and the pass settled: no flicker, no blow-out, and one treatment only.');
  lines.push('   A display pass must process the simulation trail. Do not draw forms the simulation did not produce, and do not add configuration keys.');
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

function fmt(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(3) : String(value);
}

/**
 * One bounded self-critique after the perceptual gate parks a candidate.
 *
 * The session sees its own frame and the parent frame, and a machine report of
 * exactly what failed: the hard tests with their values and floors, the
 * criterion scores, and the novelty with its nearest reference. The gate's
 * numbers are the evidence, so the repair targets the cause instead of guessing.
 */
export function buildSelfCritiquePrompt({ tests = [], scores = [], weaknesses = [], novelty = null, coherence = null, direction = null }) {
  const lines = [];
  lines.push('Your change was rendered and measured, and the perceptual gate refused it.');
  lines.push('This is a visual refusal, not a technical fault: the package loads and renders.');
  lines.push('');
  lines.push('The attached frames are the candidate frame and the parent frame.');
  lines.push('');
  lines.push('What the gate measured:');
  if (typeof coherence === 'number') lines.push(`- coherence ${fmt(coherence)}`);
  if (novelty && typeof novelty.novelty === 'number') {
    const nearest = novelty.nearest?.id ? `, nearest reference ${novelty.nearest.id} at ${fmt(novelty.nearest.distance)}` : '';
    lines.push(`- novelty ${fmt(novelty.novelty)}${nearest}`);
  }
  const tripped = tests.filter((test) => test.tripped);
  if (tripped.length > 0) {
    lines.push('- the hard tests that tripped:');
    for (const test of tripped) lines.push(`  - ${test.name}: value ${JSON.stringify(test.value)} against floor ${JSON.stringify(test.floor)} — ${test.note}`);
  }
  if (scores.length > 0) {
    lines.push('- the criterion scores:');
    for (const score of scores) lines.push(`  - ${score.criterion}: ${fmt(score.score)}`);
  }
  if (weaknesses.length > 0) {
    lines.push('- the judge named these weaknesses:');
    for (const weakness of weaknesses) lines.push(`  - ${weakness}`);
  }
  if (direction) {
    lines.push('');
    lines.push(`The stated direction was: ${direction}`);
  }
  lines.push('');
  lines.push('Repair the workspace in place. Keep the same artistic intent.');
  lines.push('Change exactly what caused the refusal, and leave the rest as it is.');
  lines.push('Do not weaken the simulation to pass a test: keep trail feedback the main cause of the forms.');
  lines.push('Change only the files the manifest allows, and keep the configuration valid.');
  lines.push('If the refusal is not repairable in the workspace, say so and stop.');
  return lines.join('\n');
}
