// Fixtures for the local generation-ring layout: every node's children form a
// ring around that node, and no two cards overlap.
//
// The layout claims an absence of overlap, so these fixtures MEASURE it on the
// real rectangles: `findOverlaps` is the same check the interface relies on.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { boundaryPoint, findOverlaps, layoutKey, layoutRings } from '../src/layout/radial.ts';

const CARD = { cardWidth: 260, cardHeight: 300 };
const CARD_RADIUS = Math.hypot(CARD.cardWidth, CARD.cardHeight) / 2;
const CARD_GAP = 20;
/** The least distance two card centres need. */
const CLEARANCE = 2 * CARD_RADIUS + CARD_GAP;

function node(id, parentId, generation, createdAt) {
  return { id, parentId, generation, createdAt: createdAt ?? `2026-01-01T00:00:${String(generation).padStart(2, '0')}.000Z` };
}

function chain(length) {
  const nodes = [node('root', null, 0)];
  for (let index = 1; index < length; index++) nodes.push(node(`v${index}`, index === 1 ? 'root' : `v${index - 1}`, index));
  return nodes;
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The layout is sound when nothing overlaps and the report agrees with reality. */
function assertSound(nodes, layout) {
  const overlaps = findOverlaps(layout, CARD.cardWidth, CARD.cardHeight);
  assert.deepEqual(overlaps.map((entry) => entry.text), [], overlaps.map((entry) => entry.text).join('; '));
  assert.deepEqual(layout.problems, [], 'the layout reports the same clean result');
  for (const entry of nodes) {
    assert.ok(layout.centers.has(entry.id) || layout.diagnostics.some((item) => item.id === entry.id), `${entry.id} is placed or reported`);
  }
}

/**
 * The least radius a ring needs, measured on the cards that were actually
 * placed. Used to prove the layout leaves no slack and wastes no room.
 */
function requiredRadius(layout, parentId, childIds) {
  const parent = layout.centers.get(parentId);
  const needX = CARD.cardWidth + CARD_GAP;
  const needY = CARD.cardHeight + CARD_GAP;
  let radius = 0;
  const consider = (dx, dy) => {
    const ax = dx < 1e-12 ? Number.POSITIVE_INFINITY : needX / dx;
    const ay = dy < 1e-12 ? Number.POSITIVE_INFINITY : needY / dy;
    const least = Math.min(ax, ay);
    if (Number.isFinite(least)) radius = Math.max(radius, least);
  };
  const units = childIds.map((id) => {
    const child = layout.centers.get(id);
    const distance = Math.hypot(child.x - parent.x, child.y - parent.y);
    return { x: (child.x - parent.x) / distance, y: (child.y - parent.y) / distance };
  });
  for (const unit of units) consider(Math.abs(unit.x), Math.abs(unit.y));
  for (let index = 0; index < units.length; index++) {
    for (let other = index + 1; other < units.length; other++) {
      consider(Math.abs(units[index].x - units[other].x), Math.abs(units[index].y - units[other].y));
    }
  }
  return radius;
}

/** Every ring is as tight as the real cards allow: no room is wasted. */
function assertTight(layout, parentId, childIds) {
  const radius = layout.radii.get(childIds[0]);
  const least = requiredRadius(layout, parentId, childIds);
  assert.ok(radius >= least - 1e-4, `${parentId}: the ring is too small (${radius} < ${least})`);
  assert.ok(radius <= least * 1.02 + 1e-4, `${parentId}: the ring wastes room (${radius} > ${least})`);
}

/**
 * Every child of a node sits at the same distance from it: that is what makes a
 * ring a ring. A block of leaves is not a ring, so it is checked separately.
 */
function assertRingAroundParent(layout, parentId, childIds) {
  const parent = layout.centers.get(parentId);
  const distances = childIds.map((id) => distance(parent, layout.centers.get(id)));
  const radius = distances[0];
  for (let index = 0; index < childIds.length; index++) {
    assert.ok(Math.abs(distances[index] - radius) < 1e-6, `${childIds[index]} must sit on the ring of ${parentId}`);
    assert.ok(Math.abs(layout.radii.get(childIds[index]) - radius) < 1e-6, `${childIds[index]} must record its ring radius`);
  }
  const angles = childIds.map((id) => layout.angles.get(id));
  const seen = new Set(angles.map((value) => value.toFixed(9)));
  assert.equal(seen.size, childIds.length, 'the children never share an angle');
  // The children turn one way from the first, which points straight out. The
  // angle is measured relative to the first child, so a full turn that wraps at
  // the axis still reads as a single direction.
  const relative = childIds.map((id) => {
    const offset = { x: layout.centers.get(id).x - parent.x, y: layout.centers.get(id).y - parent.y };
    const delta = Math.atan2(offset.y, offset.x) - Math.atan2(layout.centers.get(childIds[0]).y - parent.y, layout.centers.get(childIds[0]).x - parent.x);
    return (delta + Math.PI * 2) % (Math.PI * 2);
  });
  relative[0] = 0;
  for (let index = 1; index < relative.length; index++) {
    assert.ok(relative[index] > relative[index - 1], `the ring turns in one direction (${relative.map((value) => value.toFixed(2)).join(', ')})`);
  }
}

test('a lineage that does not divide grows straight outward', () => {
  const nodes = chain(6);
  const layout = layoutRings(nodes, { rootId: 'root', ...CARD });
  assert.equal(layout.positions.size, 6);
  assert.equal(layout.diagnostics.length, 0);
  assert.deepEqual([...layout.depths.values()], [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(layout.centers.get('root'), { x: 0, y: 0 }, 'the root centre is the graph origin');

  // One child per node: the step clears the parent's card along the axis the
  // branch points at, which is straight up from the root.
  const step = layout.radii.get('v1');
  assert.ok(Math.abs(step - (CARD.cardHeight + CARD_GAP)) < 1e-6, `expected one vertical clearance step, got ${step}`);
  for (let depth = 2; depth < 6; depth++) assert.ok(Math.abs(layout.radii.get(`v${depth}`) - step) < 1e-6, 'every step keeps the same length');
  const root = layout.centers.get('root');
  const radii = [];
  for (let depth = 0; depth <= 5; depth++) radii.push(distance(root, layout.centers.get(depth === 0 ? 'root' : `v${depth}`)));
  for (let index = 1; index < radii.length; index++) assert.ok(radii[index] > radii[index - 1], 'each generation is further out');
  assert.equal(layout.repairs, 0, 'a chain needs no repair');

  assertSound(nodes, layout);
});

test('children form a ring around their parent, wider when there are more of them', () => {
  const few = [node('root', null, 0)];
  for (let index = 0; index < 3; index++) few.push(node(`c${index}`, 'root', 1, `2026-01-01T00:00:0${index}.000Z`));
  const fewLayout = layoutRings(few, { rootId: 'root', ...CARD });
  assertRingAroundParent(fewLayout, 'root', ['c0', 'c1', 'c2']);
  assertTight(fewLayout, 'root', ['c0', 'c1', 'c2']);
  assert.equal(fewLayout.repairs, 0);
  assertSound(few, fewLayout);

  // Four children of the root, each with one child of its own: those children
  // need room outward, so the fan is kept.
  const fan = [node('root', null, 0)];
  for (let index = 0; index < 6; index++) {
    fan.push(node(`b${index}`, 'root', 1, `2026-01-01T00:02:${String(index).padStart(2, '0')}.000Z`));
    fan.push(node(`b${index}k`, `b${index}`, 2, `2026-01-01T00:03:${String(index).padStart(2, '0')}.000Z`));
  }
  const fanLayout = layoutRings(fan, { rootId: 'root', ...CARD });
  const fanIds = fan.filter((entry) => entry.parentId === 'root').map((entry) => entry.id);
  assertRingAroundParent(fanLayout, 'root', fanIds);
  assertTight(fanLayout, 'root', fanIds);
  assertSound(fan, fanLayout);
  const wideNodes = [
    node('root', null, 0),
    node('c0', 'root', 1, '2026-01-01T00:01:00.000Z'),
    ...Array.from({ length: 24 }, (_, index) => node(`w${index}`, 'c0', 2, `2026-01-01T00:04:${String(index).padStart(2, '0')}.000Z`)),
  ];
  const wide = layoutRings(wideNodes, { rootId: 'root', ...CARD });
  const wideIds = wideNodes.filter((entry) => entry.parentId === 'c0').map((entry) => entry.id);
  const widest = Math.max(...wideIds.map((id) => wide.radii.get(id)));
  const narrowest = Math.max(...fanIds.map((id) => fanLayout.radii.get(id)));
  assert.ok(widest > narrowest, 'a wide brood needs more room than a narrow one');
  assertSound(wideNodes, wide);
});

test('a brood of leaves packs as a tight block instead of a wide ring', () => {
  const nodes = [node('root', null, 0)];
  for (let index = 0; index < 38; index++) nodes.push(node(`c${index}`, 'root', 1, `2026-01-01T00:05:${String(index).padStart(2, '0')}.000Z`));
  const layout = layoutRings(nodes, { rootId: 'root', ...CARD });
  const ids = nodes.slice(1).map((entry) => entry.id);
  assertSound(nodes, layout);
  assert.equal(layout.repairs, 0);

  // A ring of 38 cards on a full turn would need a circle of radius about
  // needX / (2 sin(pi / 38)) = 1,670, which covers far more area than a block.
  const ringRadius = (CARD.cardWidth + CARD_GAP) / (2 * Math.sin(Math.PI / 38));
  const ringArea = Math.PI * ringRadius * ringRadius;
  const centres = ids.map((id) => layout.centers.get(id));
  const xs = centres.map((point) => point.x);
  const ys = centres.map((point) => point.y);
  const blockArea = (Math.max(...xs) - Math.min(...xs) + CARD.cardWidth) * (Math.max(...ys) - Math.min(...ys) + CARD.cardHeight);
  assert.ok(blockArea < ringArea * 0.6, `the block must beat the ring: ${Math.round(blockArea)} against ${Math.round(ringArea)}`);
  // Every card sits at card pitch on the axes, so the block wastes nothing.
  const columns = [...new Set(xs.map((value) => Math.round(value)))].sort((a, b) => a - b);
  const gapsX = columns.slice(1).map((value, index) => value - columns[index]);
  for (const gap of gapsX) assert.ok(Math.abs(gap - (CARD.cardWidth + CARD_GAP)) < 1.5, `a column gap of ${gap} is not one pitch`);
});

test('the ring radius is the least radius that still holds every card', () => {
  const nodes = [node('root', null, 0)];
  for (let index = 0; index < 9; index++) {
    nodes.push(node(`c${index}`, 'root', 1, `2026-01-01T00:02:${String(index).padStart(2, '0')}.000Z`));
    nodes.push(node(`d${index}`, `c${index}`, 2, `2026-01-01T00:03:${String(index).padStart(2, '0')}.000Z`));
  }
  const layout = layoutRings(nodes, { rootId: 'root', ...CARD });
  const ids = nodes.filter((entry) => entry.parentId === 'root').map((entry) => entry.id);
  assertRingAroundParent(layout, 'root', ids);
  // The ring is exactly what the closest pair of CARDS needs, and a tighter one
  // would make them touch.
  assertTight(layout, 'root', ids);
  assert.equal(layout.repairs, 0, 'the first placement is already clean');
  assertSound(nodes, layout);
});

test('the children of one node never sit behind it', () => {
  const nodes = [node('root', null, 0)];
  for (let index = 0; index < 12; index++) nodes.push(node(`c${index}`, 'root', 1, `2026-01-01T00:03:${String(index).padStart(2, '0')}.000Z`));
  for (let index = 0; index < 4; index++) nodes.push(node(`c0d${index}`, 'c0', 2, `2026-01-01T00:04:${String(index).padStart(2, '0')}.000Z`));
  const layout = layoutRings(nodes, { rootId: 'root', ...CARD });
  // Every card of a ring is at least as far from the root as its parent.
  const rootCenter = layout.centers.get('root');
  for (const entry of nodes) {
    if (!entry.parentId) continue;
    const parent = layout.centers.get(entry.parentId);
    const child = layout.centers.get(entry.id);
    const parentDistance = distance(rootCenter, parent);
    const childDistance = distance(rootCenter, child);
    assert.ok(childDistance >= parentDistance - 1e-6, `${entry.id} must not fold back over ${entry.parentId}`);
  }
  assertSound(nodes, layout);
});

test('a deep and wide tree has no overlap at any level', () => {
  // Three levels of branching: 1 + 4 + 16 + 48 cards.
  const nodes = [node('root', null, 0)];
  for (let a = 0; a < 4; a++) {
    nodes.push(node(`a${a}`, 'root', 1, `2026-01-01T00:10:0${a}.000Z`));
    for (let b = 0; b < 4; b++) {
      nodes.push(node(`a${a}b${b}`, `a${a}`, 2, `2026-01-01T00:11:${a}${b}.000Z`));
      for (let c = 0; c < 3; c++) nodes.push(node(`a${a}b${b}c${c}`, `a${a}b${b}`, 3, `2026-01-01T00:12:${a}${b}${c}.000Z`));
    }
  }
  const layout = layoutRings(nodes, { rootId: 'root', ...CARD });
  assert.equal(layout.positions.size, 69);
  assertRingAroundParent(layout, 'root', ['a0', 'a1', 'a2', 'a3']);
  assertRingAroundParent(layout, 'a0', ['a0b0', 'a0b1', 'a0b2', 'a0b3']);
  assertSound(nodes, layout);
});

test('the shape of the real artwork stays free of overlap', () => {
  // The recorded artwork: one parent with 38 children, one with 21, one with 9,
  // and several small broods, to a depth of 7.
  const nodes = [node('root', null, 0)];
  const broods = [
    ['n38', 'root', 38, 1],
    ['n21', 'root', 21, 2],
    ['n9', 'root', 9, 3],
    ['n6a', 'root', 6, 4],
    ['n6b', 'root', 6, 5],
    ['n4', 'root', 4, 6],
    ['n3a', 'root', 3, 7],
    ['n3b', 'root', 3, 8],
  ];
  for (const [parent, parentId, count, depth] of broods) {
    nodes.push(node(parent, parentId, depth, `2026-01-01T01:00:${String(depth).padStart(2, '0')}.000Z`));
    for (let index = 0; index < count; index++) {
      const id = `${parent}_${index}`;
      nodes.push(node(id, parent, depth + 1, `2026-01-01T01:${String(depth).padStart(2, '0')}:${String(index).padStart(2, '0')}.000Z`));
      if (index % 7 === 0) {
        nodes.push(node(`${id}_k`, `${id}`, depth + 2, `2026-01-01T02:${String(depth).padStart(2, '0')}:${String(index).padStart(2, '0')}.000Z`));
        nodes.push(node(`${id}_k2`, `${id}_k`, depth + 3, `2026-01-01T03:${String(depth).padStart(2, '0')}:${String(index).padStart(2, '0')}.000Z`));
      }
    }
  }
  const layout = layoutRings(nodes, { rootId: 'root', ...CARD });
  assert.equal(layout.diagnostics.length, 0);
  assertSound(nodes, layout);
  assert.ok(layout.bounds.maxX - layout.bounds.minX > 0);
  assert.ok(layout.repairs < 40, `the repair loop must settle, it used ${layout.repairs} step(s)`);
});

test('a stored generation that disagrees with the rings is reported, not followed', () => {
  const nodes = [node('root', null, 0), node('a', 'root', 7), node('b', 'a', 2)];
  const layout = layoutRings(nodes, { rootId: 'root', ...CARD });
  assert.equal(layout.depths.get('a'), 1, 'the parent link decides the ring, not the stored generation');
  assert.equal(layout.depths.get('b'), 2);
  assert.deepEqual(layout.generationMismatch, [{ id: 'a', generation: 7, depth: 1 }]);
});

test('the canonical root decides the rings, not the oldest record', () => {
  const nodes = [
    node('older', null, 0, '2025-01-01T00:00:00.000Z'),
    node('root', null, 0, '2026-01-01T00:00:00.000Z'),
    node('child', 'root', 1, '2026-01-01T00:00:01.000Z'),
  ];
  const layout = layoutRings(nodes, { rootId: 'root', ...CARD });
  assert.deepEqual(layout.centers.get('root'), { x: 0, y: 0 });
  assert.equal(layout.depths.get('child'), 1);
  assert.equal(layout.positions.has('older'), false, 'an unrelated root is not placed on the rings');
  assert.equal(layout.diagnostics.length, 1);
  assert.equal(layout.diagnostics[0].id, 'older');
});

test('a missing parent is an orphan and a cycle is a cycle, never an invented parent', () => {
  const nodes = [node('root', null, 0), node('child', 'root', 1), node('lost', 'gone', 2), node('x', 'y', 2), node('y', 'x', 3)];
  const layout = layoutRings(nodes, { rootId: 'root', ...CARD });
  const reasons = new Map(layout.diagnostics.map((entry) => [entry.id, entry.reason]));
  assert.equal(reasons.get('lost'), 'orphan');
  assert.equal(reasons.get('x'), 'cycle');
  assert.equal(reasons.get('y'), 'cycle');
  assert.equal(layout.positions.has('lost'), false);
  assert.ok(layout.diagnosticPositions.has('lost'));
  const ringX = layout.positions.get('child').x;
  for (const point of layout.diagnosticPositions.values()) assert.ok(point.x < ringX, 'the diagnostic column is outside the rings');
  assert.notDeepEqual(layout.diagnosticPositions.get('lost'), { x: 0, y: 0 });
});

test('the layout is deterministic and independent of input order', () => {
  const nodes = [
    node('root', null, 0),
    node('a', 'root', 1, '2026-01-01T00:00:01.000Z'),
    node('b', 'root', 1, '2026-01-01T00:00:02.000Z'),
    node('c', 'b', 2, '2026-01-01T00:00:03.000Z'),
    node('d', 'a', 2, '2026-01-01T00:00:04.000Z'),
  ];
  const first = layoutRings(nodes, { rootId: 'root', ...CARD });
  const shuffled = layoutRings([nodes[3], nodes[0], nodes[4], nodes[1], nodes[2]], { rootId: 'root', ...CARD });
  assert.deepEqual([...first.positions], [...shuffled.positions]);
  assert.deepEqual([...first.radii], [...shuffled.radii]);
  assert.equal(first.repairs, shuffled.repairs);
});

test('the layout key follows topology and card size, not status', () => {
  const nodes = [node('root', null, 0), node('a', 'root', 1, '2026-01-01T00:00:01.000Z')];
  const key = layoutKey(nodes, 'root', CARD.cardWidth, CARD.cardHeight);
  assert.equal(key, layoutKey([...nodes].reverse(), 'root', CARD.cardWidth, CARD.cardHeight));
  assert.notEqual(key, layoutKey([{ ...nodes[0] }, { ...nodes[1], parentId: 'other' }], 'root', CARD.cardWidth, CARD.cardHeight));
  assert.notEqual(key, layoutKey(nodes, 'root', CARD.cardWidth + 1, CARD.cardHeight));
});

test('a root without descendants still reports a finite layout', () => {
  const layout = layoutRings([node('root', null, 0)], { rootId: 'root', ...CARD });
  assert.equal(layout.positions.size, 1);
  assert.deepEqual(layout.positions.get('root'), { x: -CARD.cardWidth / 2, y: -CARD.cardHeight / 2 });
  assert.equal(layout.rings.length, 1);
  assert.ok(layout.bounds);
});

test('an edge leaves a card at its boundary, not at its centre', () => {
  const center = { x: 0, y: 0 };
  assert.deepEqual(boundaryPoint(center, { x: 1000, y: 0 }, 260, 300), { x: 130, y: 0 });
  assert.deepEqual(boundaryPoint(center, { x: 0, y: -1000 }, 260, 300), { x: 0, y: -150 });
  const diagonal = boundaryPoint(center, { x: 300, y: 300 }, 260, 300);
  assert.ok(Math.abs(diagonal.x) === 130 || Math.abs(diagonal.y) === 150);
  assert.deepEqual(boundaryPoint(center, center, 260, 300), center);
});
