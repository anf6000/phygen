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

  const steps = config.evolution.stepSchedule;
  if (!Array.isArray(steps) || steps.length === 0) fail('evolution.stepSchedule (PHYGEN_STEP_SCHEDULE)', 'must hold at least one step');
  if (!steps.every((step) => Number.isInteger(step) && step >= 1 && step <= 200000)) {
    fail('evolution.stepSchedule (PHYGEN_STEP_SCHEDULE)', 'every step must be an integer from 1 to 200000');
  }
  for (let index = 1; index < steps.length; index++) {
    if (steps[index] <= steps[index - 1]) fail('evolution.stepSchedule (PHYGEN_STEP_SCHEDULE)', `step ${steps[index]} must be greater than the step before it (${steps[index - 1]})`);
  }
  const roles = config.evolution.frameRoles;
  if (!Array.isArray(roles) || roles.length === 0) fail('evolution.frameRoles', 'must hold at least one frame name');
  if (roles.length !== steps.length) {
    fail('evolution.frameRoles and evolution.stepSchedule', `must have the same length (${roles.length} and ${steps.length})`);
  }
  const seeds = config.evolution.seeds;
  if (!Array.isArray(seeds) || seeds.length < 1 || seeds.length > 8) fail('evolution.seeds', 'must hold from 1 to 8 seeds');
  if (!seeds.every((seed) => Number.isInteger(seed) && seed >= 0 && seed <= 4294967295)) {
    fail('evolution.seeds', 'every seed must be an integer from 0 to 4294967295');
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
  repairCallUsd: 0.15,
});

export function loadConfig(overrides = {}) {
  const config = {
    version: '1.0.0',
    host: process.env.PHYGEN_HOST || '127.0.0.1',
    port: readNumber('PHYGEN_PORT', 8787),
    livePort: readNumber('PHYGEN_LIVE_PORT', 8788),
    dataDir: process.env.PHYGEN_DATA ? resolve(process.env.PHYGEN_DATA) : join(REPO_ROOT, 'data-evolve'),
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
      model: process.env.PHYGEN_MODEL || 'deepseek/deepseek-v4.1-flash',
      authorModel: process.env.PHYGEN_AUTHOR_MODEL || process.env.PHYGEN_MODEL || 'deepseek/deepseek-v4.1-flash',
      thinking: process.env.PHYGEN_THINKING || 'medium',
      // The evolve step writes code and reasons about what it sees, so it gets
      // a high effort and a long limit.
      authorThinking: process.env.PHYGEN_AUTHOR_THINKING || 'high',
      authorTools: process.env.PHYGEN_AUTHOR_TOOLS || 'read,write,edit,ls',
      allowSpend: readBool('PHYGEN_ALLOW_SPEND', false),
      sessionTimeoutMs: readNumber('PHYGEN_SESSION_TIMEOUT_MS', 1800000),
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
      // A heavy simulation can need a long render. Ten minutes is the limit for
      // ONE frame; the container timeout above must stay the larger of the two.
      captureTimeoutMs: readNumber('PHYGEN_CAPTURE_TIMEOUT_MS', 600000),
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
      // One step at a time: one author session, one child.
      authorConcurrency: readNumber('PHYGEN_AUTHOR_CONCURRENCY', 1),
      repairAttempts: readNumber('PHYGEN_REPAIR_ATTEMPTS', 1),
      // The frame is a 1024 x 1024 square. One seed, one late step: the network
      // has real structure by step 2500, and a shorter render makes every step
      // faster. See docs/MEASUREMENTS.md.
      viewport: { width: 1024, height: 1024, dpr: 1 },
      seeds: [1337],
      stepSchedule: readList('PHYGEN_STEP_SCHEDULE', [2500]),
      frameRoles: ['late'],
      // Remove candidate workspaces when a run finishes. Records and captures stay.
      cleanupWorkspaces: readBool('PHYGEN_CLEANUP_WORKSPACES', true),
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
