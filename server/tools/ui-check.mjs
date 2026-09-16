// ─────────────────────────────────────────────────────────────────────────────
// ui-check.mjs — check the interface against a running controller.
//
//   node tools/ui-check.mjs [--url http://127.0.0.1:8787] [--out ../docs]
//
// It selects a version, reloads the page, and reports whether the selection
// survived. It also writes an image of the tree. Any page error fails the run.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright-core';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function parseArgs(argv) {
  const options = { url: 'http://127.0.0.1:8787/', out: resolve(HERE, '..', '..', 'docs'), index: 1 };
  for (let at = 0; at < argv.length; at++) {
    const key = argv[at];
    const value = argv[at + 1];
    if (key === '--url') options.url = value;
    else if (key === '--out') options.out = resolve(value);
    else if (key === '--index') options.index = Number(value);
    else continue;
    at++;
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

async function readState(page) {
  return {
    heading: await page.locator('.detail h2').innerText(),
    parent: await page.locator('.branch-chip').innerText(),
    parentChips: await page.locator('.parent-chip').count(),
    nodes: await page.locator('.vnode').count(),
    active: await page.locator('.vnode.is-active').count(),
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await mkdir(options.out, { recursive: true });
  const browser = await launch();
  const errors = [];

  try {
    const page = await browser.newPage({ viewport: { width: 1700, height: 1020 } });
    page.on('pageerror', (error) => errors.push(String(error.message)));
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text());
    });

    await page.goto(options.url, { waitUntil: 'load', timeout: 45000 });
    await page.waitForSelector('.vnode', { timeout: 30000 });
    await page.waitForTimeout(4000);

    const nodes = page.locator('.vnode');
    const count = await nodes.count();
    if (count === 0) throw new Error('the tree is empty');
    await nodes.nth(Math.min(options.index, count - 1)).click();
    await page.waitForTimeout(1500);
    const before = await readState(page);

    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('.vnode', { timeout: 30000 });
    await page.waitForTimeout(4500);
    const after = await readState(page);

    await page.screenshot({ path: join(options.out, 'variants-tree.png') });

    console.log(`nodes          ${before.nodes}`);
    console.log(`selected       ${before.heading}`);
    console.log(`parent chip    ${before.parent}`);
    console.log(`parent marker  ${before.parentChips}`);
    console.log(`after reload   ${after.heading}`);
    console.log(`selection kept ${before.heading === after.heading && before.parent === after.parent}`);

    if (before.heading !== after.heading || before.parent !== after.parent) {
      errors.push('the selection did not survive a reload');
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (errors.length > 0) {
    console.log('');
    console.log(`problems (${errors.length}):`);
    for (const problem of [...new Set(errors)].slice(0, 10)) console.log(`  ${problem}`);
    process.exitCode = 1;
  } else {
    console.log('no page errors');
  }
}

main().catch((error) => {
  console.error(`ui-check failed: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
