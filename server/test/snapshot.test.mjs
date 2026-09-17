// Snapshot publication: the directory name, the marker, the returned value and
// the version record must all name the same content hash, and an existing
// directory is reused only after its files are verified.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { CANONICAL_MAP_NAME, publishSnapshot } from '../src/artwork/workspace.mjs';
import { verifySnapshot } from '../src/artwork/snapshot-integrity.mjs';
import { hashPackageFiles, walkPackage } from '../../runtime/node/package-checks.js';

async function tempDir(t) {
  const dir = await mkdtemp(join(tmpdir(), 'phygen-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeWorkspace(root, files = { 'src/main.js': 'export default 1;\n', 'config.json': '{"palette":"white"}\n' }) {
  const dir = join(root, 'workspace');
  for (const [path, body] of Object.entries(files)) {
    const full = join(dir, path);
    await mkdir(join(full, '..'), { recursive: true });
    await writeFile(full, body, 'utf8');
  }
  return dir;
}

async function packageHashOf(dir) {
  const walked = (await walkPackage(dir)).filter((file) => !file.symlink);
  const { packageHash } = await hashPackageFiles(walked);
  return packageHash;
}

test('a publication names one canonical hash everywhere', async (t) => {
  const root = await tempDir(t);
  const workspace = await makeWorkspace(root);
  const snapshots = join(root, 'snapshots');
  const requested = await packageHashOf(workspace);

  const first = await publishSnapshot({ workspaceDir: workspace, snapshotRoot: snapshots, artworkId: 'a1', packageHash: requested });
  assert.equal(first.created, true);
  assert.equal(first.packageHash, requested);
  assert.equal(first.verified, true);
  assert.equal(first.path, join(snapshots, 'a1', requested));

  const marker = JSON.parse(await readFile(join(first.path, 'snapshot.json'), 'utf8'));
  assert.equal(marker.packageHash, requested, 'the marker names the canonical hash');

  const verdict = await verifySnapshot(first.path, { expectedHash: requested });
  assert.equal(verdict.state, 'ok');
  assert.equal(verdict.contentsHash, requested);
});

test('a second publication of the same content reuses the verified directory', async (t) => {
  const root = await tempDir(t);
  const workspace = await makeWorkspace(root);
  const snapshots = join(root, 'snapshots');
  const requested = await packageHashOf(workspace);

  await publishSnapshot({ workspaceDir: workspace, snapshotRoot: snapshots, artworkId: 'a1', packageHash: requested });
  const second = await publishSnapshot({ workspaceDir: workspace, snapshotRoot: snapshots, artworkId: 'a1', packageHash: requested });
  assert.equal(second.created, false);
  assert.equal(second.verified, true);
  assert.equal(second.packageHash, requested);
});

test('concurrent publications of one hash leave one complete snapshot', async (t) => {
  const root = await tempDir(t);
  const workspace = await makeWorkspace(root);
  const snapshots = join(root, 'snapshots');
  const requested = await packageHashOf(workspace);

  const results = await Promise.all(
    Array.from({ length: 4 }, () => publishSnapshot({ workspaceDir: workspace, snapshotRoot: snapshots, artworkId: 'a1', packageHash: requested })),
  );
  for (const result of results) assert.equal(result.packageHash, requested);
  assert.equal(results.filter((result) => result.created).length, 1, 'exactly one publication creates the directory');

  const verdict = await verifySnapshot(join(snapshots, 'a1', requested), { expectedHash: requested });
  assert.equal(verdict.state, 'ok');
  assert.equal(verdict.problems.length, 0);
  const marker = JSON.parse(await readFile(join(snapshots, 'a1', requested, 'snapshot.json'), 'utf8'));
  assert.equal(marker.files.length, 2, 'no file is lost to a competing temporary directory');
});

test('a publication refuses a workspace that does not hash to the request', async (t) => {
  const root = await tempDir(t);
  const workspace = await makeWorkspace(root);
  const snapshots = join(root, 'snapshots');
  await assert.rejects(
    publishSnapshot({ workspaceDir: workspace, snapshotRoot: snapshots, artworkId: 'a1', packageHash: 'f'.repeat(64) }),
    (error) => error.code === 'snapshot_hash_mismatch',
  );
});

test('a legacy marker is reported and mapped, never rewritten', async (t) => {
  const root = await tempDir(t);
  const workspace = await makeWorkspace(root);
  const snapshots = join(root, 'snapshots');
  const requested = await packageHashOf(workspace);

  const published = await publishSnapshot({ workspaceDir: workspace, snapshotRoot: snapshots, artworkId: 'a1', packageHash: requested });
  // A publication of an older version wrote the hash of the `files/…` paths.
  const legacyHash = 'a'.repeat(64);
  const markerPath = join(published.path, 'snapshot.json');
  const marker = JSON.parse(await readFile(markerPath, 'utf8'));
  marker.packageHash = legacyHash;
  await writeFile(markerPath, `${JSON.stringify(marker, null, 2)}\n`, 'utf8');

  const verdict = await verifySnapshot(published.path, { expectedHash: requested });
  assert.equal(verdict.state, 'hash_mismatch');
  assert.equal(verdict.contentsHash, requested, 'the real content hash is the canonical one');

  const reused = await publishSnapshot({ workspaceDir: workspace, snapshotRoot: snapshots, artworkId: 'a1', packageHash: requested });
  assert.equal(reused.created, false);
  assert.equal(reused.verified, false);
  assert.equal(reused.legacyMarkerHash, legacyHash);
  assert.equal(reused.packageHash, requested);

  const after = JSON.parse(await readFile(markerPath, 'utf8'));
  assert.equal(after.packageHash, legacyHash, 'the historical marker is not rewritten');
  const mapped = JSON.parse(await readFile(join(snapshots, 'a1', CANONICAL_MAP_NAME), 'utf8'));
  assert.equal(mapped[requested].markerHash, legacyHash);
  assert.equal(mapped[requested].contentsHash, requested);
});
