import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import {
  classifyPackageFile,
  collectManifestPathProblems,
  isSafeRelativePath,
  pathIsCovered,
  validateManifest,
} from '../../runtime/manifest.js';

const PACKAGE_DIR = fileURLToPath(new URL('..', import.meta.url));
const VALIDATE_TOOL = fileURLToPath(new URL('../tools/validate-package.mjs', import.meta.url));
const SNAPSHOT_TOOL = fileURLToPath(new URL('../tools/snapshot.mjs', import.meta.url));
const REAL_MANIFEST = JSON.parse(await readFile(join(PACKAGE_DIR, 'manifest.json'), 'utf8'));

const STUB_ADAPTER = [
  "export const contractVersion = '1.0.0';",
  'export class StubArtwork {',
  ...['initialize', 'reset', 'step', 'render', 'resize', 'getState', 'dispose'].map((name) => `  ${name}() {}`),
  '}',
  'export default async function createArtwork() { return new StubArtwork(); }',
  '',
].join('\n');

function stubManifest(overrides = {}) {
  return {
    manifestVersion: 1,
    id: 'stub-artwork',
    title: 'Stub artwork',
    contractVersion: '1.0.0',
    entry: 'src/adapter.js',
    configuration: { baseline: 'config.json', schema: 'config.schema.json' },
    allowedEditPaths: ['src/', 'config.json'],
    protectedPaths: ['manifest.json', 'package.json', 'package-lock.json', 'config.schema.json', 'src/adapter.js'],
    pinnedDependencies: [],
    resourceLimits: {
      maxPackageBytes: 1048576,
      maxFiles: 20,
      maxAgents: 100,
      maxTrailPixels: 65536,
      maxStepsPerEvaluation: 10,
      maxPlaybackSteps: 100,
    },
    evaluation: {
      viewport: { width: 8, height: 8, dpr: 1 },
      seedCount: 2,
      captureStages: { candidates: ['early'], finalist: ['early', 'dense'] },
      requiredMetadata: ['frameId'],
    },
    browserCapabilities: { canvas: true, webgl2: true, requiredExtensions: [] },
    assets: [],
    licenses: [],
    ...overrides,
  };
}

function runTool(tool, args) {
  const result = spawnSync(process.execPath, [tool, ...args], { encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
}

async function writeStubPackage(t, { manifest = stubManifest(), extraFiles = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'phygen-package-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = {
    'manifest.json': JSON.stringify(manifest, null, 2),
    'config.json': JSON.stringify({ num: 5 }, null, 2),
    'config.schema.json': JSON.stringify(
      {
        type: 'object',
        additionalProperties: false,
        required: ['num'],
        properties: { num: { type: 'integer', minimum: 1, maximum: 10 } },
      },
      null,
      2,
    ),
    'package.json': JSON.stringify({ name: 'stub-artwork', version: '1.0.0', type: 'module', dependencies: {} }, null, 2),
    'package-lock.json': JSON.stringify(
      { name: 'stub-artwork', lockfileVersion: 3, packages: { '': { name: 'stub-artwork', version: '1.0.0' } } },
      null,
      2,
    ),
    'src/adapter.js': STUB_ADAPTER,
    ...extraFiles,
  };
  for (const [name, body] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, body, 'utf8');
  }
  return dir;
}

test('the physarum manifest is valid and its paths agree', () => {
  const result = validateManifest(REAL_MANIFEST);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(collectManifestPathProblems(REAL_MANIFEST), []);
});

test('the physarum package passes validation', () => {
  const result = runTool(VALIDATE_TOOL, ['--package', PACKAGE_DIR]);
  assert.match(result.stdout, /package validation passed/);
  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test('a small package passes validation', async (t) => {
  const dir = await writeStubPackage(t);
  const result = runTool(VALIDATE_TOOL, ['--package', dir]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /provides every contract method/);
});

test('an undeclared file fails validation', async (t) => {
  const dir = await writeStubPackage(t, { extraFiles: { 'notes/scratch.txt': 'hello' } });
  const result = runTool(VALIDATE_TOOL, ['--package', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /notes\/scratch\.txt is neither editable nor protected/);
});

test('too many files fail validation', async (t) => {
  const manifest = stubManifest();
  manifest.resourceLimits.maxFiles = 1;
  const dir = await writeStubPackage(t, { manifest });
  const result = runTool(VALIDATE_TOOL, ['--package', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /the limit is 1/);
});

test('a baseline that breaks its own schema fails validation', async (t) => {
  const dir = await writeStubPackage(t, { extraFiles: { 'config.json': JSON.stringify({ num: 99 }) } });
  const result = runTool(VALIDATE_TOOL, ['--package', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /config\.json \$\.num must be <= 10/);
});

test('a dependency that the lock file does not pin exactly fails validation', async (t) => {
  const manifest = stubManifest({ pinnedDependencies: [{ name: 'three', version: '0.170.0' }] });
  const dir = await writeStubPackage(t, {
    manifest,
    extraFiles: {
      'package.json': JSON.stringify({ name: 'stub-artwork', version: '1.0.0', type: 'module', dependencies: { three: '0.170.0' } }),
      'package-lock.json': JSON.stringify({
        name: 'stub-artwork',
        lockfileVersion: 3,
        packages: { '': { name: 'stub-artwork', version: '1.0.0' }, 'node_modules/three': { version: '0.171.0' } },
      }),
    },
  });
  const result = runTool(VALIDATE_TOOL, ['--package', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /pinned to 0\.170\.0 in the manifest, but package-lock\.json has 0\.171\.0/);
});

test('an unapproved dependency fails validation', async (t) => {
  const dir = await writeStubPackage(t, {
    extraFiles: {
      'package.json': JSON.stringify({ name: 'stub-artwork', version: '1.0.0', type: 'module', dependencies: { lodash: '4.17.21' } }),
    },
  });
  const result = runTool(VALIDATE_TOOL, ['--package', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /does not approve it/);
});

test('a package that declares its entry as editable fails validation', async (t) => {
  const dir = await writeStubPackage(t, { manifest: stubManifest({ allowedEditPaths: ['src/'], protectedPaths: [] }) });
  const result = runTool(VALIDATE_TOOL, ['--package', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /must be protected, but it is editable/);
});

test('a symbolic link fails validation', async (t) => {
  const dir = await writeStubPackage(t);
  try {
    await symlink(join(dir, 'config.json'), join(dir, 'src', 'link.json'), 'file');
  } catch (error) {
    t.skip(`symbolic links are not available here (${error.code})`);
    return;
  }
  const result = runTool(VALIDATE_TOOL, ['--package', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /symbolic link/);
});

test('the snapshot tool records one immutable snapshot', async (t) => {
  const out = await mkdtemp(join(tmpdir(), 'phygen-snapshots-'));
  t.after(() => rm(out, { recursive: true, force: true }));

  const first = runTool(SNAPSHOT_TOOL, ['--package', PACKAGE_DIR, '--out', out]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  const match = /snapshot recorded: (.+)/.exec(first.stdout);
  assert.ok(match, first.stdout);
  const target = match[1].trim();

  const second = runTool(SNAPSHOT_TOOL, ['--package', PACKAGE_DIR, '--out', out]);
  assert.equal(second.status, 0);
  assert.match(second.stdout, /already recorded/);
});

test('path rules reject unsafe entries and accept safe ones', () => {
  for (const good of ['src/a.js', 'src/', 'config.json', './src/a.js']) {
    assert.equal(isSafeRelativePath(good), true, good);
  }
  for (const bad of ['../outside.js', '/etc/passwd', 'C:\\windows\\x.js', 'src\\a.js', 'src/../a.js', '']) {
    assert.equal(isSafeRelativePath(bad), false, bad);
  }
  assert.equal(pathIsCovered('src/physarum.js', ['src/']), true);
  assert.equal(pathIsCovered('src/physarum.js', ['src/renderer.js']), false);
  assert.equal(pathIsCovered('config.json', ['config.json']), true);
  assert.equal(classifyPackageFile('src/physarum.js', REAL_MANIFEST), 'editable');
  assert.equal(classifyPackageFile('config.json', REAL_MANIFEST), 'editable');
  assert.equal(classifyPackageFile('src/adapter.js', REAL_MANIFEST), 'protected');
  assert.equal(classifyPackageFile('config.schema.json', REAL_MANIFEST), 'protected');
  assert.equal(classifyPackageFile('secret/key.pem', REAL_MANIFEST), 'undeclared');
});

test('a manifest with an unsafe edit path is rejected', () => {
  const manifest = stubManifest({ allowedEditPaths: ['../outside/'] });
  const problems = collectManifestPathProblems(manifest);
  assert.ok(problems.some((problem) => /unsafe path/.test(problem)));
});
