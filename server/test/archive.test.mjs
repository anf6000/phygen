// The archive policy: who is worth evolving next, and why. The policy chooses
// parents without a person, so its rules are pinned here.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROLES, archiveStalled, buildArchive, noveltyOf, pickParents, qualityOf } from '../src/controller/archive.mjs';

function version(id, createdAt) {
  return { id, createdAt: createdAt ?? `2026-01-01T00:00:0${id.slice(1)}.000Z`, status: 'rejected' };
}

/** A comparison that one version won, or that ended with no preference. */
function comparison(round, labels, winnerVersionId, confidence = 0.7) {
  return {
    id: `c${round}`,
    round,
    labels: Object.fromEntries(labels.map((id, index) => [id, 'ABCDEFGHI'[index]])),
    winnerVersionId,
    confidence,
    verdict: { preference: winnerVersionId ? 'first' : 'none' },
  };
}

/** A distance table, so the geometry of a fixture is exact. */
function tableDistance(table) {
  return (a, b) => {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (key in table) return table[key];
    return 1;
  };
}

test('a quality tally counts wins, losses and abstentions separately', () => {
  const comparisons = [
    comparison(1, ['v1', 'v2'], 'v1', 0.8),
    comparison(2, ['v1', 'v3'], 'v1', 0.6),
    comparison(3, ['v1', 'v4'], null),
  ];
  const first = qualityOf('v1', comparisons);
  assert.equal(first.wins, 2);
  assert.equal(first.losses, 0);
  assert.equal(first.abstentions, 1, 'an abstention is not a loss');
  assert.equal(first.votes, 2);
  assert.ok(Math.abs(first.score - 0.75) < 1e-9, 'two wins of two is smoothed to 0.75');
  assert.ok(Math.abs(first.confidence - 0.7) < 1e-9);

  // A version that never competed sits in the middle, because nothing is known.
  const unknown = qualityOf('v9', comparisons);
  assert.equal(unknown.votes, 0);
  assert.equal(unknown.score, 0.5);

  // One lucky win must not outrank a proven record.
  const lucky = qualityOf('v5', [comparison(4, ['v5', 'v6'], 'v5', 0.9)]);
  assert.ok(lucky.score < first.score, 'a proven record beats a single win');
});

test('novelty is the distance to the nearest other member', () => {
  const distance = tableDistance({ 'v1|v2': 0.2, 'v1|v3': 0.9, 'v2|v3': 0.4 });
  assert.equal(noveltyOf('v1', ['v2', 'v3'], distance), 0.2);
  assert.equal(noveltyOf('v1', [], distance), 1, 'nothing to compare with is maximal distance');
  assert.equal(noveltyOf('v1', ['v1'], distance), 1, 'a version is not its own neighbour');
});

test('the archive takes the best version, then the furthest, and refuses the rest', () => {
  const versions = [version('v1'), version('v2'), version('v3'), version('v4'), version('v5')];
  const comparisons = [
    // v1 wins three, v2 wins two and loses one, v3 loses three, v4 never competes, v5 wins one and loses one.
    comparison(1, ['v1', 'v2'], 'v1'),
    comparison(2, ['v1', 'v3'], 'v1'),
    comparison(3, ['v1', 'v5'], 'v1'),
    comparison(4, ['v2', 'v3'], 'v2'),
    comparison(5, ['v2', 'v5'], 'v2'),
    comparison(6, ['v3', 'v5'], 'v5'),
  ];
  const distance = tableDistance({
    'v1|v2': 0.1,
    'v1|v4': 0.9,
    'v1|v5': 0.6,
    'v2|v4': 0.8,
    'v2|v5': 0.5,
    'v4|v5': 0.5,
    'v3|v1': 0.3,
    'v3|v2': 0.2,
    'v3|v4': 0.7,
    'v3|v5': 0.4,
  });

  const archive = buildArchive({ versions, comparisons, distance, size: 3, noveltyFloor: 0.35, qualityFloor: 0.4 });
  assert.deepEqual(
    archive.members.map((member) => member.version.id),
    ['v1', 'v4', 'v5'],
    'the best, then the furthest from it, then the furthest from both',
  );
  const refused = new Map(archive.refused.map((entry) => [entry.id, entry.reason]));
  assert.equal(refused.get('v2'), 'near duplicate', 'a near copy of the best adds no territory');
  assert.equal(refused.get('v3'), 'quality', 'a version the judge keeps rejecting is not evolved from');
  assert.equal(archive.members[0].addedBy, 'best quality');
  assert.equal(archive.members[1].addedBy, 'furthest');
});

test('the archive is deterministic and bounded', () => {
  const versions = [version('v1'), version('v2'), version('v3'), version('v4')];
  const distance = tableDistance({ 'v1|v2': 0.9, 'v1|v3': 0.8, 'v1|v4': 0.7, 'v2|v3': 0.6, 'v2|v4': 0.5, 'v3|v4': 0.4 });
  const first = buildArchive({ versions, comparisons: [], distance, size: 2, noveltyFloor: 0.1 });
  const shuffled = buildArchive({ versions: [...versions].reverse(), comparisons: [], distance, size: 2, noveltyFloor: 0.1 });
  assert.deepEqual(
    first.members.map((member) => member.version.id),
    shuffled.members.map((member) => member.version.id),
    'the input order never changes the archive',
  );
  assert.equal(first.members.length, 2, 'the size is a hard cap');
  // All qualities are equal, so the earliest version wins the first place.
  assert.equal(first.members[0].version.id, 'v1');
});

test('a level picks exploit, explore and repair, each explained', () => {
  const archive = {
    members: [
      { version: version('v1'), quality: { score: 0.8, votes: 3, wins: 3, losses: 0, confidence: 0.7 } },
      { version: version('v4'), quality: { score: 0.5, votes: 0, wins: 0, losses: 0, confidence: 0 } },
      { version: version('v5'), quality: { score: 0.67, votes: 1, wins: 1, losses: 0, confidence: 0.9 } },
    ],
  };
  const distance = tableDistance({ 'v1|v4': 0.9, 'v1|v5': 0.6, 'v4|v5': 0.5 });
  const picks = pickParents({ archive, variants: 3, distance });

  assert.deepEqual(picks.map((pick) => pick.role), ['exploit', 'explore', 'repair']);
  assert.equal(picks[0].versionId, 'v1', 'exploit takes the best quality');
  assert.equal(picks[1].versionId, 'v4', 'explore takes the furthest from the best');
  assert.equal(picks[2].versionId, 'v5', 'repair takes the weakest, and it is not one already picked');
  assert.equal(picks[0].kind, 'refinement');
  assert.equal(picks[1].kind, 'experiment');
  for (const pick of picks) assert.ok(pick.reason.length > 10, `${pick.role} must say why`);
});

test('a level with more variants than roles gives each role a fresh parent', () => {
  const archive = {
    members: [
      { version: version('v1'), quality: { score: 0.8, votes: 3, wins: 3, losses: 0, confidence: 0.7 } },
      { version: version('v2'), quality: { score: 0.7, votes: 3, wins: 2, losses: 1, confidence: 0.6 } },
      { version: version('v3'), quality: { score: 0.6, votes: 3, wins: 1, losses: 2, confidence: 0.5 } },
    ],
  };
  const distance = tableDistance({ 'v1|v2': 0.4, 'v1|v3': 0.6, 'v2|v3': 0.5 });
  const picks = pickParents({ archive, variants: 6, distance });
  assert.deepEqual(picks.map((pick) => pick.role), ['exploit', 'explore', 'repair', 'exploit', 'explore', 'repair']);
  assert.equal(new Set(picks.slice(0, 3).map((pick) => pick.versionId)).size, 3, 'the first three use three different parents');
  assert.ok(picks[3] !== undefined, 'the banked roles repeat when the level asks for more');
});

test('a stalled archive says so in the reason it records', () => {
  const archive = {
    members: [
      { version: version('v1'), quality: { score: 0.8, votes: 3, wins: 3, losses: 0, confidence: 0.7 } },
      { version: version('v2'), quality: { score: 0.6, votes: 2, wins: 1, losses: 1, confidence: 0.5 } },
      { version: version('v3'), quality: { score: 0.5, votes: 1, wins: 0, losses: 1, confidence: 0 } },
    ],
  };
  const distance = tableDistance({ 'v1|v2': 0.6, 'v1|v3': 0.7, 'v2|v3': 0.5 });
  const picks = pickParents({ archive, variants: 3, stalled: true, distance });
  const explore = picks.find((pick) => pick.role === 'explore');
  assert.match(explore.reason, /stalled/);
  assert.equal(archiveStalled({ unchangedLevels: 2, redirectAfter: 2 }), true);
  assert.equal(archiveStalled({ unchangedLevels: 1, redirectAfter: 2 }), false);
  assert.deepEqual([...ROLES], ['exploit', 'explore', 'repair']);
});

test('an empty archive picks nothing instead of inventing a parent', () => {
  assert.deepEqual(pickParents({ archive: { members: [] }, variants: 3, distance: () => 1 }), []);
});
