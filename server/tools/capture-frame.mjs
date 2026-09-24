// ─────────────────────────────────────────────────────────────────────────────
// capture-frame.mjs — operator: capture the frame of one version without a run.
//
//   node tools/capture-frame.mjs --version <id> [--force]
//
// The capture API records frames against a run, so a version outside any run
// (the imported root after a reset) has no capture path in the API. This tool
// runs the same capture pipeline directly and records the frames with no run.
//
// The frame uses the CURRENT configured schedule. With --force, the older
// captures of the version are removed first, so the version holds only frames
// of the current schedule.
//
// Stop the server first: the tool starts the artwork origin itself.
// ─────────────────────────────────────────────────────────────────────────────
import { rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { createRuntime } from '../src/index.mjs';
import { sha256Hex, stableStringify } from '../src/util.mjs';

const CAPTURE_TIMESTEP = 8;

function arg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

const versionId = arg('--version');
if (!versionId) {
  console.error('Usage: node tools/capture-frame.mjs --version <id> [--force]');
  process.exit(1);
}
const force = process.argv.includes('--force');

const config = loadConfig();
const runtime = await createRuntime({}, { withApp: false, withLive: true });
const { store, capture, artifacts } = runtime;

try {
  const version = store.getVersion(versionId);
  if (!version) throw new Error(`No version ${versionId}`);
  const artwork = store.getArtwork(version.artworkId);
  if (!artwork) throw new Error(`Version ${versionId} names no artwork`);

  const existing = store.listCaptures(version.id);
  if (existing.length > 0 && !force) {
    console.log(`Version ${versionId} already holds ${existing.length} capture(s). Use --force to replace them.`);
    process.exit(0);
  }
  for (const old of existing) {
    rmSync(old.path, { force: true });
    store.db.prepare('DELETE FROM captures WHERE id = ?').run(old.id);
    console.log(`removed capture ${old.id} (${old.stage}, step ${old.step})`);
  }

  const steps = config.evolution.stepSchedule;
  const samples = [];
  for (const seed of config.evolution.seeds) {
    config.evolution.frameRoles.forEach((stage, index) => {
      samples.push({ stage, step: steps[Math.min(index, steps.length - 1)], seed });
    });
  }

  const configurationHash = sha256Hex(stableStringify(version.configuration));
  const outDir = join(config.dataDir, 'captures', version.id);
  console.log(`Capturing ${samples.length} frame(s) for ${versionId} at step ${samples.map((s) => s.step).join(', ')}...`);

  const results = await capture.capture({
    liveBaseUrl: artifacts.liveUrlFor(version.id),
    snapshotDir: artifacts.snapshotDirFor(version),
    runtimeDir: artifacts.runtimeDir,
    nodeModulesDir: artifacts.nodeModulesDir(version.workspacePath ? resolve(version.workspacePath) : resolve(config.repoRoot, artwork.packagePath)),
    samples,
    viewport: config.evolution.viewport,
    timestep: CAPTURE_TIMESTEP,
    outDir,
    sourceHash: version.sourceHash,
    configurationHash,
  });

  for (const result of results) {
    const record = store.createCapture({
      versionId: version.id,
      runId: null,
      stage: result.stage,
      seed: result.seed,
      step: result.step,
      width: result.width,
      height: result.height,
      dpr: result.dpr,
      rendererBackend: result.rendererBackend,
      sourceHash: version.sourceHash,
      configurationHash,
      path: result.path,
      bytes: statSync(result.path).size,
      meta: {
        url: result.url,
        fps: result.fps,
        iteration: result.iteration,
        trailChecksum: result.trailChecksum,
        agentChecksum: result.agentChecksum,
        timestep: result.timestep,
        consoleErrors: result.consoleErrors,
      },
    });
    console.log(`captured ${record.id}: ${record.stage} step ${record.step} -> ${record.path}`);
  }
} finally {
  await runtime.live?.close().catch(() => {});
  store.close();
}
