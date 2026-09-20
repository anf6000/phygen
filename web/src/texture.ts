// The pixel field of the loading art: where the pixels sit, and how each one
// moves. Pure functions, so the rule is tested without a browser.
//
// The screen is divided into a grid of 256 x 256 pixels. A particle IS one
// pixel: it fills its cell, it moves in whole pixels only, and it may only turn
// a quarter turn — never backwards, never at an angle. It does not grow.

/** The field is described in the 200 x 200 space of the art. */
export const FIELD = 200;
/** Pixels across the field. 256 across a 1024 px card is a 4 px pixel. */
export const GRID = 256;
/** One pixel, in field units. A particle is exactly this size. */
export const CELL = FIELD / GRID;
export const PARTICLE_COUNT = 4400;
/** The chance that a pixel turns when it arrives on a new pixel. */
export const TURN_CHANCE = 0.35;

export interface Particle {
  /** Pixel coordinates. Always whole numbers inside [0, GRID). */
  x: number;
  y: number;
  /** The heading. Exactly one of these is -1 or 1; the other is 0. */
  dx: number;
  dy: number;
  /** How far the pixel is between its old cell and its new one, from 0 to 1. */
  progress: number;
  /** Pixels per second. Slow on purpose: 1.5 to 3.5. */
  speed: number;
  opacity: number;
  seed: number;
  /** True when this pixel wraps in a given step, for the drawing. */
  wrapped: boolean;
}

/** A stable value in [0, 1) from a seed and an integer. */
export function hash01(seed: number, n: number): number {
  const value = Math.sin(seed * 127.1 + n * 311.7) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * The pixels of the field, placed deterministically on the grid. A pixel starts
 * on any cell, heading one of the four ways, at its own speed and phase, so the
 * field never moves in step.
 */
export function fieldParticles(count: number = PARTICLE_COUNT): Particle[] {
  let state = 987654321;
  const next = () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
  const particles: Particle[] = [];
  for (let index = 0; index < count; index++) {
    const heading = Math.floor(next() * 4);
    particles.push({
      x: Math.floor(next() * GRID),
      y: Math.floor(next() * GRID),
      dx: heading === 0 ? 1 : heading === 2 ? -1 : 0,
      dy: heading === 1 ? 1 : heading === 3 ? -1 : 0,
      progress: next(),
      speed: 1.5 + next() * 2,
      opacity: 0.45 + next() * 0.55,
      seed: 1 + Math.floor(next() * 997),
      wrapped: false,
    });
  }
  return particles;
}

/** A quarter turn. Left is (dx, dy) -> (dy, -dx); right is the other way. */
export function turnHeading(dx: number, dy: number, left: boolean): { dx: number; dy: number } {
  const turned = left ? { dx: dy, dy: -dx } : { dx: -dy, dy: dx };
  // A clean zero: a heading is never a negative zero.
  return { dx: turned.dx === 0 ? 0 : turned.dx, dy: turned.dy === 0 ? 0 : turned.dy };
}

/** True when a heading is a single axis and one cell long. */
export function isAxisHeading(dx: number, dy: number): boolean {
  return Math.abs(dx) + Math.abs(dy) === 1;
}

/**
 * Move one pixel forward by `dtSeconds`, then decide on a turn.
 *
 * A turn is only considered when the pixel arrives on a new cell, it is always a
 * quarter turn, and the decision comes from the cell it arrived on, so the route
 * is the same however the frames fall.
 */
export function advanceParticle(particle: Particle, dtSeconds: number): Particle {
  const next: Particle = { ...particle, wrapped: false };
  next.progress += dtSeconds * particle.speed;

  while (next.progress >= 1) {
    next.progress -= 1;
    // Move one whole cell, and wrap at the edge, as the game does.
    const movedX = next.x + next.dx;
    const movedY = next.y + next.dy;
    next.x = ((movedX % GRID) + GRID) % GRID;
    next.y = ((movedY % GRID) + GRID) % GRID;
    next.wrapped = movedX !== next.x || movedY !== next.y;

    // One decision per arrived cell, and never a reversal.
    const decision = hash01(particle.seed, next.x * 131 + next.y);
    if (decision < TURN_CHANCE) {
      const left = hash01(particle.seed + 7.3, next.x * 131 + next.y) < 0.5;
      const turned = turnHeading(next.dx, next.dy, left);
      next.dx = turned.dx;
      next.dy = turned.dy;
    }
  }

  return next;
}

/**
 * Where a pixel stands, in field units. It sits on a whole pixel: it never
 * stands between pixels, and it is always exactly one pixel wide.
 */
export function pixelPosition(particle: Particle): { x: number; y: number; size: number } {
  return { x: particle.x * CELL, y: particle.y * CELL, size: CELL };
}
