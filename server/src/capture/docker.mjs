// ─────────────────────────────────────────────────────────────────────────────
// docker.mjs — capture inside a restricted Linux container.
//
// This is the only backend that may run candidate source code. The container
// has no network, no credentials, no host directory access, and no docker
// socket. It is non-root, read-only, and bounded by CPU, memory, process count,
// and time.
//
// When the docker daemon does not answer, this backend reports itself as
// unavailable and the controller refuses to build source-code candidates.
// ─────────────────────────────────────────────────────────────────────────────
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CaptureError } from './browser.mjs';

function run(command, args, { timeoutMs = 60000, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const onAbort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

export async function detectDocker({ config }) {
  const result = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20000 });
  if (result.code !== 0) {
    return { available: false, version: null, detail: result.stderr.trim().split('\n')[0] || 'the docker daemon did not answer' };
  }
  const version = result.stdout.trim();
  const image = await run('docker', ['image', 'inspect', config.capture.dockerImage, '--format', '{{.Id}}'], { timeoutMs: 20000 });
  return {
    available: true,
    version,
    image: image.code === 0 ? config.capture.dockerImage : null,
    detail: image.code === 0 ? `docker ${version}, image ${config.capture.dockerImage}` : `docker ${version}, image ${config.capture.dockerImage} is not built`,
  };
}

export function createDockerCapture({ config, logger = () => {} }) {
  return {
    backend: 'docker',

    async available() {
      return detectDocker({ config });
    },

    async capture({ snapshotDir, runtimeDir, nodeModulesDir, samples, viewport, timestep, outDir, sourceHash, configurationHash, signal }) {
      const detection = await detectDocker({ config });
      if (!detection.available) {
        throw new CaptureError('isolation_required', `The docker daemon is not available: ${detection.detail}`, { backend: 'docker' });
      }
      if (!detection.image) {
        throw new CaptureError('isolation_required', `The capture image is not built: ${config.capture.dockerImage}. Build it with the documented command.`, {
          backend: 'docker',
          image: config.capture.dockerImage,
        });
      }

      const work = await mkdtemp(join(tmpdir(), 'phygen-capture-'));
      const jobPath = join(work, 'job.json');
      const resultPath = join(work, 'result.json');
      const job = {
        snapshotDir: '/snapshots',
        runtimeDir: '/app/runtime',
        nodeModulesDir: '/deps/node_modules',
        outDir: '/captures',
        samples,
        viewport,
        timestep,
        timeoutMs: config.capture.captureTimeoutMs,
        sourceHash,
        configurationHash,
      };
      await writeFile(jobPath, `${JSON.stringify(job, null, 2)}\n`, 'utf8');
      await writeFile(resultPath, '', 'utf8');

      const args = [
        'run',
        '--rm',
        '--network',
        'none',
        '--user',
        'node',
        '--read-only',
        '--pids-limit',
        '256',
        '--cpus',
        config.capture.containerCpus,
        '--memory',
        config.capture.containerMemory,
        '--tmpfs',
        '/tmp:rw,size=64m',
        '-v',
        `${snapshotDir}:/snapshots:ro`,
        '-v',
        `${runtimeDir}:/app/runtime:ro`,
        '-v',
        `${nodeModulesDir}:/deps/node_modules:ro`,
        '-v',
        `${outDir}:/captures`,
        '-v',
        `${jobPath}:/job.json:ro`,
        '-e',
        'PHYGEN_CAPTURE_JOB=/job.json',
        '-e',
        'PHYGEN_CAPTURE_RESULT=/captures/result.json',
        config.capture.dockerImage,
      ];

      logger('info', `Running the capture container for ${samples.length} frame(s)`);
      let result;
      let parsed = null;
      try {
        result = await run('docker', args, { timeoutMs: config.capture.containerTimeoutMs, signal });
        if (result.code === 0) {
          try {
            parsed = JSON.parse((await readFile(resultPath, 'utf8')).trim() || '{}');
          } catch {
            // fall back to the last JSON line on stdout
          }
          if (!parsed || parsed.ok !== true) {
            const lastLine = result.stdout.trim().split('\n').pop() ?? '{}';
            try {
              parsed = JSON.parse(lastLine);
            } catch {
              parsed = null;
            }
          }
        }
      } finally {
        // the container workspace is temporary, and a failure must not leak it
        await rm(work, { recursive: true, force: true }).catch(() => {});
      }

      const diagnostics = `${result.stderr}\n${result.stdout}`.trim();
      if (result.code !== 0) {
        throw new CaptureError('capture_failed', `The capture container exited with code ${result.code}`, {
          backend: 'docker',
          diagnostics: diagnostics.slice(-2000),
        });
      }
      if (!parsed || parsed.ok !== true) {
        throw new CaptureError(parsed?.code ?? 'capture_failed', parsed?.message ?? 'The capture container returned no result', {
          backend: 'docker',
          details: parsed?.details ?? {},
        });
      }
      return parsed.results.map((entry) => ({
        ...entry,
        path: join(outDir, entry.path.split(/[\\/]/).pop()),
      }));
    },
  };
}
