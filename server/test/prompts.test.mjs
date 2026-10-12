// The change axis is the lever that forces a visible evolution. The cycle is
// pure, a stalled palette forces a color step, and a color step never directly
// follows another color step.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CHANGE_CYCLE, STALE_PALETTE_STEPS, buildEvolvePrompt, chooseAppearanceFocus } from '../src/controller/prompts.mjs';

const manifest = {
  allowedEditPaths: ['src/', 'config.json'],
  protectedPaths: ['src/adapter.js'],
  configuration: { schema: 'config.schema.json' },
};

test('the change axis rotates on the fixed cycle', () => {
  const parent = { palette: 'white' };
  assert.deepEqual(CHANGE_CYCLE, ['color', 'structure', 'display', 'texture']);
  assert.equal(chooseAppearanceFocus({ round: 1, parentConfiguration: parent }).axis, 'color');
  assert.equal(chooseAppearanceFocus({ round: 2, parentConfiguration: parent }).axis, 'structure');
  assert.equal(chooseAppearanceFocus({ round: 3, parentConfiguration: parent }).axis, 'display');
  assert.equal(chooseAppearanceFocus({ round: 4, parentConfiguration: parent }).axis, 'texture');
  assert.equal(chooseAppearanceFocus({ round: 5, parentConfiguration: parent }).axis, 'color');
  assert.equal(STALE_PALETTE_STEPS, 2);
});

test('two steps without a palette change force a color step', () => {
  const parent = { palette: 'white' };
  // Two versions share the palette: the run has not changed color for one step.
  const oneStep = chooseAppearanceFocus({ round: 2, parentConfiguration: parent, recentConfigurations: [{ palette: 'white' }, { palette: 'white' }] });
  assert.equal(oneStep.axis, 'structure');
  assert.equal(oneStep.forced, false);
  // Three versions share it: two steps without a change, so the axis is forced.
  const twoSteps = chooseAppearanceFocus({ round: 3, parentConfiguration: parent, recentConfigurations: [{ palette: 'white' }, { palette: 'white' }, { palette: 'white' }] });
  assert.equal(twoSteps.axis, 'color');
  assert.equal(twoSteps.forced, true);
  assert.equal(twoSteps.unchangedRun, 3);
});

test('a color step never directly follows a color step', () => {
  const parent = { palette: 'ember' };
  // Round 5 lands on the color slot, but the last step already changed the
  // palette, so the axis moves on.
  const focus = chooseAppearanceFocus({ round: 5, parentConfiguration: parent, recentConfigurations: [{ palette: 'ember' }, { palette: 'white' }] });
  assert.equal(focus.axis, 'structure');
  assert.equal(focus.forced, false);
});

test('the prompt names the axis, the wide color range, and the measured refusal', () => {
  const parent = { palette: 'ice' };
  const color = buildEvolvePrompt({ instruction: 'BASE', manifest, parentConfiguration: parent, focus: chooseAppearanceFocus({ round: 1, parentConfiguration: parent }) });
  assert.match(color, /COLOR STEP/);
  assert.match(color, /different named palette than the parent/i);
  assert.match(color, /neighboring family/);
  assert.match(color, /MANY hues/);
  assert.match(color, /no full-spectrum rainbow/i);
  assert.match(color, /neon or dayglo/i);
  assert.match(color, /reads as a copy and is refused/);
  assert.match(color, /closed and protected/);

  const display = buildEvolvePrompt({ instruction: 'BASE', manifest, parentConfiguration: parent, focus: chooseAppearanceFocus({ round: 3, parentConfiguration: parent }) });
  assert.match(display, /DISPLAY STEP/);
  assert.match(display, /feedback pass/);
  assert.match(display, /must settle/);
  assert.match(display, /Keep the lineage traceable by eye/);
});
