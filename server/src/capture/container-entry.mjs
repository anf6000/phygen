// ─────────────────────────────────────────────────────────────────────────────
// container-entry.mjs — the capture worker that runs INSIDE the container.
//
// The container has no network, no credentials, no write access to the version
// snapshot, and a small CPU and memory budget. It reads one job from
// PHYGEN_CAPTURE_JOB, writes the images, and prints the result as JSON.
// ─────────────────────────────────────────────────────────────────────────────
import { readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

import { captureSamples } from './browser.mjs';
import { startArtifactServer } from './static.mjs';

const CHROMIUM = process.env.PHYGEN_CHROMIUM || '/usr/bin/chromium';

async function main() {
  const raw = await readFile(process.env.PHYGEN_CAPTURE_JOB, 'utf8');
  const job = JSON.parse(raw);

  const server = await startArtifactServer({
    snapshotDir: job.snapshotDir,
    runtimeDir: job.runtimeDir,
    nodeModulesDir: job.nodeModulesDir,
  });

  const browser = await chromium.launch({
    executablePath: CHROMIUM,
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--use-gl=swiftshader', '--disable-gpu-sandbox'],
  });

  try {
    const results = await captureSamples({
      browser,
      baseUrl: server.url,
      samples: job.samples,
      viewport: job.viewport,
      timestep: job.timestep,
      timeoutMs: job.timeoutMs,
      outDir: job.outDir,
      sourceHash: job.sourceHash,
      configurationHash: job.configurationHash,
    });
    await writeFile(
      process.env.PHYGEN_CAPTURE_RESULT || '/captures/result.json',
      `${JSON.stringify({ ok: true, results }, null, 2)}\n`,
      'utf8',
    );
    process.stdout.write(`${JSON.stringify({ ok: true, results })}\n`);
  } finally {
    await browser.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

main().catch((error) => {
  const failure = { ok: false, code: error.code ?? 'capture_failed', message: error.message, details: error.details ?? {} };
  process.stdout.write(`${JSON.stringify(failure)}\n`);
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
