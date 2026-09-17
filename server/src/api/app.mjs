// ─────────────────────────────────────────────────────────────────────────────
// app.mjs — the controller API.
//
// The interface talks to this server only. Artwork code never does: it runs on
// the separate live origin.
// ────────────────────────────────────────────────────────────────────────────
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import { ArtworkError } from '../../../runtime/contract.js';
import { checkPackage } from '../../../runtime/node/package-checks.js';
import { MAX_COMPARISON_ENTRIES } from '../judge/protocol.mjs';
import { publishSnapshot } from '../artwork/workspace.mjs';
import { streamEvents } from './stream.mjs';
import { round6 } from '../util.mjs';
import { isInside } from '../artifacts.mjs';

const STAGE_ORDER = ['early', 'early-mid', 'middle', 'late-mid', 'late', 'dense-early', 'dense-early-mid', 'dense-middle', 'dense-late-mid', 'dense-late'];

function fail(reply, code, message, detail = {}) {
  const status = {
    package_invalid: 400,
    artwork_not_found: 404,
    version_not_found: 404,
    run_not_found: 404,
    capture_not_found: 404,
    not_found: 404,
    analysis_not_found: 404,
    measure_unknown: 400,
    measure_not_enabled: 400,
    measure_too_few_versions: 400,
    measure_already_running: 409,
    measure_unavailable: 503,
    payload_invalid: 400,
    run_state_invalid: 409,
    budget_exceeded: 400,
    request_limit_reached: 400,
    token_limit_reached: 400,
    round_limit_reached: 400,
    time_limit_reached: 400,
    capture_unavailable: 503,
    isolation_required: 503,
    provider_unavailable: 503,
  }[code] ?? 500;
  reply.code(status).send({ error: { code, message, detail } });
}

function stageRank(stage) {
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 ? STAGE_ORDER.length : index;
}

const STAGE_PATTERN = /^[a-z0-9][a-z0-9-]{0,23}$/;

/**
 * Validate the evaluation protocol. These values become record fields and file
 * names, so every one of them is bounded here.
 * @returns {string|null} the problem, or null when the protocol is valid
 */
function validateProtocol(protocol) {
  const { viewport, seeds, frameRoles, stepSchedule, denseFrameRoles, denseStepSchedule, tieBreak } = protocol;
  if (!viewport || !Number.isInteger(viewport.width) || !Number.isInteger(viewport.height)) return 'viewport.width and viewport.height must be integers';
  if (viewport.width < 64 || viewport.width > 16384) return 'viewport.width must be from 64 to 16384';
  if (viewport.height < 64 || viewport.height > 16384) return 'viewport.height must be from 64 to 16384';
  if (typeof viewport.dpr !== 'number' || viewport.dpr < 0.25 || viewport.dpr > 4) return 'viewport.dpr must be from 0.25 to 4';
  if (!Array.isArray(seeds) || seeds.length < 1 || seeds.length > 8) return 'seeds must hold from 1 to 8 values';
  if (!seeds.every((seed) => Number.isInteger(seed) && seed >= 0 && seed <= 4294967295)) return 'every seed must be an integer from 0 to 4294967295';
  if (typeof tieBreak !== 'boolean') return 'tieBreak must be true or false';

  for (const [label, roles, steps] of [
    ['frameRoles', frameRoles, stepSchedule],
    ['denseFrameRoles', denseFrameRoles, denseStepSchedule],
  ]) {
    if (!Array.isArray(roles) || roles.length < 1 || roles.length > 8) return `${label} must hold from 1 to 8 names`;
    if (!roles.every((role) => typeof role === 'string' && STAGE_PATTERN.test(role))) {
      return `${label} must hold lowercase names of letters, digits, and hyphens`;
    }
    if (new Set(roles).size !== roles.length) return `${label} repeats a name`;
    if (!Array.isArray(steps) || steps.length !== roles.length) return `${label} and its schedule must have the same length`;
    if (!steps.every((step) => Number.isInteger(step) && step >= 1 && step <= 200000)) return 'every scheduled step must be an integer from 1 to 200000';
  }
  return null;
}

export function buildApp({ store, events, budget, controller, capture, provider, config, artifacts, detection, captureStatus, catalog, recorder = null, analysis = null }) {
  const app = Fastify({ logger: false, bodyLimit: config.server.requestBodyLimit });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ArtworkError) {
      fail(reply, error.code, error.message, error.details ?? {});
      return;
    }
    if (error.statusCode === 400) {
      fail(reply, 'payload_invalid', error.message);
      return;
    }
    request.log.error(error);
    fail(reply, 'internal_error', error.message ?? 'The server failed');
  });

  const webRoot = join(config.repoRoot, 'web', 'dist');
  // wildcard: true reads the file at request time, so a rebuilt interface is
  // served without a server restart.
  app.register(fastifyStatic, { root: webRoot, prefix: '/', wildcard: true, index: ['index.html'], decorateReply: true }).after(() => {});

  // ── health ────────────────────────────────────────────────────────────────
  app.get('/api/health', async () => ({
    ok: true,
    version: config.version,
    provider: {
      driver: detection?.driver ?? 'unknown',
      model: detection?.model ?? config.provider.model,
      ready: Boolean(detection?.available),
      substituted: Boolean(detection?.substituted),
      allowSpend: config.provider.allowSpend,
      detail: detection?.version ?? null,
    },
    capture: {
      backend: captureStatus.backend,
      available: captureStatus.available,
      isolated: captureStatus.isolated,
      detail: captureStatus.detail,
    },
    isolation: {
      docker: captureStatus.docker.available,
      image: captureStatus.docker.image,
      detail: captureStatus.docker.detail,
    },
    artworks: store.listArtworks().length,
    models: catalog ? { source: catalog.status().source, count: catalog.status().count } : { source: 'unavailable', count: 0 },
  }));

  // ── models and cost ───────────────────────────────────────────────────────
  app.get('/api/models', async () => {
    if (!catalog) return { source: 'unavailable', count: 0, models: [], defaultModel: config.provider.model, authorModel: config.provider.authorModel };
    const status = catalog.status();
    return {
      source: status.source,
      count: status.count,
      fetchedAt: status.fetchedAt,
      defaultModel: config.provider.model,
      authorModel: config.provider.authorModel,
      models: status.models.map((model) => ({
        id: model.id,
        name: model.name,
        acceptsImages: model.acceptsImages,
        contextWindow: model.contextWindow,
        priceInUsdPerMTok: model.priceInUsdPerMTok,
        priceOutUsdPerMTok: model.priceOutUsdPerMTok,
        free: model.free,
      })),
    };
  });

  // ── artworks ──────────────────────────────────────────────────────────────
  app.get('/api/artworks', async () => ({ artworks: store.listArtworks() }));

  app.post('/api/artworks/import', async (request, reply) => {
    const body = request.body ?? {};
    if (typeof body.packagePath !== 'string' || body.packagePath.length === 0) {
      return fail(reply, 'payload_invalid', 'packagePath is required');
    }
    const packageDir = resolve(config.repoRoot, body.packagePath);
    if (!isInside(config.repoRoot, packageDir)) {
      return fail(reply, 'payload_invalid', 'The package path must stay inside the repository');
    }

    const check = await checkPackage({ packageDir });
    if (!check.ok) {
      return fail(reply, 'package_invalid', check.problems[0] ?? 'The package is invalid', { problems: check.problems });
    }

    const existing = store.findArtworkByPackagePath(body.packagePath);
    if (existing) {
      const artwork = store.getArtwork(existing.id);
      artwork.rootVersionId = store.getVersion(artwork.rootVersionId).id;
      return { artwork };
    }

    const published = await publishSnapshot({
      workspaceDir: packageDir,
      snapshotRoot: config.artifactsDir,
      artworkId: check.manifest.id,
      packageHash: check.packageHash,
    });

    const rootVersion = store.createVersion({
      artworkId: 'pending',
      parentId: null,
      generation: 0,
      title: 'Root',
      status: 'promoted',
      direction: null,
      sourceHash: check.packageHash,
      snapshotPath: published.path,
      workspacePath: packageDir,
      configuration: JSON.parse(await readFile(join(packageDir, check.manifest.configuration.baseline), 'utf8')),
      changes: [],
      explanation: 'The imported artwork, exactly as it was.',
      onLineage: true,
    });

    const artwork = store.createArtwork({
      packageId: check.manifest.id,
      title: check.manifest.title,
      contractVersion: check.manifest.contractVersion,
      packagePath: body.packagePath,
      rootVersionId: rootVersion.id,
    });
    store.db.prepare('UPDATE versions SET artwork_id = ? WHERE id = ?').run(artwork.id, rootVersion.id);
    artwork.rootVersionId = rootVersion.id;

    return reply.code(201).send({ artwork: store.getArtwork(artwork.id) ?? artwork });
  });

  app.get('/api/artworks/:artworkId/tree', async (request, reply) => {
    const artwork = store.getArtwork(request.params.artworkId);
    if (!artwork) return fail(reply, 'artwork_not_found', `No artwork ${request.params.artworkId}`);
    const versions = store.listVersions(artwork.id);
    const variantOf = variantIndexMap(store, artwork.id);
    const latestCapture = store.latestCaptureByArtwork(artwork.id);
    const usageByVersion = store.usageCostByArtwork(artwork.id);
    // A version produced by a run whose provider was the test double is NOT real
    // work, and it must never look like it. The card carries the mark.
    const stubRuns = new Set(
      store
        .listRuns(500)
        .filter((run) => run.protocol?.providerDriver === 'fake')
        .map((run) => run.id),
    );
    const nodes = versions.map((version) => ({
      ...publicVersion(version, variantOf.get(version.id) ?? null, latestCapture.get(version.id) ?? null),
      liveUrl: artifacts.liveUrlFor(version.id),
      onLineage: version.onLineage,
      stub: Boolean(version.runId && stubRuns.has(version.runId)),
      usageUsd: round6(usageByVersion.get(version.id) ?? 0),
      error: version.errorCode ? { code: version.errorCode, message: version.errorMessage } : null,
    }));
    const edges = versions
      .filter((version) => version.parentId)
      .map((version) => ({ id: `e_${version.id}`, source: version.parentId, target: version.id, onLineage: version.onLineage }));

    // The interface needs to know which versions a worker holds right now, so it
    // can show a progress bar and a leader on the active nodes.
    const runs = store.listRuns(20).filter((run) => run.artworkId === artwork.id);
    const activeRun = runs.find((run) => ['queued', 'running', 'paused', 'stopping'].includes(run.state)) ?? null;
    const activeVersionIds = [];
    const activeKinds = {};
    for (const run of runs) {
      for (const job of store.listJobs(run.id)) {
        if (job.state !== 'running' || !job.versionId) continue;
        activeVersionIds.push(job.versionId);
        activeKinds[job.versionId] = job.kind;
      }
    }

    return {
      artwork,
      nodes,
      edges,
      activeRunId: activeRun?.id ?? null,
      activeVersionIds: [...new Set(activeVersionIds)],
      activeKinds,
    };
  });

  // ── measurements ──────────────────────────────────────────────────────────
  // A measurement is a record of how two versions relate. It is never ancestry:
  // no route here changes a parent link, and every answer states the measure and
  // how old the record is.
  app.get('/api/measures', async () => ({ measures: analysis ? analysis.measures() : [], defaultMeasure: analysis?.measures().find((measure) => measure.available)?.id ?? null }));

  app.get('/api/artworks/:artworkId/relationships', async (request, reply) => {
    if (!analysis) return fail(reply, 'measure_unavailable', 'The measurement service is not running.');
    const artwork = store.getArtwork(request.params.artworkId);
    if (!artwork) return fail(reply, 'artwork_not_found', `No artwork ${request.params.artworkId}`);
    const measureId = String(request.query?.measure ?? analysis.measures().find((measure) => measure.available)?.id ?? 'configuration');
    try {
      const status = analysis.status(artwork.id, measureId);
      const nodes = store.listVersions(artwork.id);
      const byId = new Map(nodes.map((version) => [version.id, version]));
      const pairs = status.pairs.map((pair) => ({
        id: pair.id,
        measure: pair.measure,
        a: pair.versionA,
        b: pair.versionB,
        pairKey: pair.pairKey,
        outcome: pair.outcome,
        score: pair.score,
        band: pair.band,
        evidence: pair.evidence,
        group: pair.evidence?.group ?? null,
        ancestor: isAncestor(byId, pair.versionA, pair.versionB),
        error: pair.errorCode ? { code: pair.errorCode, message: pair.errorMessage } : null,
      }));
      return { measure: status.measure, run: status.run, pairs, currentRevision: status.currentRevision, stale: status.stale, reason: status.reason, maximum: config.analysis.maxPairs };
    } catch (error) {
      return fail(reply, error.code ?? 'measure_failed', error.message, error.details ?? {});
    }
  });

  app.post('/api/artworks/:artworkId/relationships', async (request, reply) => {
    if (!analysis) return fail(reply, 'measure_unavailable', 'The measurement service is not running.');
    const artwork = store.getArtwork(request.params.artworkId);
    if (!artwork) return fail(reply, 'artwork_not_found', `No artwork ${request.params.artworkId}`);
    const body = request.body ?? {};
    const measureId = String(body.measure ?? '');
    try {
      const run = await analysis.start({ artwork, measureId, limit: body.limit, force: body.force === true });
      return reply.code(202).send({ run, measure: analysis.measures().find((measure) => measure.id === run.measure) ?? null });
    } catch (error) {
      return fail(reply, error.code ?? 'measure_failed', error.message, error.details ?? {});
    }
  });

  app.post('/api/analysis/:analysisRunId/cancel', async (request, reply) => {
    if (!analysis) return fail(reply, 'measure_unavailable', 'The measurement service is not running.');
    const run = store.getAnalysisRun(request.params.analysisRunId);
    if (!run) return fail(reply, 'analysis_not_found', `No measurement ${request.params.analysisRunId}`);
    return { run: analysis.cancel(run.id) };
  });

  // ── versions ──────────────────────────────────────────────────────────────
  app.get('/api/versions/:versionId', async (request, reply) => {
    const version = store.getVersion(request.params.versionId);
    if (!version) return fail(reply, 'version_not_found', `No version ${request.params.versionId}`);
    const captures = store.listCaptures(version.id).map((capture) => ({
      id: capture.id,
      stage: capture.stage,
      step: capture.step,
      seed: capture.seed,
      width: capture.width,
      height: capture.height,
      dpr: capture.dpr,
      rendererBackend: capture.rendererBackend,
      sourceHash: capture.sourceHash,
      configurationHash: capture.configurationHash,
      timestep: capture.meta?.timestep ?? null,
      url: `/api/captures/${capture.id}.png`,
      createdAt: capture.createdAt,
    }));
    const comparisons = store
      .listComparisons(version.runId ?? '')
      .filter((comparison) => Object.values(comparison.labels).includes(version.id) || comparison.winnerVersionId === version.id)
      .map((comparison) => ({
        id: comparison.id,
        kind: comparison.kind,
        round: comparison.round,
        order: comparison.order,
        labels: comparison.labels,
        winnerVersionId: comparison.winnerVersionId,
        confidence: comparison.confidence,
        uncertainty: comparison.uncertainty,
        observations: comparison.verdict.observations ?? [],
        weaknesses: comparison.verdict.weaknesses ?? [],
        notes: comparison.verdict.notes ?? '',
        model: comparison.verdict.model ?? null,
        stub: comparison.verdict.stub ?? false,
        judgeSession: comparison.judgeSession,
        createdAt: comparison.createdAt,
      }));
    return {
      version: {
        ...publicVersion(version, variantIndexMap(store, version.artworkId).get(version.id) ?? null),
        liveUrl: artifacts.liveUrlFor(version.id),
        onLineage: version.onLineage,
        changes: version.changes,
        explanation: version.explanation,
      },
      configuration: version.configuration,
      changes: version.changes,
      explanation: version.explanation,
      snapshotPath: version.snapshotPath,
      captures,
      evaluations: comparisons,
      usage: store.listUsageForVersion(version.id),
      error: version.errorCode ? { code: version.errorCode, message: version.errorMessage } : null,
    };
  });

  // The agent feed of one version, read from the stored events, so it survives a
  // reload and works for a version whose run has long finished.
  app.get('/api/versions/:versionId/agent', async (request, reply) => {
    const version = store.getVersion(request.params.versionId);
    if (!version) return fail(reply, 'version_not_found', `No version ${request.params.versionId}`);
    const runs = version.runId ? [version.runId] : store.listRuns(200).filter((run) => run.artworkId === version.artworkId).map((run) => run.id);
    const rows = [];
    const files = [];
    for (const runId of runs) {
      for (const event of store.listEventsByType(runId, 'agent')) {
        if (event.payload?.versionId !== version.id) continue;
        rows.push({ seq: event.seq, at: event.at, ...event.payload });
      }
      // The real file data of the session, so a finished version still shows the
      // true line counts of its files.
      for (const event of store.listEventsByType(runId, 'file')) {
        if (event.payload?.versionId !== version.id) continue;
        files.push({ seq: event.seq, at: event.at, ...event.payload });
      }
    }
    return { rows: rows.slice(-200), files: files.slice(-400) };
  });

  app.get('/api/versions/:versionId/artifacts/:name', async (request, reply) => {    const version = store.getVersion(request.params.versionId);
    if (!version) return fail(reply, 'version_not_found', `No version ${request.params.versionId}`);
    const captures = store.listCaptures(version.id);
    if (captures.length === 0) return fail(reply, 'capture_not_found', 'This version has no capture yet');
    const name = request.params.name;
    const chosen =
      name === 'thumb'
        ? [...captures].sort((a, b) => stageRank(a.stage) - stageRank(b.stage) || a.step - b.step)[0]
        : captures.find((capture) => capture.stage === name) ?? captures[0];
    return sendImage(reply, chosen.path, chosen.id);
  });

  app.get('/api/captures/:captureId.png', async (request, reply) => {
    const capture = store.getCapture(String(request.params.captureId).replace(/\.png$/, ''));
    if (!capture) return fail(reply, 'capture_not_found', 'No such capture');
    return sendImage(reply, capture.path, capture.id);
  });

  // ── live embed ────────────────────────────────────────────────────────────
  app.get('/live/:versionId', async (request, reply) => {
    const version = store.getVersion(request.params.versionId);
    if (!version) return fail(reply, 'version_not_found', `No version ${request.params.versionId}`);
    const liveOrigin = artifacts.liveUrlFor(version.id);
    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(version.title)}</title>
<style>html,body{margin:0;height:100%;background:#12100e}iframe{border:0;width:100%;height:100%;display:block}</style>
</head>
<body>
<iframe src="${escapeHtml(liveOrigin)}" sandbox="${escapeHtml(config.safety.iframeSandbox)}" referrerpolicy="no-referrer" title="${escapeHtml(version.title)}"></iframe>
</body>
</html>`;
    reply
      .code(200)
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .header('content-security-policy', `default-src 'none'; frame-src ${liveOrigin}; style-src 'unsafe-inline'`)
      .send(html);
  });

  // ─ runs ──────────────────────────────────────────────────────────────────
  app.get('/api/cost-estimate', async (request) => {
    const evolutions = Math.max(1, Math.min(50, Number(request.query?.evolutions) || 1));
    const variants = Math.max(1, Math.min(8, Number(request.query?.variants) || config.evolution.variants));
    const judgeModel = typeof request.query?.model === 'string' && request.query.model.length > 0 ? request.query.model : config.provider.model;
    const authorModel = typeof request.query?.authorModel === 'string' && request.query.authorModel.length > 0 ? request.query.authorModel : config.provider.authorModel;
    const bound = budget.boundFor({
      evolutions,
      variants,
      protocol: { tieBreak: config.evolution.tieBreak },
      authorModel,
      judgeModel,
    });
    return {
      ...bound,
      evolutions,
      variants,
      judgeModel: bound.judgeModel ?? { id: judgeModel },
      authorModel: bound.authorModel ?? { id: authorModel },
      note: 'An estimate only. Spending is not limited: the record keeps the real cost.',
    };
  });

  app.post('/api/runs', async (request, reply) => {
    const body = request.body ?? {};
    const artwork = store.getArtwork(body.artworkId);
    if (!artwork) return fail(reply, 'artwork_not_found', `No artwork ${body.artworkId}`);
    if (typeof body.direction !== 'string' || body.direction.trim().length < 3) {
      return fail(reply, 'payload_invalid', 'direction is required and must be at least 3 characters');
    }
    const evolutions = Number(body.evolutions);
    if (!Number.isInteger(evolutions) || evolutions < 1 || evolutions > 50) {
      return fail(reply, 'payload_invalid', 'evolutions must be an integer from 1 to 50');
    }
    // A variant is one child version. An evolution is one level of them.
    const variants = Number(body.variants ?? config.evolution.variants);
    if (!Number.isInteger(variants) || variants < 1 || variants > 8) {
      return fail(reply, 'payload_invalid', 'variants must be an integer from 1 to 8');
    }
    // No cost guardrail. A limit is optional, and 0 means none.
    const limitUsd = Number(body.spendingLimitUsd ?? 0);
    if (!Number.isFinite(limitUsd) || limitUsd < 0) {
      return fail(reply, 'payload_invalid', 'spendingLimitUsd must be zero or a positive number');
    }

    const branch = body.branchFromVersionId ? store.getVersion(body.branchFromVersionId) : null;
    if (body.branchFromVersionId && !branch) return fail(reply, 'version_not_found', `No version ${body.branchFromVersionId}`);
    if (branch && branch.artworkId !== artwork.id) {
      return fail(reply, 'payload_invalid', 'The branch version belongs to a different artwork');
    }
    const rootVersion = branch ?? store.getVersion(artwork.rootVersionId);
    if (!rootVersion) return fail(reply, 'version_not_found', 'This artwork has no root version');

    const protocol = {
      viewport: body.evaluation?.viewport ?? config.evolution.viewport,
      seeds: body.evaluation?.seeds ?? config.evolution.seeds,
      frameRoles: body.evaluation?.frameRoles ?? config.evolution.frameRoles,
      stepSchedule: body.evaluation?.stepSchedule ?? config.evolution.stepSchedule,
      denseFrameRoles: body.evaluation?.denseFrameRoles ?? config.evolution.denseFrameRoles,
      denseStepSchedule: body.evaluation?.denseStepSchedule ?? config.evolution.denseStepSchedule,
      tieBreak: body.evaluation?.tieBreak ?? config.evolution.tieBreak,
    };
    if (protocol.stepSchedule.length !== protocol.frameRoles.length) {
      return fail(reply, 'payload_invalid', 'stepSchedule and frameRoles must have the same length');
    }
    if (protocol.denseStepSchedule.length !== protocol.denseFrameRoles.length) {
      return fail(reply, 'payload_invalid', 'denseStepSchedule and denseFrameRoles must have the same length');
    }
    const protocolProblem = validateProtocol(protocol);
    if (protocolProblem) return fail(reply, 'payload_invalid', `The evaluation protocol is invalid: ${protocolProblem}`);

    const judgeModel = typeof body.model === 'string' && body.model.length > 0 ? body.model : config.provider.model;
    const authorModel = typeof body.authorModel === 'string' && body.authorModel.length > 0 ? body.authorModel : config.provider.authorModel;
    if (catalog && catalog.status().count > 0) {
      const judge = catalog.get(judgeModel);
      if (!judge) return fail(reply, 'payload_invalid', `The model ${judgeModel} is not in the Kilo catalog`);
      if (!judge.acceptsImages) return fail(reply, 'payload_invalid', `The judge model ${judgeModel} cannot read images`);
      if (!catalog.get(authorModel)) return fail(reply, 'payload_invalid', `The author model ${authorModel} is not in the Kilo catalog`);
    }

    const bound = budget.boundFor({
      evolutions,
      variants,
      protocol,
      authorModel,
      judgeModel,
    });

    // Every candidate is compared against the parent in one round comparison,
    // so the label capacity and the image count are checked BEFORE the first
    // author call. A run that could not be judged must never be authored.
    if (variants + 1 > MAX_COMPARISON_ENTRIES) {
      return fail(
        reply,
        'payload_invalid',
        `A round comparison holds at most ${MAX_COMPARISON_ENTRIES} versions, so at most ${MAX_COMPARISON_ENTRIES - 1} variants can be compared with the parent`,
      );
    }
    const imagesPerEntry = protocol.frameRoles.length * protocol.seeds.length;
    const comparisonImages = (variants + 1) * imagesPerEntry;
    if (comparisonImages > config.evolution.maxComparisonImages) {
      return fail(
        reply,
        'payload_invalid',
        `A round comparison would attach ${comparisonImages} images; the limit is ${config.evolution.maxComparisonImages}`,
      );
    }
    try {
      budget.assertAdmission({ evolutions, variants, limitUsd, boundUsd: bound.boundUsd });
    } catch (error) {
      return fail(reply, error.code ?? 'budget_exceeded', error.message, error.details ?? {});
    }

    let run;
    try {
      run = store.createRun({
        artworkId: artwork.id,
        rootVersionId: rootVersion.id,
        direction: body.direction.trim(),
        evolutionsRequested: evolutions,
        limitUsd,
        protocol: { ...protocol, variantsPerEvolution: variants, providerDriver: detection?.driver ?? 'unknown', providerModel: judgeModel, authorModel, estimate: bound },
        costBoundUsd: bound.boundUsd,
      });
      store.upsertRound({
        runId: run.id,
        round: 0,
        parentVersionId: rootVersion.id,
        candidateIds: [],
        winnerVersionId: null,
        promoted: false,
        note: 'The run starts from this version.',
      });
      events.emit(run.id, 'run.state', { state: run.state, stopReason: null });
      events.emit(run.id, 'budget', { spentUsd: 0, reservedUsd: 0, limitUsd: run.limitUsd, boundUsd: run.costBoundUsd });
      // The contract promises that the maximum cost is reserved before the first
      // request. The per-request reservations take over from the first call.
      budget.reserve(run, bound.boundUsd, 'run-estimate', { emit: false });
    } catch (error) {
      // The records exist by now, so close the run instead of leaving a queued
      // run that no worker owns.
      if (run) {
        const code = error.code ?? 'run_admission_failed';
        if (!['stopped', 'completed', 'failed'].includes(run.state)) {
          store.updateRun(run.id, { state: 'failed', stopReason: code, finishedAt: new Date().toISOString() });
        }
        events.emit(run.id, 'error', { code, message: error.message ?? String(error) });
      }
      return fail(reply, error.code ?? 'budget_exceeded', error.message ?? String(error), error.details ?? {});
    }

    // The tickbox can ask for a recording as the run starts.
    if (recorder && body.record === true) {
      void recorder
        .start({ runId: run.id, url: `http://${config.host}:${config.port}/` })
        .catch((error) => {
          events.emit(run.id, 'error', { code: 'recording_failed', message: String(error.message ?? error) });
        });
    }

    void controller.start(run.id).catch((error) => {
      events.emit(run.id, 'error', { code: error.code ?? 'run_failed', message: error.message });
    });

    return reply.code(201).send({ run: store.getRun(run.id) });
  });

  app.get('/api/runs', async (request) => {
    const limit = Math.max(1, Math.min(100, Number(request.query?.limit) || 20));
    const runs = store.listRuns(limit).map((run) => ({ ...run, rounds: store.listRounds(run.id).filter((round) => round.round > 0) }));
    return { runs };
  });

  app.get('/api/runs/:runId', async (request, reply) => {
    const run = store.getRun(request.params.runId);
    if (!run) return fail(reply, 'run_not_found', `No run ${request.params.runId}`);
    return {
      run: { ...run, rounds: store.listRounds(run.id).filter((round) => round.round > 0) },
      jobs: store.listJobs(run.id),
      usage: store.listUsage(run.id),
      comparisons: store.listComparisons(run.id),
      active: controller.isActive(run.id),
    };
  });

  // The interface polls this while a run moves. It stays small on purpose: the
  // job, usage, and comparison lists grow for the whole life of a run.
  app.get('/api/runs/:runId/summary', async (request, reply) => {
    const run = store.getRun(request.params.runId);
    if (!run) return fail(reply, 'run_not_found', `No run ${request.params.runId}`);
    return {
      run: { ...run, rounds: store.listRounds(run.id).filter((round) => round.round > 0) },
      active: controller.isActive(run.id),
    };
  });

  app.post('/api/runs/:runId/pause', async (request, reply) => {
    if (!store.getRun(request.params.runId)) return fail(reply, 'run_not_found', 'No such run');
    return { run: await controller.pause(request.params.runId) };
  });

  app.post('/api/runs/:runId/resume', async (request, reply) => {
    if (!store.getRun(request.params.runId)) return fail(reply, 'run_not_found', 'No such run');
    return { run: await controller.resume(request.params.runId) };
  });

  app.post('/api/runs/:runId/stop', async (request, reply) => {
    if (!store.getRun(request.params.runId)) return fail(reply, 'run_not_found', 'No such run');
    return { run: await controller.stop(request.params.runId) };
  });

  // ── documentation recording ───────────────────────────────────────────────
  // The tickbox writes one PNG per second of the whole interface, then encodes a
  // lossless video when the run ends.
  app.get('/api/recording', async () => (recorder ? recorder.status() : { active: false, frames: 0 }));

  app.post('/api/runs/:runId/recording', async (request, reply) => {
    if (!recorder) return fail(reply, 'payload_invalid', 'Recording is not available in this server');
    const run = store.getRun(request.params.runId);
    if (!run) return fail(reply, 'run_not_found', `No run ${request.params.runId}`);
    const url = `http://${config.host}:${config.port}/`;
    const enabled = request.body?.enabled !== false;
    const finished = ['stopped', 'completed', 'failed'].includes(run.state);
    return {
      recording: enabled
        ? await recorder.start({ runId: run.id, url })
        : await recorder.stop({ reason: 'requested', encodeNow: finished }),
    };
  });

  // ── events ────────────────────────────────────────────────────────────────
  app.get('/api/runs/:runId/events', async (request, reply) => {
    const run = store.getRun(request.params.runId);
    if (!run) return fail(reply, 'run_not_found', `No run ${request.params.runId}`);

    const since = Number(request.headers['last-event-id'] ?? request.query?.since ?? 0) || 0;
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    let closed = false;
    const stream = streamEvents({
      store,
      events,
      runId: run.id,
      since,
      write: (event) => reply.raw.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`),
      onOverrun: (reason) => {
        if (closed) return;
        closed = true;
        reply.raw.write(`: ${reason}\n\n`);
        reply.raw.end();
      },
    });

    const keepAlive = setInterval(() => {
      if (!closed) reply.raw.write(': keep-alive\n\n');
    }, config.server.sseKeepAliveMs);

    // Handle closure exactly once.
    const finish = () => {
      clearInterval(keepAlive);
      stream.stop();
      closed = true;
    };
    request.raw.on('close', finish);
    reply.raw.on('error', finish);
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return fail(reply, 'not_found', `No route for ${request.url}`);
    return serveInterface(reply);
  });

  async function serveInterface(reply) {
    const indexPath = join(webRoot, 'index.html');
    try {
      const html = await readFile(indexPath, 'utf8');
      reply.code(200).type('text/html; charset=utf-8').header('cache-control', 'no-store').send(html);
    } catch {
      reply
        .code(200)
        .type('text/html; charset=utf-8')
        .send(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>phygen</title></head><body>' +
            '<p>The interface is not built. Run <code>npm install &amp;&amp; npm run build</code> in <code>web/</code>.</p>' +
            '<p>The API is available under <code>/api</code>.</p></body></html>',
        );
    }
  }

  return app;
}

function publicVersion(version, variant = null, newestCapture = null) {
  return {
    id: version.id,
    parentId: version.parentId,
    generation: version.generation,
    evolution: version.round,
    variant,
    slot: version.slot,
    title: version.title,
    status: version.status,
    direction: version.direction,
    // The palette this version renders with, so the interface can show which
    // colours a new run will inherit.
    palette: version.configuration?.palette ?? null,
    // A version with no capture has no thumbnail. Saying so here stops the
    // interface from requesting an image the server cannot answer.
    thumbnailUrl: newestCapture ? `/api/versions/${version.id}/artifacts/thumb` : null,
    // The frame the capture wrote last, so a node can show work in progress.
    latestCaptureUrl: newestCapture ? `/api/captures/${newestCapture.id}.png` : null,
    latestCaptureStage: newestCapture ? newestCapture.stage : null,
    latestCaptureStep: newestCapture ? newestCapture.step : null,
    livePath: `/live/${version.id}`,
    sourceHash: version.sourceHash,
    createdAt: version.createdAt,
  };
}

/** The position of each version inside its level, from the round records. */
function variantIndexMap(store, artworkId) {
  const map = new Map();
  for (const run of store.listRuns(200)) {
    if (run.artworkId !== artworkId) continue;
    for (const round of store.listRounds(run.id)) {
      round.candidateIds.forEach((id, index) => map.set(id, index + 1));
    }
  }
  return map;
}

/**
 * True when one version is an ancestor of the other. The comparison itself says
 * so; the interface does not guess it from a ring number.
 */
function isAncestor(byId, a, b) {
  const walk = (start, target) => {
    const seen = new Set();
    let current = byId.get(start);
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.parentId === target) return true;
      current = byId.get(current.parentId);
    }
    return false;
  };
  return walk(a, b) || walk(b, a);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}

async function sendImage(reply, path, id) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return fail(reply, 'capture_not_found', 'The capture file is missing');
    // A capture never changes, so a revalidating client gets 304 and no body.
    const etag = `"${id}-${info.size}"`;
    if (reply.request?.headers?.['if-none-match'] === etag) {
      return reply.code(304).header('etag', etag).send();
    }
    const body = await readFile(path);
    return reply
      .code(200)
      .type('image/png')
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('etag', etag)
      .header('content-length', String(body.length))
      .send(body);
  } catch (error) {
    return fail(reply, 'capture_not_found', `The capture file is missing: ${error.code ?? error.message}`);
  }
}

