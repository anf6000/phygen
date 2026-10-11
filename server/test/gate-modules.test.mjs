// The archive and the self-written direction are pure. Their picks and their
// text come from records only, so a recorded decision is reproducible.
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { ROLES, archiveStalled, buildArchive, pickParent, qualityOf } from '../src/gate/archive.mjs';
import { recordedWeaknesses, unexploredAxes, writeDirection } from '../src/gate/direction.mjs';

function version(id, createdAt, status = 'promoted', configuration = {}) {
  return { id, createdAt, status, configuration };
}

function judgment(versionId, status, scores = []) {
  return { versionId, status, scores };
}

// A distance that reads one number per version id, so the picks are predictable.
const positions = { a: 0, b: 1, c: 5, d: 9 };
const distance = (left, right) => Math.min(1, Math.abs((positions[left] ?? 0) - (positions[right] ?? 0)) / 10);

test('the quality of a version comes from its judgment', () => {
  const kept = qualityOf('a', [judgment('a', 'kept', [{ score: 0.8 }, { score: 0.6 }])]);
  assert.equal(kept.score, 0.7);
  assert.equal(kept.known, true);
  assert.equal(qualityOf('b', [judgment('b', 'parked')]).score, 0);
  assert.equal(qualityOf('c', []).known, false, 'a version with no judgment is not zero');
});

test('the archive takes the best quality and then the most diverse member', () => {
  const versions = [version('a', '1'), version('b', '2'), version('c', '3'), version('d', '4')];
  const judgments = [judgment('a', 'kept', [{ score: 0.9 }]), judgment('b', 'kept', [{ score: 0.2 }]), judgment('c', 'kept', [{ score: 0.6 }])];
  const archive = buildArchive({ versions, judgments, distance, size: 3, noveltyFloor: 0.2, qualityFloor: 0.3 });
  assert.equal(archive.members[0].version.id, 'a', 'the best quality is first');
  assert.ok(archive.members.length >= 2);
  // Every member is far enough from the others.
  for (const member of archive.members) {
    for (const other of archive.members) {
      if (member === other) continue;
      assert.ok(distance(member.version.id, other.version.id) >= 0.2);
    }
  }
  // A version below the quality floor is refused with a reason.
  assert.ok(archive.refused.some((entry) => entry.id === 'b' && entry.reason === 'quality'));
});

test('a parent pick names a role, a version, and a reason', () => {
  const versions = [version('a', '1'), version('c', '3'), version('d', '4')];
  const judgments = [judgment('a', 'kept', [{ score: 0.9 }]), judgment('c', 'kept', [{ score: 0.6 }]), judgment('d', 'kept', [{ score: 0.5 }])];
  const archive = buildArchive({ versions, judgments, distance, size: 3, noveltyFloor: 0.1, qualityFloor: 0.3 });
  assert.deepEqual(ROLES, ['exploit', 'explore', 'repair']);
  const exploit = pickParent({ archive, role: 'exploit', distance });
  assert.equal(exploit.role, 'exploit');
  assert.equal(exploit.versionId, 'a');
  assert.match(exploit.reason, /best quality/);
  const explore = pickParent({ archive, role: 'explore', distance });
  assert.equal(explore.kind, 'experiment');
  const repair = pickParent({ archive, role: 'repair', distance });
  assert.equal(repair.kind, 'refinement');
  assert.equal(archiveStalled({ unchangedLevels: 2 }), true);
  assert.equal(archiveStalled({ unchangedLevels: 1 }), false);
});

test('the direction is written from the judge weaknesses and the least-moved axes', () => {
  const versions = [
    version('a', '1', 'promoted', { palette: 'ember', wind: 0.2, count: 4000 }),
    version('b', '2', 'promoted', { palette: 'ember', wind: 0.9, count: 4000 }),
  ];
  const axes = unexploredAxes(versions);
  assert.equal(axes[0].distinct, 1, 'the least-moved field comes first');
  const weaknesses = recordedWeaknesses([judgment('a', 'parked', []), { versionId: 'b', status: 'kept', judge: { weaknesses: ['too quiet', 'one cord'] } }], ['b']);
  assert.deepEqual(weaknesses, ['too quiet', 'one cord']);

  const repair = writeDirection({ role: 'repair', kind: 'refinement', parent: { title: 'Step 2' }, weaknesses, axes });
  assert.match(repair.text, /Repair what the comparison already found/);
  assert.equal(repair.source, 'judge weakness');
  assert.deepEqual(repair.evidence.weaknesses, weaknesses);

  const stall = writeDirection({ role: 'exploit', kind: 'experiment', parent: { title: 'Step 2' }, axes, stalled: true });
  assert.match(stall.text, /Explore rather than refine/);
  assert.equal(stall.source, 'stall');
});
