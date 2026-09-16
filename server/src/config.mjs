// ─────────────────────────────────────────────────────────────────────────────
// config.mjs — every setting the server reads, in one place.
//
// Nothing here talks to the network. The spend switch defaults to OFF, so a
// test or a demo never bills an account by accident.
// ─────────────────────────────────────────────────────────────────────────────
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

function readBool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw !== '0' && raw.toLowerCase() !== 'false';
}

function readNumber(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

function readList(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((value) => Number.isFinite(value) && value > 0);
}

/**
 * Cost bounds, in US dollars, for one provider request.
 *
 * These are CONFIGURED BOUNDS, not provider prices. The plan requires a
 * conservative bound when pricing is unknown, so the reserve step uses these
 * values and the record keeps the provider-reported usage beside them.
 */
export const DEFAULT_COST_BOUNDS = Object.freeze({
  authorCallUsd: 0.3,
  judgeCallUsd: 0.2,
  repairCallUsd: 0.15,
  tieBreakCallUsd: 0.2,
});

export function loadConfig(overrides = {}) {
  const config = {
    version: '1.0.0',
    host: process.env.PHYGEN_HOST || '127.0.0.1',
    port: readNumber('PHYGEN_PORT', 8787),
    livePort: readNumber('PHYGEN_LIVE_PORT', 8788),
    dataDir: process.env.PHYGEN_DATA ? resolve(process.env.PHYGEN_DATA) : join(REPO_ROOT, 'data'),
    artifactsDir: process.env.PHYGEN_SNAPSHOTS ? resolve(process.env.PHYGEN_SNAPSHOTS) : join(REPO_ROOT, 'snapshots'),
    repoRoot: REPO_ROOT,

    models: {
      // The Kilo gateway catalog. It gives the model list and the real prices.
      baseUrl: process.env.PHYGEN_KILO_API || 'https://api.kilo.ai',
      apiKey: process.env.KILO_API_KEY || process.env.KILOCODE_API_KEY || '',
      organizationId: process.env.KILO_ORG_ID || process.env.KILOCODE_ORGANIZATION_ID || '',
      // The reserve is this multiple of the estimate, because an estimate is
      // never exact. A higher value reserves more and blocks fewer surprises.
      safetyFactor: readNumber('PHYGEN_COST_SAFETY_FACTOR', 1.8),
    },

    provider: {
      // 'auto' uses the pi driver when the command is present, otherwise the fake driver.
      driver: process.env.PHYGEN_DRIVER || 'auto',
      command: process.env.PHYGEN_PI_CMD || 'pi',
      // The Pi shim is a .cmd file on Windows, which a child process cannot
      // start directly. Point this at the bundled CLI to run it with node.
      entry: process.env.PHYGEN_PI_ENTRY || '',
      providerName: process.env.PHYGEN_PROVIDER || 'kilo',
      model: process.env.PHYGEN_MODEL || 'moonshotai/kimi-k3',
      authorModel: process.env.PHYGEN_AUTHOR_MODEL || process.env.PHYGEN_MODEL || 'moonshotai/kimi-k3',
      thinking: process.env.PHYGEN_THINKING || 'medium',
      // Author sessions write code and read files, so they get a lower effort
      // and a longer limit than the judge.
      authorThinking: process.env.PHYGEN_AUTHOR_THINKING || process.env.PHYGEN_THINKING || 'low',
      authorTools: process.env.PHYGEN_AUTHOR_TOOLS || 'read,write,edit,ls',
      allowSpend: readBool('PHYGEN_ALLOW_SPEND', false),
      sessionTimeoutMs: readNumber('PHYGEN_SESSION_TIMEOUT_MS', 1800000),
      judgeTimeoutMs: readNumber('PHYGEN_JUDGE_TIMEOUT_MS', 600000),
    },

    cost: {
      ...DEFAULT_COST_BOUNDS,
      maxRunUsd: readNumber('PHYGEN_MAX_RUN_USD', 5),
      maxRounds: readNumber('PHYGEN_MAX_ROUNDS', 20),
      maxCallsPerRun: readNumber('PHYGEN_MAX_CALLS_PER_RUN', 400),
      maxTokensPerRun: readNumber('PHYGEN_MAX_TOKENS_PER_RUN', 4000000),
      maxRunSeconds: readNumber('PHYGEN_MAX_RUN_SECONDS', 21600),
      defaultLimitUsd: readNumber('PHYGEN_DEFAULT_LIMIT_USD', 2),
    },

    capture: {
      // 'auto' uses docker when the daemon answers, otherwise the local browser.
      backend: process.env.PHYGEN_CAPTURE || 'auto',
      browserChannel: process.env.PHYGEN_BROWSER_CHANNEL || '',
      // A Linux server has no branded channel. Point this at its Chromium.
      browserExecutable: process.env.PHYGEN_BROWSER_EXECUTABLE || '',
      headless: readBool('PHYGEN_CAPTURE_HEADLESS', true),
      dockerImage: process.env.PHYGEN_DOCKER_IMAGE || 'phygen-capture:1',
      containerMemory: process.env.PHYGEN_CONTAINER_MEMORY || '2g',
      containerCpus: process.env.PHYGEN_CONTAINER_CPUS || '2',
      containerTimeoutMs: readNumber('PHYGEN_CONTAINER_TIMEOUT_MS', 900000),
      captureTimeoutMs: readNumber('PHYGEN_CAPTURE_TIMEOUT_MS', 300000),
      captureConcurrency: readNumber('PHYGEN_CAPTURE_CONCURRENCY', 1),
    },

    safety: {
      // Source-code candidates change executable behaviour. Without a container
      // they run in the sandboxed local artwork page: a separate origin, no
      // credentials, no network, and no host access. Set this switch to 1 to
      // refuse source candidates unless a container backend is available.
      requireIsolation: readBool('PHYGEN_REQUIRE_ISOLATION', false),
      iframeSandbox: 'allow-scripts',
      liveFrameAncestors: process.env.PHYGEN_FRAME_ANCESTORS || '',
    },

    evolution: {
      candidatesPerRound: readNumber('PHYGEN_CANDIDATES_PER_ROUND', 3),
      repairAttempts: readNumber('PHYGEN_REPAIR_ATTEMPTS', 1),
      unchangedRoundsBeforeRedirect: readNumber('PHYGEN_UNCHANGED_ROUNDS', 2),
      // The plan fixes the viewport and the seed count before the schedule.
      // The step values come from measurement on this machine: the network
      // needs about 1200 steps before its structure is visible, and it
      // saturates near 3600 steps. See docs/MEASUREMENTS.md.
      viewport: { width: 768, height: 768, dpr: 1 },
      seeds: [1337, 7],
      stepSchedule: readList('PHYGEN_STEP_SCHEDULE', [600, 1800, 3600]),
      denseStepSchedule: readList('PHYGEN_DENSE_STEP_SCHEDULE', [600, 1200, 1800, 2700, 3600]),
      frameRoles: ['early', 'middle', 'late'],
      denseFrameRoles: ['early', 'early-mid', 'middle', 'late-mid', 'late'],
      tieBreak: true,
      // Remove candidate workspaces when a run finishes. Records and captures stay.
      cleanupWorkspaces: readBool('PHYGEN_CLEANUP_WORKSPACES', true),
      // Grades: a candidate must beat the parent by this confidence margin.
      promoteMargin: readNumber('PHYGEN_PROMOTE_MARGIN', 0.15),
    },

    server: {
      requestBodyLimit: 1024 * 256,
      sseKeepAliveMs: 15000,
    },
  };

  for (const [key, value] of Object.entries(overrides)) {
    const current = config[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)) {
      config[key] = { ...current, ...value };
    } else {
      config[key] = value;
    }
  }

  if (config.evolution.stepSchedule.length !== config.evolution.frameRoles.length) {
    config.evolution.stepSchedule = config.evolution.stepSchedule.slice(0, config.evolution.frameRoles.length);
  }
  if (config.evolution.denseStepSchedule.length !== config.evolution.denseFrameRoles.length) {
    config.evolution.denseStepSchedule = config.evolution.denseStepSchedule.slice(0, config.evolution.denseFrameRoles.length);
  }
  return config;
}
