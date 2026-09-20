// The pixel field: a 256 x 256 screen, whole-pixel movement, quarter turns only,
// and a pixel that never grows.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  CELL,
  FIELD,
  GRID,
  PARTICLE_COUNT,
  TURN_CHANCE,
  advanceParticle,
  fieldParticles,
  isAxisHeading,
  pixelPosition,
  turnHeading,
} from '../src/texture.ts';

const PARTICLES = fieldParticles(40);

test('the screen is a grid of 256 x 256 pixels', () => {
  assert.equal(GRID, 256);
  assert.equal(CELL, FIELD / GRID);
  // 256 pixels across a 1024 px card is a 4 px pixel.
  assert.equal(CELL * (1024 / FIELD), 4);
  assert.equal(fieldParticles().length, PARTICLE_COUNT);
});

test('a particle IS one pixel: whole coordinates, and one pixel wide', () => {
  for (const particle of PARTICLES) {
    assert.equal(Number.isInteger(particle.x), true, `x is not a whole pixel: ${particle.x}`);
    assert.equal(Number.isInteger(particle.y), true, `y is not a whole pixel: ${particle.y}`);
    assert.ok(particle.x >= 0 && particle.x < GRID);
    assert.ok(particle.y >= 0 && particle.y < GRID);
    assert.equal(isAxisHeading(particle.dx, particle.dy), true, `heading is not an axis: ${particle.dx},${particle.dy}`);
    assert.ok(particle.speed >= 1.5 && particle.speed <= 3.5, 'a pixel moves slowly');
    assert.ok(particle.progress >= 0 && particle.progress < 1);
    assert.deepEqual(pixelPosition(particle), { x: particle.x * CELL, y: particle.y * CELL, size: CELL });
  }
});

test('a pixel only stands on a whole pixel, however long it moves', () => {
  let particles = fieldParticles(12);
  for (let frame = 0; frame < 3000; frame++) {
    particles = particles.map((particle) => advanceParticle(particle, 1 / 60));
    for (const particle of particles) {
      const pixel = pixelPosition(particle);
      // A whole number of pixels from the corner of the field.
      assert.equal(Number.isInteger(pixel.x / CELL), true, `x stands between pixels: ${pixel.x}`);
      assert.equal(Number.isInteger(pixel.y / CELL), true, `y stands between pixels: ${pixel.y}`);
      // It is one pixel: it never grows, and it leaves no trail.
      assert.equal(pixel.size, CELL);
    }
  }
});

test('a quarter turn is 90 degrees, and never a reversal', () => {
  assert.deepEqual(turnHeading(1, 0, false), { dx: 0, dy: 1 });
  assert.deepEqual(turnHeading(0, 1, false), { dx: -1, dy: 0 });
  assert.deepEqual(turnHeading(-1, 0, false), { dx: 0, dy: -1 });
  assert.deepEqual(turnHeading(0, -1, false), { dx: 1, dy: 0 });
  assert.deepEqual(turnHeading(1, 0, true), { dx: 0, dy: -1 });
  assert.deepEqual(turnHeading(0, 1, true), { dx: 1, dy: 0 });
  for (const [dx, dy] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ]) {
    for (const left of [true, false]) {
      const turned = turnHeading(dx, dy, left);
      assert.equal(turned.dx === -dx && turned.dy === -dy, false, 'a pixel must not reverse');
      assert.equal(isAxisHeading(turned.dx, turned.dy), true);
    }
  }
});

test('a pixel does turn: the field bends, it does not march straight', () => {
  // This is the check the first version of this test was missing.
  let particles = fieldParticles(20);
  const turns = new Array(particles.length).fill(0);
  for (let frame = 0; frame < 3600; frame++) {
    const before = particles.map((particle) => [particle.dx, particle.dy]);
    particles = particles.map((particle) => advanceParticle(particle, 1 / 60));
    particles.forEach((particle, index) => {
      if (particle.dx !== before[index][0] || particle.dy !== before[index][1]) turns[index]++;
    });
  }
  const mean = turns.reduce((sum, count) => sum + count, 0) / turns.length;
  // One minute of motion. Every pixel bends many times, and often enough that a
  // person watching for a few seconds sees a turn.
  assert.ok(mean >= 8, `the field barely turns: ${mean.toFixed(2)} turns per minute`);
  // A turn must be visible within a few seconds of watching.
  assert.ok(mean / 60 > 0.12, `turns are too rare to see: ${(mean / 60).toFixed(3)} per second`);
  assert.ok(TURN_CHANCE >= 0.3, 'the turn chance must make turns visible');
  assert.ok(turns.every((count) => count > 0), 'every pixel must turn at some point');
});

test('a pixel stays on the screen and wraps at the edge', () => {
  let particles = fieldParticles(6);
  for (let frame = 0; frame < 4000; frame++) {
    particles = particles.map((particle) => advanceParticle(particle, 1 / 60));
    for (const particle of particles) {
      assert.ok(particle.x >= 0 && particle.x < GRID, `x left the screen: ${particle.x}`);
      assert.ok(particle.y >= 0 && particle.y < GRID, `y left the screen: ${particle.y}`);
      assert.equal(isAxisHeading(particle.dx, particle.dy), true);
    }
  }
  const walking = { ...fieldParticles(1)[0], x: GRID - 1, y: 0, dx: 1, dy: 0, progress: 0, speed: 1 };
  const arrived = advanceParticle(walking, 1);
  assert.equal(arrived.x, 0, 'a pixel wraps around the screen');
  assert.equal(arrived.wrapped, true);
});

test('the route is the same however the frames fall', () => {
  const start = fieldParticles(5);
  const longWay = start.map((particle) => advanceParticle(particle, 1));
  let shortWay = start.map((particle) => ({ ...particle }));
  for (let step = 0; step < 10; step++) shortWay = shortWay.map((particle) => advanceParticle(particle, 0.1));
  assert.deepEqual(
    shortWay.map((particle) => [particle.x, particle.y, particle.dx, particle.dy]),
    longWay.map((particle) => [particle.x, particle.y, particle.dx, particle.dy]),
  );
});

test('the pixels are out of step with each other', () => {
  const particles = fieldParticles(30);
  const headings = new Set(particles.map((particle) => `${particle.dx},${particle.dy}`));
  const speeds = new Set(particles.map((particle) => particle.speed.toFixed(3)));
  assert.ok(headings.size >= 3, 'the field must not march one way');
  assert.ok(speeds.size >= 20, 'the pixels must not share one speed');
});
