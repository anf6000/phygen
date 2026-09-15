// ─────────────────────────────────────────────────────────────────────────────
// live-check.mjs — verify that a version plays live.
//
//   node tools/live-check.mjs --version <versionId>
//
// It checks both routes the interface uses:
//   1. the artwork origin directly
//   2. the sandboxed embed the interface shows
//
// It reports the artwork state, the renderer backend, and every page error.
// ─────────────────────────────────────────────────────────────────────────────
import { chromium } from 'playwright-core';

import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/db.mjs';

function parseArgs(argv) {
  const options = { versionId: null, timeout: 45000 };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--version') options.versionId = argv[index + 1];
    else if (argv[index] === '--timeout') options.timeout = Number(argv[index + 1]);
    else continue;
    index++;
  }
  return options;
}

async function launch() {
  const problems = [];
  for (const channel of ['chrome', 'msedge']) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (error) {
      problems.push(`${channel}: ${error.message.split('\n')[0]}`);
    }
  }
  throw new Error(`no browser channel answered: ${problems.join('; ')}`);
}

async function checkPage({ browser, url, label, timeout }) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error.message)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout });
    let target = page.mainFrame();
    if (label === 'embed') {
      // the artwork frame appears after the embed page parses; wait for it
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const found = page.frames().find((frame) => frame !== page.mainFrame() && frame.url().includes('/v/'));
        if (found) {
          target = found;
          break;
        }
        await page.waitForTimeout(200);
      }
    }
    await target.waitForFunction(() => window.__ready === true || window.__failed === true, null, { timeout }).catch(() => {});
    const result = await target.evaluate(() => ({
      ready: window.__ready === true,
      failed: window.__failed === true,
      error: window.__error ?? null,
      state: window.__state ?? null,
      artwork: typeof window.__artwork?.getState === 'function' ? window.__artwork.getState() : null,
    }));
    console.log(`${label.padEnd(7)} ready=${result.ready} failed=${result.failed} iteration=${result.state?.iteration ?? '-'} trail=${result.artwork?.trail ? `${result.artwork.trail.width}x${result.artwork.trail.height}` : '-'} fps=${result.state?.fps ?? '-'}`);
    if (result.error) console.log(`${label.padEnd(7)} error: ${result.error.code} ${result.error.message}`);
    if (consoleErrors.length > 0) console.log(`${label.padEnd(7)} console: ${consoleErrors.slice(0, 3).join(' | ')}`);
    return result.ready && !result.failed;
  } catch (error) {
    console.log(`${label.padEnd(7)} FAILED ${error.message.split('\n')[0]}`);
    if (consoleErrors.length > 0) console.log(`${label.padEnd(7)} console: ${consoleErrors.slice(0, 3).join(' | ')}`);
    return false;
  } finally {
    await context.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const store = new Store(`${config.dataDir}/phygen.db`);

  const versionId = options.versionId ?? store.listVersions(store.listArtworks()[0]?.id ?? '').slice(-1)[0]?.id;
  const version = versionId ? store.getVersion(versionId) : null;
  if (!version) {
    console.error('live-check: no version found. Pass --version <versionId>.');
    store.close();
    process.exitCode = 1;
    return;
  }
  const captures = store.listCaptures(version.id);
  store.close();

  console.log(`version ${version.id} (${version.title}, ${version.status}), ${captures.length} capture(s)`);
  const browser = await launch();
  const direct = await checkPage({
    browser,
    url: `http://${config.host}:${config.livePort}/v/${version.id}/`,
    label: 'direct',
    timeout: options.timeout,
  });
  const embed = await checkPage({
    browser,
    url: `http://${config.host}:${config.port}/live/${version.id}`,
    label: 'embed',
    timeout: options.timeout,
  });
  await browser.close();

  console.log('');
  console.log(`direct origin: ${direct ? 'plays' : 'does not play'}`);
  console.log(`sandboxed embed: ${embed ? 'plays' : 'does not play'}`);
  process.exitCode = direct && embed ? 0 : 1;
}

main().catch((error) => {
  console.error(`live-check failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
