// ─────────────────────────────────────────────────────────────────────────────
// ui-shot.mjs — record one image of the interface.
//
//   node tools/ui-shot.mjs [--url http://127.0.0.1:8787] [--out ../docs/phygen-ui.png]
//                          [--width 1440] [--height 1000] [--wait 6000]
//
// It uses the browser this machine already has. Nothing is installed.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function parseArgs(argv) {
  const options = {
    url: 'http://127.0.0.1:8787/',
    out: resolve(HERE, '..', '..', 'docs', 'phygen-ui.png'),
    width: 1440,
    height: 1000,
    wait: 6000,
    channel: '',
  };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === '--url') options.url = value;
    else if (key === '--out') options.out = resolve(value);
    else if (key === '--width') options.width = Number(value);
    else if (key === '--height') options.height = Number(value);
    else if (key === '--wait') options.wait = Number(value);
    else if (key === '--channel') options.channel = value;
    else if (key === '--click') options.click = value;
    else continue;
    index++;
  }
  return options;
}

async function launch(channel) {
  const candidates = channel ? [channel] : ['chrome', 'msedge'];
  const problems = [];
  for (const candidate of candidates) {
    try {
      return await chromium.launch({ channel: candidate, headless: true });
    } catch (error) {
      problems.push(`${candidate}: ${error.message.split('\n')[0]}`);
    }
  }
  throw new Error(`no browser channel answered: ${problems.join('; ')}`);
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const browser = await launch(options.channel);
  try {
    const context = await browser.newContext({ viewport: { width: options.width, height: options.height }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    await page.goto(options.url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForSelector('.vnode, .genlist', { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(options.wait);
    if (options.click) {
      await page.click(options.click, { timeout: 15000 }).catch((error) => {
        console.error(`ui-shot: the click on ${options.click} failed: ${error.message.split('\n')[0]}`);
      });
      await page.waitForTimeout(2500);
    }
    await mkdir(dirname(options.out), { recursive: true });
    await page.screenshot({ path: options.out, fullPage: false });
    console.log(`ui-shot: wrote ${options.out}`);
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch((error) => {
  console.error(`ui-shot failed: ${error.message}`);
  process.exitCode = 1;
});
