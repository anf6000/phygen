import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SETTLE_SHARE, hasSettle, injectSettle } from '../src/artwork/calm.mjs';

const ARTWORK = `export class Artwork {
  constructor() {
    this.trail = new Uint8Array(4);
    this.iteration = 0;
  }

  step() {
    this.trail[0] = 200;
    this.iteration++;
  }

  checksum() {
    return 1;
  }
}
`;

test('the settle is inserted at the end of the step pipeline', () => {
  const result = injectSettle(ARTWORK);
  assert.equal(result.injected, true, result.reason);
  assert.equal(hasSettle(result.source), true);
  // It sits before the step count grows, inside the step method.
  const settleAt = result.source.indexOf('settlePrev');
  const stepAt = result.source.indexOf('step() {');
  const iterationAt = result.source.indexOf('this.iteration++');
  assert.ok(stepAt < settleAt && settleAt < iterationAt, 'the settle must sit at the end of the step');
  // The memory starts empty on the first step of a run, so a reset reproduces.
  assert.match(result.source, /this\.iteration === 0 \|\| !settlePrev/);
  // The share is the configured one.
  assert.ok(result.source.includes(`* ${SETTLE_SHARE}`));
  // The rest of the class is untouched.
  assert.match(result.source, /checksum\(\) \{/);
});

test('the settle is added once, and only when the step pipeline is there', () => {
  const once = injectSettle(ARTWORK);
  const twice = injectSettle(once.source);
  assert.equal(twice.injected, false);
  assert.equal(twice.reason, 'already settles');
  assert.equal(twice.source, once.source, 'a settled source is left exactly as it is');

  // A source with no step pipeline is reported, not broken.
  const missing = injectSettle('export const nothing = 1;\n');
  assert.equal(missing.injected, false);
  assert.equal(missing.reason, 'no step pipeline to settle');
  assert.equal(missing.source, 'export const nothing = 1;\n');

  assert.equal(injectSettle('').injected, false);
  assert.equal(injectSettle(null).injected, false);
});

test('the injected source is still valid JavaScript', async () => {
  const result = injectSettle(ARTWORK);
  // The code must run: build it and step it twice.
  const module = await import(`data:text/javascript,${encodeURIComponent(result.source)}`);
  const artwork = new module.Artwork();
  artwork.step();
  artwork.step();
  assert.equal(artwork.iteration, 2);
  assert.ok(artwork.settlePrev instanceof Uint8Array, 'the memory lives on the artwork');
});
