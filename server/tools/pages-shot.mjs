// Record every page of the interface for review.
//
//   node tools/pages-shot.mjs [--url http://127.0.0.1:8787] [--out ../docs]
//
// It writes: the tree, a candidate record, the frame viewer, the live view, and
// the narrow layout. Each image is written only after the page is ready.
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function parseArgs(argv) {
  const options = { url: 'http://127.0.0.1:8787/', out: resolve(HERE, '..', '..', 'docs') };
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--url') options.url = argv[index + 1];
    else if (argv[index] === '--out') options.out = resolve(argv[index + 1]);
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

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.out, { recursive: true });
  const browser = await launch();
  const errors = [];

  try {
    const wide = await browser.newContext({ viewport: { width: 1600, height: 1020 }, deviceScaleFactor: 1 });
    const page = await wide.newPage();
    page.on('pageerror', (error) => errors.push(`tree: ${error.message}`));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(`console: ${message.text()}`);
    });

    await page.goto(options.url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForSelector('.vnode', { timeout: 30000 });
    await page.waitForTimeout(5000);
    await page.screenshot({ path: join(options.out, 'page-tree.png') });
    console.log('wrote page-tree.png');

    // a candidate record: source changes and evidence
    const candidate = page.locator('.vnode').nth(1);
    await candidate.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: join(options.out, 'page-record.png') });
    console.log('wrote page-record.png');

    // the frame viewer
    const frames = page.getByRole('button', { name: 'Open frames' }).first();
    if ((await frames.count()) > 0) {
      await frames.click();
      await page.waitForTimeout(3500);
      await page.screenshot({ path: join(options.out, 'page-frames.png') });
      console.log('wrote page-frames.png');
      await page.getByRole('button', { name: 'Close' }).first().click();
      await page.waitForTimeout(800);
    }

    // the live view
    const play = page.getByRole('button', { name: 'Play live' }).first();
    if ((await play.count()) > 0) {
      await play.click();
      await page.waitForTimeout(9000);
      await page.screenshot({ path: join(options.out, 'page-live.png') });
      console.log('wrote page-live.png');
      const frame = page.frames().find((item) => item !== page.mainFrame() && item.url().includes('/v/'));
      if (frame) {
        const state = await frame.evaluate(() => ({ ready: window.__ready === true, failed: window.__failed === true, iteration: window.__state?.iteration ?? null }));
        console.log(`live frame: ready=${state.ready} failed=${state.failed} iteration=${state.iteration}`);
        if (!state.ready || state.failed) errors.push('the live frame did not initialize');
      } else {
        errors.push('the live frame was not found');
      }
    }
    await wide.close();

    // the narrow layout
    const narrow = await browser.newContext({ viewport: { width: 420, height: 880 }, deviceScaleFactor: 1 });
    const phone = await narrow.newPage();
    await phone.goto(options.url, { waitUntil: 'load', timeout: 45000 });
    await phone.waitForSelector('.genlist', { timeout: 30000 }).catch(() => {});
    await phone.waitForTimeout(4000);
    await phone.screenshot({ path: join(options.out, 'page-mobile.png') });
    console.log('wrote page-mobile.png');
    await narrow.close();
  } finally {
    await browser.close().catch(() => {});
  }

  if (errors.length > 0) {
    console.log('');
    console.log(`page errors (${errors.length}):`);
    for (const error of [...new Set(errors)].slice(0, 12)) console.log(`  ${error}`);
    process.exitCode = 1;
  } else {
    console.log('');
    console.log('no page errors');
  }
}

main().catch((error) => {
  console.error(`pages-shot failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
