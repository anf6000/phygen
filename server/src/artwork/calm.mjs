// ─────────────────────────────────────────────────────────────────────────────
// calm.mjs — keep the frame calm in time.
//
// A step must not rewrite most of its own field. When it does, the frame jumps
// between one step and the next, and the artwork flickers.
//
// The mechanisms stay as they are. Instead the trail SETTLES towards what they
// produced: one step may move the trail only a share of the way. The artwork
// keeps its structure, and the frame stops flashing.
//
// The injection is a pure string operation, so it is tested without a run, and
// it is idempotent: a source that already settles is left alone.
// ─────────────────────────────────────────────────────────────────────────────

/** The share of a step's change that survives. Lower is calmer. */
export const SETTLE_SHARE = 0.22;

/** The memory buffer the injected code keeps on the artwork. */
const MEMORY = 'settlePrev';

/** True when a source already settles its trail. */
export function hasSettle(source) {
  return typeof source === 'string' && source.includes(MEMORY);
}

/**
 * Insert the settle at the end of the step pipeline, before the step count
 * increases. The first step of a run only starts the memory, so `reset` still
 * reproduces its run exactly.
 *
 * @param {string} source the artwork source
 * @returns {{ source: string, injected: boolean, reason: string }}
 */
export function injectSettle(source) {
  if (typeof source !== 'string' || source.length === 0) {
    return { source, injected: false, reason: 'no source' };
  }
  if (hasSettle(source)) return { source, injected: false, reason: 'already settles' };

  const stepAt = source.indexOf('step() {');
  const anchor = 'this.iteration++';
  const at = stepAt >= 0 ? source.indexOf(anchor, stepAt) : -1;
  if (at < 0) return { source, injected: false, reason: 'no step pipeline to settle' };

  // Find the indentation of the line the anchor sits on, so the block fits.
  const lineStart = source.lastIndexOf('\n', at) + 1;
  const indent = source.slice(lineStart, at).match(/^[ \t]*/)?.[0] ?? '  ';

  const block = [
    `${indent}{`,
    `${indent}  const settleTrail = this.trail;`,
    `${indent}  const settleN = settleTrail.length;`,
    `${indent}  let settlePrev = this.${MEMORY};`,
    `${indent}  if (this.iteration === 0 || !settlePrev || settlePrev.length !== settleN) {`,
    `${indent}    this.${MEMORY} = new Uint8Array(settleN);`,
    `${indent}    this.${MEMORY}.set(settleTrail);`,
    `${indent}  } else {`,
    `${indent}    for (let settleI = 0; settleI < settleN; settleI++) {`,
    `${indent}      const settleWas = settlePrev[settleI];`,
    `${indent}      settleTrail[settleI] = (settleWas + (settleTrail[settleI] - settleWas) * ${SETTLE_SHARE} + 0.5) | 0;`,
    `${indent}    }`,
    `${indent}    settlePrev.set(settleTrail);`,
    `${indent}  }`,
    `${indent}}`,
    '',
  ].join('\n');

  return { source: `${source.slice(0, lineStart)}${block}${source.slice(lineStart)}`, injected: true, reason: 'settle added' };
}
