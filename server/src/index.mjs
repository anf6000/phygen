// ─────────────────────────────────────────────────────────────────────────────
// index.mjs — start the controller, the API, and the artwork origin.
//
//   npm start                 API on 8787, artwork origin on 8788
//   PHYGEN_ALLOW_SPEND=1      permit real model calls
//   PHYGEN_DRIVER=fake        use the deterministic test double
//   PHYGEN_CAPTURE=docker     require the isolated capture container
// ─────────────────────────────────────────────────────────────────────────────
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from './config.mjs';
import { Store } from './db.mjs';
import { EventBus } from './events.mjs';
import { Budget } from './budget.mjs';
import { createArtifacts } from './artifacts.mjs';
import { createCapture, captureStatus } from './capture/index.mjs';
import { ModelCatalog } from './models.mjs';
import { RunController } from './controller/run.mjs';
import { createProvider } from './providers/index.mjs';
import { buildApp } from './api/app.mjs';
import { createLiveServer } from './api/live.mjs';

export async function startServer(overrides = {}) {
  const config = loadConfig(overrides);
  await mkdir(config.dataDir, { recursive: true });
  await mkdir(config.artifactsDir, { recursive: true });

  const logger = (level, message) => {
    const stamp = new Date().toISOString().slice(11, 19);
    process.stdout.write(`${stamp} ${level.toUpperCase()} ${message}\n`);
  };

  const store = new Store(join(config.dataDir, 'phygen.db'));
  const events = new EventBus(store);
  const catalog = new ModelCatalog({ config, logger });
  await catalog.refresh();
  const budget = new Budget({ store, events, config, catalog });
  const { provider, detection } = await createProvider({ config, logger });
  const capture = await createCapture({ config, logger });
  const status = await captureStatus({ config });
  const artifacts = createArtifacts({ store, config });

  const controller = new RunController({ store, events, budget, capture, provider, config, artifacts, logger });

  const live = createLiveServer({ store, config });
  const liveBaseUrl = await live.listen();

  const app = buildApp({ store, events, budget, controller, capture, provider, config, artifacts, detection, captureStatus: status, catalog });
  await app.listen({ host: config.host, port: config.port });

  const recovered = await controller.recover();

  logger('info', `API      http://${config.host}:${config.port}`);
  logger('info', `Artwork  ${liveBaseUrl} (separate origin, no credentials)`);
  logger('info', `Data     ${config.dataDir}`);
  logger('info', `Provider ${detection.driver} ${detection.model}${detection.substituted ? ' (substituted test double)' : ''}`);
  logger('info', `Models   ${catalog.status().source}, ${catalog.status().count} model(s)`);
  logger('info', `Capture  ${status.backend}${status.isolated ? ' (isolated)' : ' (sandboxed artwork page)'} — ${status.detail}`);
  if (!config.provider.allowSpend) logger('warn', 'Spending is disabled. Runs use the test double until PHYGEN_ALLOW_SPEND=1.');
  if (!status.isolated) {
    logger('warn', 'No container backend. Source-code candidates run in the sandboxed local artwork page.');
  }
  if (config.safety.requireIsolation && !status.isolated) {
    logger('warn', 'PHYGEN_REQUIRE_ISOLATION=1 is set, so source-code candidates are refused.');
  }
  if (recovered.length > 0) logger('warn', `${recovered.length} run(s) paused after a restart. Review them before you resume.`);

  const shutdown = async () => {
    logger('info', 'Shutting down');
    await app.close().catch(() => {});
    await live.close().catch(() => {});
    store.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { config, store, events, budget, controller, provider, capture, app, live, detection, captureStatus: status };
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  startServer().catch((error) => {
    process.stderr.write(`phygen failed to start: ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
