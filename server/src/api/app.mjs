// ────────────────────────────────────────────────────────────────────────────
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
import { publishSnapshot } from '../artwork/workspace.mjs';
import { streamEvents } from './stream.mjs';
import { round6 } from '../util.mjs';
import { isInside } from '../artifacts.mjs';

function fail(reply, code, message, detail = {}) {
  const status = {
    package_invalid: 400,
    artwork_not_found: 404,
    version_not_found: 404,
    run_not_found: 404,
    capture_not_found: 404,
    not_found: 404,
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

export function buildApp({ store, events, budget, controller, capture, provider, config, artifacts, detection, captureStatus, catalog }) {
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

  // ── models ────────────────────────────────────────────────────────────────
  app.get('/api/models', async () => {
    if (!catalog) return { source: 'unavailable', count: 0, models: [], defaultModel: config.provider.model };
    const status = catalog.status();
    return {
      source: status.source,
      count: status.count,
      fetchedAt: status.fetchedAt,
      defaultModel: config.provider.model,
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
    if (existing) return { artwork: store.getArtwork(existing.id) };

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

    // The root has no frame until one is captured, so its card would show the
    // loading art. Capture it in the background: the import stays fast, and the
    // card shows a real frame as soon as the capture lands.
    void controller
      .captureFrame({ versionId: rootVersion.id })
      .then(() => request.log.info('Captured the frame of the root version'))
      .catch((error) => request.log.warn(`The root frame was not captured: ${error.message}`));

    return reply.code(201).send({ artwork: store.getArtwork(artwork.id) ?? artwork });
  });

  app.get('/api/artworks/:artworkId/tree', async (request, reply) => {
    const artwork = store.getArtwork(request.params.artworkId);
    if (!artwork) return fail(reply, 'artwork_not_found', `No artwork ${request.params.artworkId}`);
    const versions = store.listVersions(artwork.id);
    const latestCapture = store.latestCaptureByArtwork(artwork.id);
    const usageByVersion = store.usageCostByArtwork(artwork.id);
    const tokensByVersion = store.usageTokensByArtwork(artwork.id);
    // A version produced by a run whose provider was the test double is NOT real
    // work, and it must never look like it. The card carries the mark.
    const stubRuns = new Set(
      store
        .listRuns(500)
        .filter((run) => run.protocol?.providerDriver === 'fake')
        .map((run) => run.id),
    );
    const nodes = versions.map((version) => ({
      ...publicVersion(version, latestCapture.get(version.id) ?? null),
      liveUrl: artifacts.liveUrlFor(version.id),
      onLineage: version.onLineage,
      changes: version.changes.map((change) => ({ path: change.path, status: change.status, added: change.added, removed: change.removed })),
      explanation: version.explanation,
      stub: Boolean(version.runId && stubRuns.has(version.runId)),
      usageUsd: round6(usageByVersion.get(version.id) ?? 0),
      tokens: tokensByVersion.get(version.id) ?? 0,
      error: version.errorCode ? { code: version.errorCode, message: version.errorMessage } : null,
    }));
    const edges = versions
      .filter((version) => version.parentId)
      .map((version) => ({ id: `e_${version.id}`, source: version.parentId, target: version.id, onLineage: version.onLineage }));

    // The interface needs to know which versions a worker holds right now, so it
    // can show progress on the active cards.
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
    return {
      version: {
        ...publicVersion(version, store.latestCaptureByArtwork(version.artworkId).get(version.id) ?? null),
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
    return { rows: rows.slice(-400), files: files.slice(-400) };
  });

  app.get('/api/versions/:versionId/artifacts/:name', async (request, reply) => {
    const version = store.getVersion(request.params.versionId);
    if (!version) return fail(reply, 'version_not_found', `No version ${request.params.versionId}`);
    const captures = store.listCaptures(version.id);
    if (captures.length === 0) return fail(reply, 'capture_not_found', 'This version has no capture yet');
    const name = request.params.name;
    const chosen = captures.find((capture) => capture.stage === name) ?? captures[captures.length - 1];
    return sendImage(reply, chosen.path, chosen.id);
  });

  // ── operator actions ──────────────────────────────────────────────────────
  // The interface has no button for these. They repair one failed step, and
  // they capture a frame for a version that has none (the imported root).
  app.post('/api/versions/:versionId/repair', async (request, reply) => {
    const version = store.getVersion(request.params.versionId);
    if (!version) return fail(reply, 'version_not_found', `No version ${request.params.versionId}`);
    if (controller.isActive(version.runId ?? '')) {
      return fail(reply, 'run_state_invalid', 'A run is working on this artwork. Repair after the run ends.');
    }
    try {
      const result = await controller.repairVersion({ versionId: version.id });
      if (!result.ok) return fail(reply, result.error?.code ?? 'repair_failed', result.error?.message ?? 'The repair failed', result.error?.details ?? {});
      return { version: publicVersion(result.version), repaired: true };
    } catch (error) {
      return fail(reply, error.code ?? 'repair_failed', error.message, error.details ?? {});
    }
  });

  app.post('/api/versions/:versionId/capture', async (request, reply) => {
    const version = store.getVersion(request.params.versionId);
    if (!version) return fail(reply, 'version_not_found', `No version ${request.params.versionId}`);
    try {
      const captures = await controller.captureFrame({ versionId: version.id });
      return { version: publicVersion(store.getVersion(version.id)), captures: captures.length };
    } catch (error) {
      return fail(reply, error.code ?? 'capture_failed', error.message, error.details ?? {});
    }
  });

  // Refactoring is a ONE-TIME cleanup, not part of evolution. It has no route:
  // the step loop never calls it, and `tools/repair-version.mjs --refactor` runs
  // it once, by hand, on one kept version.

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
  app.post('/api/runs', async (request, reply) => {
    const body = request.body ?? {};
    const artwork = store.getArtwork(body.artworkId);
    if (!artwork) return fail(reply, 'artwork_not_found', `No artwork ${body.artworkId}`);
    const evolutions = Number(body.evolutions);
    if (!Number.isInteger(evolutions) || evolutions < 1 || evolutions > 100) {
      return fail(reply, 'payload_invalid', 'evolutions must be an integer from 1 to 100');
    }
    // The interface sends no model when it wants the default.
    const model = typeof body.model === 'string' && body.model.length > 0 ? body.model : config.provider.authorModel;
    if (catalog && catalog.status().count > 0) {
      const known = catalog.get(model);
      if (!known) return fail(reply, 'payload_invalid', `The model ${model} is not in the Kilo catalog`);
      // The step session must see the attached frames of the chain.
      if (!known.acceptsImages) return fail(reply, 'payload_invalid', `The model ${model} cannot read images`);
    }

    // No cost guardrail. A limit is optional, and 0 means none.
    const limitUsd = Number(body.spendingLimitUsd ?? 0);
    if (!Number.isFinite(limitUsd) || limitUsd < 0) {
      return fail(reply, 'payload_invalid', 'spendingLimitUsd must be zero or a positive number');
    }

    const rootVersion = store.getVersion(artwork.rootVersionId);
    if (!rootVersion) return fail(reply, 'version_not_found', 'This artwork has no root version');

    const protocol = {
      viewport: config.evolution.viewport,
      seeds: config.evolution.seeds,
      frameRoles: config.evolution.frameRoles,
      stepSchedule: config.evolution.stepSchedule,
      providerDriver: detection?.driver ?? 'unknown',
      providerModel: model,
      authorModel: model,
    };

    const bound = budget.boundFor({ evolutions, authorModel: model });

    try {
      budget.assertAdmission({ evolutions, limitUsd, boundUsd: bound.boundUsd });
    } catch (error) {
      return fail(reply, error.code ?? 'budget_exceeded', error.message, error.details ?? {});
    }

    let run;
    try {
      run = store.createRun({
        artworkId: artwork.id,
        rootVersionId: rootVersion.id,
        evolutionsRequested: evolutions,
        limitUsd,
        protocol,
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
      active: controller.isActive(run.id),
    };
  });

  // The interface polls this while a run moves. It stays small on purpose: the
  // job and usage lists grow for the whole life of a run.
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

function publicVersion(version, newestCapture = null) {
  return {
    id: version.id,
    parentId: version.parentId,
    generation: version.generation,
    // The step number is the CHAIN position, so it stays right when a second
    // run continues the chain. The root is generation 0 and shows as "Root".
    step: version.generation > 0 ? version.generation : null,
    title: version.title,
    status: version.status,
    // The palette this version renders with, so the interface can show which
    // colours a new step will inherit.
    palette: version.configuration?.palette ?? null,
    // The frame this version captured: the still image of an older card.
    stillUrl: newestCapture ? `/api/captures/${newestCapture.id}.png` : null,
    stillStage: newestCapture ? newestCapture.stage : null,
    stillStep: newestCapture ? newestCapture.step : null,
    livePath: `/live/${version.id}`,
    sourceHash: version.sourceHash,
    createdAt: version.createdAt,
  };
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
