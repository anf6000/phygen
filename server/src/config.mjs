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
 * Validate the whole configuration before the server accepts work.
 *
 * A value that survives startup and fails every run is worse than a refusal:
 * the refusal names the variable, the run failure hides it.
 *
 * @param {object} config
 * @throws {Error} with code `config_invalid` and the offending variable name
 */
export function validateConfig(config) {
  const fail = (variable, message) => {
    const error = new Error(`Invalid configuration ${variable}: ${message}`);
    error.code = 'config_invalid';
    error.variable = variable;
    throw error;
  };

  const schedule = [
    ['evolution.stepSchedule', 'PHYGEN_STEP_SCHEDULE', config.evolution.stepSchedule],
    ['evolution.denseStepSchedule', 'PHYGEN_DENSE_STEP_SCHEDULE', config.evolution.denseStepSchedule],
  ];
  for (const [path, name, values] of schedule) {
    if (!Array.isArray(values) || values.length === 0) fail(`${path} (${name})`, 'must hold at least one step');
    if (!values.every((step) => Number.isInteger(step) && step >= 1 && step <= 200000)) {
      fail(`${path} (${name})`, 'every step must be an integer from 1 to 200000');
    }
    for (let index = 1; index < values.length; index++) {
      if (values[index] <= values[index - 1]) fail(`${path} (${name})`, `step ${values[index]} must be greater than the step before it (${values[index - 1]})`);
    }
  }
  const roles = [
    ['evolution.frameRoles', config.evolution.frameRoles, 'evolution.stepSchedule'],
    ['evolution.denseFrameRoles', config.evolution.denseFrameRoles, 'evolution.denseStepSchedule'],
  ];
  for (const [path, names, schedulePath] of roles) {
    if (!Array.isArray(names) || names.length === 0) fail(path, 'must hold at least one frame name');
    if (names.length !== config.evolution[schedulePath.split('.')[1]].length) {
      fail(`${path} and ${schedulePath}`, `must have the same length (${names.length} and ${config.evolution[schedulePath.split('.')[1]].length})`);
    }
  }
  const seeds = config.evolution.seeds;
  if (!Array.isArray(seeds) || seeds.length < 1 || seeds.length > 8) fail('evolution.seeds', 'must hold from 1 to 8 seeds');
  if (!seeds.every((seed) => Number.isInteger(seed) && seed >= 0 && seed <= 4294967295)) {
    fail('evolution.seeds', 'every seed must be an integer from 0 to 4294967295');
  }
  if (!Number.isInteger(config.evolution.variants) || config.evolution.variants < 1 || config.evolution.variants > 8) {
    fail('evolution.variants (PHYGEN_VARIANTS)', 'must be an integer from 1 to 8');
  }
  const viewport = config.evolution.viewport;
  if (!viewport || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)) fail('evolution.viewport', 'width and height must be integers');
  if (viewport.width < 64 || viewport.width > 16384 || viewport.height < 64 || viewport.height > 16384) {
    fail('evolution.viewport', 'width and height must be from 64 to 16384');
  }
  if (typeof viewport.dpr !== 'number' || viewport.dpr < 0.25 || viewport.dpr > 4) fail('evolution.viewport.dpr', 'must be from 0.25 to 4');
  for (const [path, value] of [
    ['evolution.authorConcurrency', config.evolution.authorConcurrency],
    ['capture.captureConcurrency', config.capture.captureConcurrency],
    ['capture.captureTimeoutMs', config.capture.captureTimeoutMs],
    ['capture.containerTimeoutMs', config.capture.containerTimeoutMs],
    ['provider.sessionTimeoutMs', config.provider.sessionTimeoutMs],
    ['provider.judgeTimeoutMs', config.provider.judgeTimeoutMs],
    ['evolution.maxComparisonImages', config.evolution.maxComparisonImages],
    ['analysis.maxPairs', config.analysis.maxPairs],
    ['server.sseKeepAliveMs', config.server.sseKeepAliveMs],
  ]) {
    if (!Number.isFinite(value) || value <= 0) fail(path, 'must be a positive number');
  }
  if (config.capture.captureTimeoutMs > config.capture.containerTimeoutMs) {
    fail('capture.captureTimeoutMs', 'must not exceed capture.containerTimeoutMs');
  }
  return true;
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

    recording: {
      // A lossless mp4 needs an encoder. ffmpeg is used when it is present.
      ffmpeg: process.env.PHYGEN_FFMPEG || 'ffmpeg',
      enabled: readBool('PHYGEN_RECORD', false),
      // 2160p: the frame is large enough to hold the tree around the version
      // that is being worked on, even at the greatest zoom.
      width: readNumber('PHYGEN_RECORD_WIDTH', 3840),
      height: readNumber('PHYGEN_RECORD_HEIGHT', 2160),
    },

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
      // 0 means no cost guardrail. The spend is still recorded, never enforced.
      maxRunUsd: readNumber('PHYGEN_MAX_RUN_USD', 0),
      maxRounds: readNumber('PHYGEN_MAX_ROUNDS', 0),
      maxCallsPerRun: readNumber('PHYGEN_MAX_CALLS_PER_RUN', 0),
      maxTokensPerRun: readNumber('PHYGEN_MAX_TOKENS_PER_RUN', 0),
      maxRunSeconds: readNumber('PHYGEN_MAX_RUN_SECONDS', 0),
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
      captureConcurrency: readNumber('PHYGEN_CAPTURE_CONCURRENCY', 2),
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
      // The number of children one version spawns at each level.
      variants: readNumber('PHYGEN_VARIANTS', 3),
      // Several author sessions at once. More is faster, and the tree shows them.
      authorConcurrency: readNumber('PHYGEN_AUTHOR_CONCURRENCY', 3),
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
      // One round comparison attaches every stage of every seed for the parent
      // and every variant. This is the ceiling on that image count.
      maxComparisonImages: readNumber('PHYGEN_MAX_COMPARISON_IMAGES', 60),
      // Grades: a candidate must beat the parent by this confidence margin.
      promoteMargin: readNumber('PHYGEN_PROMOTE_MARGIN', 0.15),
    },
    // Bounded relationship measurement. A run has a fixed pair budget and stops
    // when too many pairs fail.
    analysis: {
      maxPairs: Math.max(1, Math.round(readNumber('PHYGEN_ANALYSIS_MAX_PAIRS', 400))),
      failureLimit: Math.max(0, Math.round(readNumber('PHYGEN_ANALYSIS_FAILURE_LIMIT', 20))),
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

  validateConfig(config);
  return config;
}
