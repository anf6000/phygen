// ─────────────────────────────────────────────────────────────────────────────
// browser.mjs — drive the artwork page and record images.
//
// The same code runs on the host and inside a container. One page is used per
// sample, so every image comes from a fresh, identical initialization.
//
// A page that fails to initialize is a failed candidate. The capture never
// silently keeps an earlier image.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ArtworkError } from '../../../runtime/contract.js';

const CONSOLE_ERROR_LIMIT = 100;

export class CaptureError extends ArtworkError {
  constructor(code, message, details) {
    super(code, message, details);
    this.name = 'CaptureError';
  }
}

/**
 * Race a promise against a wall-clock deadline.
 *
 * A page that runs an endless loop blocks its own main thread, and a timeout
 * inside that page can never fire. The deadline here runs in Node, so the
 * capture always ends, and `onTimeout` tears the browser context down.
 */
function withDeadline(promise, ms, onTimeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        onTimeout?.();
      } catch {
        // the teardown must never hide the timeout
      }
      reject(new CaptureError('capture_timeout', `The capture passed its time limit of ${ms} ms`, { limitMs: ms }));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * @param {object} options
 * @param {import('playwright-core').Browser} options.browser
 * @param {string} options.baseUrl             the live artwork URL for one version
 * @param {object[]} options.samples           [{ stage, step, seed }]
 * @param {{width:number,height:number,dpr:number}} options.viewport
 * @param {number} options.timestep            simulation steps per rendered frame
 * @param {number} options.timeoutMs
 * @param {string} options.outDir              where the images are written
 * @param {string} options.sourceHash
 * @param {string} options.configurationHash
 * @param {AbortSignal} [options.signal]
 */
export async function captureSamples({
  browser,
  baseUrl,
  samples,
  viewport,
  timestep,
  timeoutMs,
  outDir,
  sourceHash,
  configurationHash,
  signal,
}) {
  await mkdir(outDir, { recursive: true });
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    deviceScaleFactor: viewport.dpr,
    bypassCSP: false,
  });
  const results = [];

  // A capture that hangs must never hold the run. The deadline covers every
  // sample, and closing the context kills a wedged renderer.
  const perSampleMs = Math.max(30000, timeoutMs);
  const deadlineMs = perSampleMs * Math.max(1, samples.length) + 30000;

  const captureAll = async () => {
    for (const sample of samples) {
      if (signal?.aborted) throw new CaptureError('capture_cancelled', 'The capture was cancelled', { stage: sample.stage });
      const url = `${baseUrl}?steps=${sample.step}&seed=${sample.seed}&speed=${timestep}&paused=0&dpr=${viewport.dpr}`;
      const page = await context.newPage();
      const startedAt = Date.now();
      const consoleErrors = [];
      const recordConsole = (text) => {
        // A candidate page can log without limit. Keep a useful sample only.
        if (consoleErrors.length < CONSOLE_ERROR_LIMIT) consoleErrors.push(text);
        else droppedConsoleErrors++;
      };
      let droppedConsoleErrors = 0;
      page.on('pageerror', (error) => recordConsole(String(error?.message ?? error)));
      page.on('console', (message) => {
        if (message.type() === 'error') recordConsole(message.text());
      });

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
        await page
          .waitForFunction(() => window.__failed === true || window.__done === true || window.__ready === true, null, {
            timeout: 30000,
          })
          .catch(() => {});

        const failure = await page.evaluate(() => window.__error ?? null);
        if (failure) {
          throw new CaptureError('capture_load_failed', `The artwork stopped with ${failure.code}: ${failure.message}`, {
            stage: sample.stage,
            step: sample.step,
            seed: sample.seed,
            artworkError: failure,
          });
        }

        await page.waitForFunction(() => window.__done === true, null, { timeout: timeoutMs });
        const snapshot = await page.evaluate(() => ({
          state: window.__state ?? null,
          artwork: typeof window.__artwork?.getState === 'function' ? window.__artwork.getState() : null,
        }));

        const path = join(outDir, `${sample.stage}-s${sample.seed}-n${sample.step}.png`);
        await mkdir(dirname(path), { recursive: true });
        await page.screenshot({
          path,
          clip: { x: 0, y: 0, width: viewport.width, height: viewport.height },
        });
        await page.close();

        results.push({
          ...sample,
          path,
          url,
          durationMs: Date.now() - startedAt,
          width: viewport.width,
          height: viewport.height,
          dpr: viewport.dpr,
          timestep,
          sourceHash,
          configurationHash,
          rendererBackend: snapshot.artwork?.renderer?.unmasked ?? snapshot.artwork?.renderer?.renderer ?? null,
          rendererVersion: snapshot.artwork?.renderer?.version ?? null,
          trailChecksum: snapshot.artwork?.trailChecksum ?? null,
          agentChecksum: snapshot.artwork?.agentChecksum ?? null,
          iteration: snapshot.state?.iteration ?? sample.step,
          fps: snapshot.state?.fps ?? null,
          consoleErrors,
        });
      } catch (error) {
        await page.close().catch(() => {});
        if (error instanceof CaptureError) throw error;
        throw new CaptureError('capture_failed', `The capture of ${sample.stage} failed: ${error.message}`, {
          stage: sample.stage,
          step: sample.step,
          seed: sample.seed,
          url,
          consoleErrors,
        });
      }
    }
  };

  try {
    await withDeadline(captureAll(), deadlineMs, () => {
      void context.close().catch(() => {});
    });
  } finally {
    await context.close().catch(() => {});
  }

  return results;
}
