// ─────────────────────────────────────────────────────────────────────────────
// fake-edits.mjs — real source edits for the deterministic test double.
//
// The test double must change code, not only numbers, so the whole pipeline can
// be demonstrated without a model. Each recipe is a small, readable change to
// the artwork that keeps the adapter contract and the seeded random stream.
// ─────────────────────────────────────────────────────────────────────────────
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const RECIPES = {
  refinement: {
    file: 'src/physarum.js',
    note: 'Damped the turn so the network keeps its direction longer.',
    apply(source) {
      const before = '        h += rng() < 0.5 ? rotAngle : -rotAngle;';
      const after = '        h += (rng() < 0.5 ? rotAngle : -rotAngle) * 0.8;';
      return source.includes(before) ? source.replace(before, after) : null;
    },
  },
  structure: {
    file: 'src/physarum.js',
    note: 'Deposited a two-pixel trail so the veins thicken.',
    apply(source) {
      const before = ['    for (let i = 0; i < num; i++) {', '      trail[(y[i] | 0) * W + (x[i] | 0)] = 255;', '    }'].join('\n');
      const after = [
        '    for (let i = 0; i < num; i++) {',
        '      const px = x[i] | 0;',
        '      const py = y[i] | 0;',
        '      trail[py * W + px] = 255;',
        '      trail[py * W + ((px + 1) % W)] = 255;',
        '    }',
      ].join('\n');
      return source.includes(before) ? source.replace(before, after) : null;
    },
  },
  experiment: {
    file: 'src/physarum.js',
    note: 'Added a far sensor pair that steers the mold by half a turn step.',
    apply(source) {
      const before = [
        '      const r = this._sense(px, py, h + sensorAngle);',
        '      const f = this._sense(px, py, h);',
        '      const l = this._sense(px, py, h - sensorAngle);',
      ].join('\n');
      const after = [
        before,
        '      const farRight = this._sense(px, py, h + sensorAngle * 2);',
        '      const farLeft = this._sense(px, py, h - sensorAngle * 2);',
      ].join('\n');
      if (!source.includes(before)) return null;
      let next = source.replace(before, after);

      const anchor = '      // the sketch\'s steering table, verbatim';
      const injected = [
        '      if (farRight > f && farRight > r) {',
        '        heading[i] = h + rotAngle * 0.5;',
        '        continue;',
        '      }',
        '      if (farLeft > f && farLeft > l) {',
        '        heading[i] = h - rotAngle * 0.5;',
        '        continue;',
        '      }',
        '',
        anchor,
      ].join('\n');
      if (!next.includes(anchor)) return source.replace(before, after);
      next = next.replace(anchor, injected);
      return next;
    },
  },
};

/**
 * Apply the source recipe of one slot.
 * @returns {Promise<{file: string, note: string}|null>} null when the recipe did not match
 */
export async function applySourceRecipe({ workspaceDir, slot }) {
  const recipe = RECIPES[slot] ?? RECIPES.refinement;
  const path = join(workspaceDir, recipe.file);
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch {
    return null;
  }
  const next = recipe.apply(source);
  if (!next || next === source) return null;
  await writeFile(path, next, 'utf8');
  return { file: recipe.file, note: recipe.note, before: source, after: next };
}

