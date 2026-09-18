// The instruction a run writes for itself when a person wrote none. It is text
// assembly from records, so every sentence must be traceable to one.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { recordedWeaknesses, unexploredAxes, writeDirection } from '../src/controller/direction.mjs';

function version(id, configuration, title = id) {
  return { id, title, configuration };
}

function comparison(id, labels, weaknesses) {
  return { id, labels: Object.fromEntries(labels.map((label, index) => [label, 'ABCDEFGHI'[index]])), verdict: { weaknesses } };
}

test('the least-moved configuration fields are the unexplored axes', () => {
  const axes = unexploredAxes([
    version('a', { palette: 'white', decay: 5, speed: 1, gain: 1 }),
    version('b', { palette: 'white', decay: 9, speed: 1, gain: 2 }),
  ]);
  assert.equal(axes[0].distinct, 1, 'a field every member shares is the least moved, so it comes first');
  const fields = axes.map((axis) => axis.field);
  assert.ok(fields.includes('palette'), 'a field every member shares has room left');
  assert.ok(fields.indexOf('gain') > fields.indexOf('palette'), 'a field with two values moves more than one with a single value');
  const palette = axes.find((axis) => axis.field === 'palette');
  assert.equal(palette.distinct, 1);
  // Fields are ordered by how little they moved, then by name, so the answer is stable.
  assert.deepEqual(
    unexploredAxes([version('a', { b: 1, a: 1 }), version('b', { b: 1, a: 1 })]).map((axis) => axis.field),
    ['a', 'b'],
  );
});

test('the weaknesses come from the comparisons that named the lineage', () => {
  const comparisons = [
    comparison('c1', ['ver_parent', 'ver_other'], ['the trails saturate early']),
    comparison('c2', ['ver_parent', 'ver_child'], ['the palette is flat', 'the trails saturate early']),
  ];
  const weaknesses = recordedWeaknesses(comparisons, ['ver_parent']);
  assert.deepEqual(weaknesses, ['the palette is flat', 'the trails saturate early'], 'newest first, and each one once');
  assert.deepEqual(recordedWeaknesses(comparisons, ['ver_unrelated']), [], 'a comparison about another version says nothing');
});

test('a repair direction quotes what the judge already said', () => {
  const direction = writeDirection({
    role: 'repair',
    kind: 'refinement',
    parent: version('ver_parent', {}, 'Controlled experiment'),
    weaknesses: ['the trails saturate early'],
    axes: [{ field: 'decay', distinct: 1 }, { field: 'gain', distinct: 1 }],
  });
  assert.equal(direction.source, 'judge weakness');
  assert.match(direction.text, /Repair what the comparison already found/);
  assert.match(direction.text, /the trails saturate early/);
  assert.match(direction.text, /decay, gain/);
  assert.equal(direction.evidence.weaknesses[0], 'the trails saturate early');
});

test('a stalled archive asks for a structural change instead of a refinement', () => {
  const direction = writeDirection({ role: 'explore', kind: 'experiment', parent: version('ver_parent', {}, 'Root'), stalled: true });
  assert.equal(direction.source, 'stall');
  assert.match(direction.text, /Explore rather than refine/);
  assert.match(direction.text, /has not gained a member for two levels/);
  assert.equal(direction.evidence.stalled, true);
});

test('a plain level keeps the visual language so it stays comparable', () => {
  const exploit = writeDirection({ role: 'exploit', kind: 'refinement', parent: version('ver_parent', {}, 'Root') });
  assert.match(exploit.text, /Make one small, deliberate change/);
  assert.match(exploit.text, /Keep the current visual language/);

  const structure = writeDirection({ role: 'exploit', kind: 'structure', parent: version('ver_parent', {}, 'Root') });
  assert.match(structure.text, /Change how the current version \(Root\) is built/);

  const repairWithoutEvidence = writeDirection({ role: 'repair', kind: 'refinement', parent: version('ver_parent', {}, 'Root') });
  assert.equal(repairWithoutEvidence.source, 'repair without a recorded weakness');
  assert.match(repairWithoutEvidence.text, /Make one small, deliberate change/);
});

test('every direction is long enough to instruct a session', () => {
  for (const role of ['exploit', 'explore', 'repair', 'seed']) {
    for (const kind of ['refinement', 'structure', 'experiment']) {
      const direction = writeDirection({ role, kind, parent: version('ver_parent', { palette: 'white' }, 'Root'), weaknesses: ['flat'], axes: [{ field: 'decay', distinct: 1 }] });
      assert.ok(direction.text.length > 60, `${role}/${kind} must say something useful`);
      assert.ok(direction.source.length > 0);
    }
  }
});
