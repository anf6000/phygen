import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { assertAdapter, assertState } from '../../runtime/contract.js';
import createArtwork, { PhysarumAdapter } from '../src/adapter.js';

const SCHEMA = JSON.parse(readFileSync(new URL('../config.schema.json', import.meta.url), 'utf8'));
const BASELINE = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

const VIEWPORT = { width: 256, height: 256, dpr: 1 };

function configuration(overrides = {}) {
  return { ...BASELINE, num: 400, scale: 0.25, ...overrides };
}

function makeView() {
  const calls = { bound: 0, presented: 0, sizes: [], palettes: [], disposed: false };
  return {
    calls,
    setPalette(name) { calls.palettes.push(name); },
    setGain() {},
    setGamma() {},
    bindTrailData() { calls.bound++; },
    present() { calls.presented++; },
    setSize(width, height) { calls.sizes.push([width, height]); },
    toDataURL() { return 'data:image/png;base64,'; },
    dispose() { calls.disposed = true; },
  };
}

async function makeAdapter({ rendererOverrides = {}, initializeOverrides = {}, configOverrides = {} } = {}) {
  const view = makeView();
  const settings = configuration(configOverrides);
  const adapter = await createArtwork();
  await adapter.initialize({
    canvas: null,
    seed: settings.seed,
    viewport: VIEWPORT,
    configuration: settings,
    schema: SCHEMA,
    limits: { maxStepsPerEvaluation: 5000 },
    rendererFactory: () => view,
    ...rendererOverrides,
    ...initializeOverrides,
  });
  return { adapter, view };
}

test('the factory provides every contract method', async () => {
  const artwork = await createArtwork();
  assert.ok(artwork instanceof PhysarumAdapter);
  assert.equal(assertAdapter(artwork), artwork);
});

test('initialize returns a complete state snapshot', async () => {
  const { adapter } = await makeAdapter();
  const state = (() => { const value = adapter.getState(); return assertState(value); })();
  assert.equal(state.artworkId, 'physarum');
  assert.equal(state.seed, BASELINE.seed);
  assert.equal(state.iteration, 0);
  assert.equal(state.agents, 400);
  assert.deepEqual(state.trail, { width: 64, height: 64 });
  assert.deepEqual(state.viewport, VIEWPORT);
  assert.equal(state.resizes, 0);
  assert.equal(state.disposed, false);
  assert.equal(state.stepsPerFrame, BASELINE.speed);
  assert.deepEqual(state.configuration.palette, BASELINE.palette);
  assert.equal(typeof state.trailChecksum, 'number');
  assert.equal(typeof state.agentChecksum, 'number');
});

test('the same seed gives the same state through the contract', async () => {
  const first = await makeAdapter();
  const second = await makeAdapter();
  for (const entry of [first, second]) {
    entry.adapter.step(30);
  }
  const a = first.adapter.getState();
  const b = second.adapter.getState();
  assert.equal(a.iteration, 30);
  assert.equal(a.trailChecksum, b.trailChecksum);
  assert.equal(a.agentChecksum, b.agentChecksum);
});

test('a different seed gives different state', async () => {
  const first = await makeAdapter({ configOverrides: { seed: 1337 } });
  const second = await makeAdapter({ configOverrides: { seed: 1338 } });
  first.adapter.step(30);
  second.adapter.step(30);
  assert.notEqual(first.adapter.getState().trailChecksum, second.adapter.getState().trailChecksum);
});

test('the step budget stops a runaway evaluation and reset restores it', async () => {
  const { adapter } = await makeAdapter({ initializeOverrides: { limits: { maxStepsPerEvaluation: 10 } } });
  adapter.step(10);
  assert.equal(adapter.getState().stepsRemaining, 0);
  assert.throws(() => adapter.step(1), (error) => error.code === 'step_budget_exceeded');
  adapter.reset();
  assert.equal(adapter.getState().stepsRemaining, 10);
});

test('step refuses a count that is not a positive integer', async () => {
  const { adapter } = await makeAdapter();
  assert.throws(() => adapter.step(0), (error) => error.code === 'step_count_invalid');
  assert.throws(() => adapter.step(1.5), (error) => error.code === 'step_count_invalid');
});

test('render draws the current trail', async () => {
  const { adapter, view } = await makeAdapter();
  adapter.step(5);
  adapter.render();
  assert.equal(view.calls.bound, 1);
  assert.equal(view.calls.presented, 1);
});

test('a headless adapter refuses to render', async () => {
  const { adapter } = await makeAdapter({ rendererOverrides: { rendererFactory: null } });
  assert.throws(() => adapter.render(), (error) => error.code === 'no_renderer');
  assert.equal(adapter.getState().renderer.available, false);
});

test('resize changes the trail, counts once, and keeps the seed', async () => {
  const { adapter, view } = await makeAdapter({ configOverrides: { decay: 0 } });
  adapter.step(20);
  const before = adapter.simulation.trail.slice();
  assert.equal(adapter.resize({ width: 512, height: 512, dpr: 1 }), true);
  const state = adapter.getState();
  assert.deepEqual(state.trail, { width: 128, height: 128 });
  assert.deepEqual(state.viewport, { width: 512, height: 512, dpr: 1 });
  assert.equal(state.resizes, 1);
  assert.equal(state.seed, BASELINE.seed);
  assert.deepEqual(view.calls.sizes.at(-1), [512, 512]);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      assert.equal(adapter.simulation.trail[y * 128 + x], before[y * 64 + x]);
    }
  }
  assert.equal(adapter.resize({ width: 512, height: 512, dpr: 1 }), false);
  assert.equal(adapter.getState().resizes, 1);
});

test('resize refuses a viewport outside the bounds', async () => {
  const { adapter } = await makeAdapter();
  assert.throws(() => adapter.resize({ width: 10, height: 10, dpr: 1 }), (error) => error.code === 'viewport_invalid');
  assert.throws(() => adapter.resize({ width: 256, height: 256, dpr: 99 }), (error) => error.code === 'viewport_invalid');
});

test('reset clears the state and keeps the adapter usable', async () => {
  const { adapter } = await makeAdapter();
  adapter.step(40);
  const state = adapter.reset({ seed: 2024 });
  assert.equal(state.iteration, 0);
  assert.equal(state.seed, 2024);
  assert.equal(state.trailChecksum, adapter.getState().trailChecksum);
});

test('an invalid seed is refused, and seed zero is accepted', async () => {
  const { adapter } = await makeAdapter({ configOverrides: { seed: 0 } });
  assert.equal(adapter.getState().seed, 0);
  assert.throws(() => adapter.reset({ seed: -1 }), (error) => error.code === 'seed_out_of_range');
  assert.throws(() => adapter.reset({ seed: 1.5 }), (error) => error.code === 'seed_out_of_range');
  assert.throws(() => adapter.reset({ seed: 2 ** 32 }), (error) => error.code === 'seed_out_of_range');
});

test('the schema rejects a configuration the artwork cannot run', async () => {
  await assert.rejects(
    makeAdapter({ configOverrides: { num: 900000 } }),
    (error) => error.code === 'configuration_invalid',
  );
});

test('an incomplete configuration fails even without a schema', async () => {
  const adapter = await createArtwork();
  const incomplete = configuration();
  delete incomplete.num;
  await assert.rejects(
    adapter.initialize({ seed: 1, viewport: VIEWPORT, configuration: incomplete, rendererFactory: null }),
    (error) => error.code === 'configuration_incomplete',
  );
  await assert.rejects(
    adapter.initialize({ seed: 1, viewport: VIEWPORT, configuration: { ...configuration(), palette: 7 }, rendererFactory: null }),
    (error) => error.code === 'configuration_incomplete',
  );
});

test('the agent limit and the trail limit are enforced', async () => {
  await assert.rejects(
    makeAdapter({ initializeOverrides: { limits: { maxAgents: 100 } } }),
    (error) => error.code === 'agents_exceed_limit',
  );
  await assert.rejects(
    makeAdapter({
      configOverrides: { scale: 1 },
      initializeOverrides: { limits: { maxTrailPixels: 4096 } },
    }),
    (error) => error.code === 'trail_exceeds_limit',
  );
});

test('a display that cannot start fails the candidate and frees the adapter', async () => {
  const adapter = await createArtwork();
  await assert.rejects(
    adapter.initialize({
      canvas: null,
      seed: 1,
      viewport: VIEWPORT,
      configuration: configuration(),
      schema: SCHEMA,
      rendererFactory: () => { throw new Error('no WebGL context'); },
    }),
    /no WebGL context/,
  );
  assert.equal(adapter.getState().disposed, true);
  const { adapter: retried } = await makeAdapter();
  assert.equal(retried.getState().disposed, false);
});

test('the lifecycle refuses calls in the wrong order', async () => {
  const fresh = await createArtwork();
  assert.throws(() => fresh.step(1), (error) => error.code === 'not_initialized');
  assert.throws(() => fresh.render(), (error) => error.code === 'not_initialized');
  assert.throws(() => fresh.reset(), (error) => error.code === 'not_initialized');
  assert.equal(fresh.getState().disposed, true);

  const { adapter } = await makeAdapter();
  await assert.rejects(
    adapter.initialize({ seed: 1, viewport: VIEWPORT, configuration: configuration(), schema: SCHEMA }),
    (error) => error.code === 'already_initialized',
  );
});

test('dispose frees the display and stops the adapter', async () => {
  const { adapter, view } = await makeAdapter();
  assert.equal(adapter.dispose(), true);
  assert.equal(view.calls.disposed, true);
  assert.equal(adapter.getState().disposed, true);
  assert.throws(() => adapter.step(1), (error) => error.code === 'not_initialized');
  assert.equal(adapter.dispose(), true);
});

test('a display palette change never changes the recorded configuration', async () => {
  const { adapter, view } = await makeAdapter();
  adapter.setDisplayPalette('ice');
  assert.deepEqual(view.calls.palettes, ['ice']);
  assert.equal(adapter.getState().configuration.palette, BASELINE.palette);
});
