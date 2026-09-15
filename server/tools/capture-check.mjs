// ─────────────────────────────────────────────────────────────────────────────
// capture-check.mjs — measure one capture on this machine.
//
//   node tools/capture-check.mjs --version <versionId> [--steps 60,300,1200]
//                                [--seeds 1337,7] [--width 768] [--height 768]
//                                [--backend local|docker]
//
// The plan requires measured numbers before the interface is trusted:
// capture duration, image size, renderer backend, and image differences between
// seeds. This tool prints them and writes nothing else.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/db.mjs';
import { createArtifacts } from '../src/artifacts.mjs';
import { createCapture, captureStatus } from '../src/capture/index.mjs';

function parseArgs(argv) {
  const options = { steps: [60, 300, 1200], seeds: [1337, 7], width: 768, height: 768, backend: null, versionId: null };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--version') options.versionId = value;
    else if (key === '--steps') options.steps = value.split(',').map(Number).filter(Number.isFinite);
    else if (key === '--seeds') options.seeds = value.split(',').map(Number).filter(Number.isFinite);
    else if (key === '--width') options.width = Number(value);
    else if (key === '--height') options.height = Number(value);
    else if (key === '--backend') options.backend = value;
    else continue;
    index++;
  }
  return options;
}

/** Mean absolute difference between two files, as a rough image difference. */
async function difference(a, b) {
  const [first, second] = [await readFile(a), await readFile(b)];
  const length = Math.min(first.length, second.length);
  let total = 0;
  for (let index = 0; index < length; index++) total += Math.abs(first[index] - second[index]);
  return {
    mean: length > 0 ? total / length : 0,
    bytesA: first.length,
    bytesB: second.length,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig(options.backend ? { capture: { backend: options.backend } } : {});
  const store = new Store(join(config.dataDir, 'phygen.db'));

  const versionId = options.versionId ?? store.listVersions(store.listArtworks()[0]?.id ?? '').slice(-1)[0]?.id;
  const version = versionId ? store.getVersion(versionId) : null;
  if (!version) {
    console.error('capture-check: no version found. Pass --version <versionId>.');
    store.close();
    process.exitCode = 1;
    return;
  }

  const artifacts = createArtifacts({ store, config });
  const capture = await createCapture({ config, logger: () => {} });
  const status = await captureStatus({ config });
  const work = await mkdtemp(join(tmpdir(), 'phygen-capture-check-'));

  console.log(`version   ${version.id} (${version.status})`);
  console.log(`source    ${version.sourceHash.slice(0, 16)}…`);
  console.log(`backend   ${status.backend} (isolated: ${status.isolated ? 'yes' : 'no'}) — ${status.detail}`);
  console.log(`viewport  ${options.width}x${options.height} dpr ${config.evolution.viewport.dpr}`);
  console.log('');
  console.log('stage   seed   step   ms      bytes    trailChecksum  renderer');

  const samples = [];
  for (const seed of options.seeds) {
    for (const step of options.steps) samples.push({ stage: `step-${step}`, step, seed });
  }

  const started = Date.now();
  let results;
  try {
    results = await capture.capture({
      liveBaseUrl: artifacts.liveUrlFor(version.id),
      snapshotDir: artifacts.snapshotDirFor(version),
      runtimeDir: artifacts.runtimeDir,
      nodeModulesDir: artifacts.nodeModulesDir(join(config.repoRoot, 'threejs')),
      samples,
      viewport: { width: options.width, height: options.height, dpr: config.evolution.viewport.dpr },
      timestep: 8,
      outDir: work,
      sourceHash: version.sourceHash,
      configurationHash: 'capture-check',
    });
  } catch (error) {
    console.error(`capture-check failed: ${error.code ?? 'error'} ${error.message}`);
    await rm(work, { recursive: true, force: true }).catch(() => {});
    store.close();
    process.exitCode = 1;
    return;
  }

  const bySample = new Map(results.map((result) => [`${result.seed}|${result.step}`, result]));
  for (const sample of samples) {
    const result = bySample.get(`${sample.seed}|${sample.step}`);
    if (!result) continue;
    const info = await stat(result.path);
    console.log(
      [
        result.stage.padEnd(7),
        String(result.seed).padEnd(6),
        String(result.step).padEnd(6),
        String(result.durationMs ?? '—').padEnd(7),
        String(info.size).padEnd(8),
        String(result.trailChecksum ?? '—').padEnd(14),
        result.rendererBackend ?? 'unknown',
      ].join(' '),
    );
  }

  const totalMs = Date.now() - started;
  console.log('');
  console.log(`frames    ${results.length}`);
  console.log(`total     ${totalMs} ms (${Math.round(totalMs / Math.max(1, results.length))} ms per frame, sequential)`);

  // Repeatability: the same seed and step must give the same trail checksum.
  const repeats = new Map();
  for (const result of results) {
    const key = `${result.seed}|${result.step}`;
    repeats.set(key, [...(repeats.get(key) ?? []), result.trailChecksum]);
  }
  const repeatable = [...repeats.entries()].filter(([, values]) => values.length > 1 && new Set(values).size === 1);
  console.log(`checksums ${results.length} frame(s), ${repeatable.length} repeated key(s) matched`);

  const seedA = results.find((result) => result.seed === options.seeds[0]);
  const seedB = results.find((result) => result.seed === options.seeds[1]);
  if (seedA && seedB) {
    const diff = await difference(seedA.path, seedB.path);
    console.log(
      `seeds     ${options.seeds[0]} vs ${options.seeds[1]} at step ${seedA.step}: mean byte difference ${diff.mean.toFixed(2)}`,
    );
  }

  console.log(`images    ${work}`);
  store.close();
}

main().catch((error) => {
  console.error(`capture-check failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
