// ─────────────────────────────────────────────────────────────────────────────
// recorder.mjs — record the interface while a run works.
//
// The documentation tickbox starts this recorder. It opens the interface in a
// browser of its own and writes one PNG per second into
// docs/recordings/<timestamp>/. When the run reaches a terminal state it stops
// and encodes the frames into a LOSSLESS mp4 in docs/videos/.
//
// Lossless here means H.264 with a quantiser of zero and no chroma
// subsampling (yuv444p), so the video keeps every pixel of the PNGs.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { chromium } from 'playwright-core';

const FRAME_SECONDS = 1;
const VIEWPORT = { width: 1700, height: 1020 };

function stamp() {
  return new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
}

function run(command, args, { timeoutMs = 600000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

export class UiRecorder {
  constructor({ store, config, logger = () => {} }) {
    this.store = store;
    this.config = config;
    this.logger = logger;
    this.state = { active: false, runId: null, folder: null, frames: 0, video: null, error: null };
    this.browser = null;
    this.timer = null;
    this.outDir = join(config.repoRoot, 'docs', 'recordings');
    this.videoDir = join(config.repoRoot, 'docs', 'videos');
    this.ffmpeg = config.recording.ffmpeg;
  }

  status() {
    return { ...this.state };
  }

  /** Start recording. One PNG per second, until stop() or the run ends. */
  async start({ runId, url }) {
    if (this.state.active) return this.status();
    const name = `${stamp()}_${runId}`;
    const folder = join(this.outDir, name);
    await mkdir(folder, { recursive: true });

    this.browser = await chromium.launch({ channel: this.config.capture.browserChannel || 'chrome', headless: true });
    const context = await this.browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'load', timeout: 45000 }).catch(() => {});

    this.state = { active: true, runId, folder, name, frames: 0, video: null, error: null };
    this.logger('info', `Recording the interface to ${folder}`);

    const tick = async () => {
      if (!this.state.active) return;
      try {
        const frame = String(this.state.frames + 1).padStart(5, '0');
        await page.screenshot({ path: join(folder, `frame-${frame}.png`) });
        this.state.frames += 1;
        if (!this.state.runId || this.#runFinished(this.state.runId)) {
          await this.stop({ reason: 'run finished' });
          return;
        }
      } catch (error) {
        this.state.error = String(error.message ?? error);
        await this.stop({ reason: 'capture failed' });
        return;
      }
      this.timer = setTimeout(() => void tick(), FRAME_SECONDS * 1000);
    };
    this.timer = setTimeout(() => void tick(), 500);
    return this.status();
  }

  #runFinished(runId) {
    const run = this.store.getRun(runId);
    if (!run) return true;
    return ['stopped', 'completed', 'failed'].includes(run.state);
  }

  /** Stop the recording and encode the frames. */
  async stop({ reason = 'requested' } = {}) {
    if (!this.state.active) return this.status();
    this.state.active = false;
    clearTimeout(this.timer);
    this.timer = null;

    await this.browser?.close().catch(() => {});
    this.browser = null;

    const frames = this.state.frames;
    const folder = this.state.folder;
    const name = this.state.name;
    this.logger('info', `Recording stopped after ${frames} frame(s): ${reason}`);

    if (frames >= 2) {
      const video = await this.#encode({ folder, name });
      this.state.video = video;
    } else {
      this.logger('warn', 'Fewer than two frames were saved, so no video was written.');
    }
    return this.status();
  }

  /** Encode the frames into a lossless mp4. */
  async #encode({ folder, name }) {
    if (!this.ffmpeg) {
      this.state.error = 'ffmpeg is not configured, so no video was written';
      this.logger('warn', this.state.error);
      return null;
    }
    await mkdir(this.videoDir, { recursive: true });
    const output = join(this.videoDir, `${name}.mp4`);
    // -qp 0 with yuv444p keeps every pixel: no chroma subsampling, no quantiser.
    const result = await run(this.ffmpeg, [
      '-y',
      '-hide_banner',
      '-loglevel', 'error',
      '-framerate', String(1 / FRAME_SECONDS),
      '-i', join(folder, 'frame-%05d.png'),
      '-c:v', 'libx264',
      '-qp', '0',
      '-pix_fmt', 'yuv444p',
      output,
    ]);
    if (result.code !== 0) {
      this.state.error = `ffmpeg failed: ${result.stderr.trim().split('\n').slice(-1)[0] ?? 'unknown'}`;
      this.logger('warn', this.state.error);
      return null;
    }
    this.logger('info', `Video written: ${output}`);
    return output;
  }

  /** Remove recordings older than a number of days. */
  async prune({ keepDays = 14 } = {}) {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    for (const entry of await readdir(this.outDir, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const created = Date.parse(entry.name.slice(0, 19).replace('_', 'T').replace(/-(\d\d)-(\d\d)$/, ':$1:$2'));
      if (Number.isFinite(created) && created < cutoff) {
        await rm(join(this.outDir, entry.name), { recursive: true, force: true }).catch(() => {});
      }
    }
  }
}
