// ─────────────────────────────────────────────────────────────────────────────
// local.mjs — capture on this machine, in the host browser.
//
// This backend offers NO isolation. The controller uses it for candidates that
// change configuration only. A candidate that changes source code needs the
// container backend.
// ─────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright-core';

import { captureSamples, CaptureError } from './browser.mjs';

const CHANNELS = ['chrome', 'msedge'];

/** Find a browser this machine already has. playwright-core downloads nothing. */
export async function detectBrowser({ channel, executablePath } = {}) {
  const problems = [];
  const candidates = channel ? [channel] : CHANNELS;
  for (const candidate of candidates) {
    try {
      const browser = await chromium.launch({ channel: candidate, headless: true });
      const version = browser.version();
      await browser.close();
      return { available: true, channel: candidate, executablePath: null, version, detail: `${candidate} ${version}` };
    } catch (error) {
      problems.push(`${candidate}: ${String(error.message).split('\n')[0]}`);
    }
  }

  // A Linux server has no branded channel. Use an explicit path, or the
  // Chromium that playwright or the distribution provides.
  try {
    const options = executablePath ? { executablePath, headless: true } : { headless: true };
    const browser = await chromium.launch(options);
    const version = browser.version();
    await browser.close();
    return {
      available: true,
      channel: null,
      executablePath: executablePath ?? null,
      version,
      detail: `${executablePath ?? 'default chromium'} ${version}`,
    };
  } catch (error) {
    problems.push(`default chromium: ${String(error.message).split('\n')[0]}`);
  }

  return { available: false, channel: null, executablePath: null, version: null, detail: problems.join('; ') || 'no browser answered' };
}

export function createLocalCapture({ config, logger = () => {} }) {
  // Detection launches a browser to read its version. Do it once, and only
  // again after a failure.
  let detected = null;

  const detect = async () => {
    if (!detected) detected = await detectBrowser({ channel: config.capture.browserChannel, executablePath: config.capture.browserExecutable });
    return detected;
  };

  return {
    backend: 'local',

    async available() {
      return detect();
    },

    async capture({ liveBaseUrl, samples, viewport, timestep, outDir, sourceHash, configurationHash, signal }) {
      const detection = await detect();
      if (!detection.available) {
        detected = null;
        throw new CaptureError('capture_unavailable', `No local browser is usable: ${detection.detail}`, { backend: 'local' });
      }
      let browser;
      try {
        browser = await chromium.launch({
          channel: detection.channel ?? undefined,
          executablePath: detection.executablePath ?? undefined,
          headless: config.capture.headless,
        });
      } catch (error) {
        detected = null;
        throw new CaptureError('capture_unavailable', `The browser did not start: ${error.message.split('\n')[0]}`, { backend: 'local' });
      }
      try {
        logger('info', `Capturing ${samples.length} frame(s) with ${detection.detail}`);
        return await captureSamples({
          browser,
          baseUrl: liveBaseUrl,
          samples,
          viewport,
          timestep,
          timeoutMs: config.capture.captureTimeoutMs,
          outDir,
          sourceHash,
          configurationHash,
          signal,
        });
      } finally {
        await browser.close().catch(() => {});
      }
    },
  };
}
