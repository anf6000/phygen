import assert from 'node:assert/strict';
import { test } from 'node:test';

import { Physarum, buildDecayLUT, makeRng } from '../src/physarum.js';

function run(sim, steps) {
  for (let i = 0; i < steps; i++) sim.step();
  return sim;
}

test('a seed makes a run repeatable', () => {
  const a = run(new Physarum({ width: 64, height: 64, num: 300, seed: 1337 }), 40);
  const b = run(new Physarum({ width: 64, height: 64, num: 300, seed: 1337 }), 40);
  assert.deepEqual(Array.from(a.trail), Array.from(b.trail));
  assert.deepEqual(Array.from(a.x), Array.from(b.x));
  assert.deepEqual(Array.from(a.heading), Array.from(b.heading));
  assert.equal(a.checksum(), b.checksum());
  assert.equal(a.iteration, 40);
});

test('a different seed gives a different run', () => {
  const a = run(new Physarum({ width: 64, height: 64, num: 300, seed: 1337 }), 40);
  const b = run(new Physarum({ width: 64, height: 64, num: 300, seed: 1338 }), 40);
  assert.notEqual(a.checksum(), b.checksum());
});

test('reset with the same seed reproduces the first run', () => {
  const sim = new Physarum({ width: 48, height: 48, num: 200, seed: 99 });
  run(sim, 25);
  const first = sim.checksum();
  sim.reset({ seed: 99 });
  assert.equal(sim.iteration, 0);
  assert.equal(sim.trail.every((value) => value === 0), true);
  run(sim, 25);
  assert.equal(sim.checksum(), first);
});

test('reset without a seed keeps the stream and clears the trail', () => {
  const sim = new Physarum({ width: 48, height: 48, num: 200, seed: 7 });
  run(sim, 10);
  assert.equal(sim.trail.some((value) => value > 0), true);
  sim.reset();
  assert.equal(sim.seed, 7);
  assert.equal(sim.iteration, 0);
  assert.equal(sim.trail.some((value) => value > 0), false);
});

test('every mold stays inside a non-square trail', () => {
  const sim = new Physarum({ width: 37, height: 23, num: 500, seed: 3, sensorDist: 40 });
  run(sim, 60);
  for (let i = 0; i < sim.num; i++) {
    assert.ok(sim.x[i] >= 0 && sim.x[i] < sim.W, `x[${i}] = ${sim.x[i]}`);
    assert.ok(sim.y[i] >= 0 && sim.y[i] < sim.H, `y[${i}] = ${sim.y[i]}`);
  }
});

test('the spawn box stays inside a small trail', () => {
  const sim = new Physarum({ width: 20, height: 12, num: 400, seed: 5, spawnRadius: 500 });
  for (let i = 0; i < sim.num; i++) {
    assert.ok(sim.x[i] >= 0 && sim.x[i] <= sim.W, `x[${i}] = ${sim.x[i]}`);
    assert.ok(sim.y[i] >= 0 && sim.y[i] <= sim.H, `y[${i}] = ${sim.y[i]}`);
  }
});

test('resize keeps the overlap, wraps the molds and keeps the seed', () => {
  const sim = new Physarum({ width: 64, height: 48, num: 100, seed: 11, decay: 0 });
  run(sim, 30);
  const before = sim.trail.slice();
  assert.equal(sim.resize(32, 24), true);
  assert.equal(sim.seed, 11);
  assert.equal(sim.W, 32);
  assert.equal(sim.H, 24);
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 32; x++) {
      assert.equal(sim.trail[y * 32 + x], before[y * 64 + x], `pixel ${x},${y}`);
    }
  }
  for (let i = 0; i < sim.num; i++) {
    assert.ok(sim.x[i] >= 0 && sim.x[i] < 32);
    assert.ok(sim.y[i] >= 0 && sim.y[i] < 24);
  }
  assert.equal(sim.resize(32, 24), false);
});

test('decay 255 leaves only full deposits', () => {
  const sim = new Physarum({ width: 32, height: 32, num: 50, seed: 21, decay: 255 });
  sim.step();
  for (const value of sim.trail) assert.ok(value === 0 || value === 255, `unexpected trail value ${value}`);
});

test('decay 0 keeps the trail', () => {
  const sim = new Physarum({ width: 32, height: 32, num: 50, seed: 21, decay: 0 });
  run(sim, 5);
  const first = sim.trail.reduce((sum, value) => sum + value, 0);
  run(sim, 5);
  const later = sim.trail.reduce((sum, value) => sum + value, 0);
  assert.ok(later >= first);
});

test('the decay table matches a direct fade', () => {
  const lut = buildDecayLUT(5);
  assert.equal(lut[0], 0);
  assert.equal(lut[255], Math.round(255 * (250 / 255)));
  for (let i = 0; i < 256; i++) assert.equal(lut[i], Math.round(i * (250 / 255)));
});

test('the seeded rng is repeatable and stays inside zero to one', () => {
  const a = makeRng(42);
  const b = makeRng(42);
  for (let i = 0; i < 500; i++) {
    const value = a();
    assert.equal(value, b());
    assert.ok(value >= 0 && value < 1);
  }
});
