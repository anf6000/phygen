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

    // Every finished version must show its frame. A blank tile is a regression.
    const images = await page.evaluate(() => {
      const list = [...document.querySelectorAll('.vnode img')];
      return {
        total: list.length,
        loaded: list.filter((image) => image.naturalWidth > 0).length,
        broken: list.filter((image) => image.complete && image.naturalWidth === 0).length,
        finished: [...document.querySelectorAll('.vnode.status-promoted, .vnode.status-rejected')].length,
      };
    });
    console.log(`frames         ${images.loaded} loaded of ${images.total} image(s) for ${images.finished} finished node(s)`);
    if (images.broken > 0) errors.push(`${images.broken} node image(s) did not load`);
    if (images.finished > 0 && images.loaded === 0) errors.push('no finished node shows its frame');

    const nodes = page.locator('.vnode');
    const count = await nodes.count();
    if (count === 0) throw new Error('the tree is empty');

    // The tree is a canvas: pick a node that is fully inside the viewport, so a
    // large tree does not fail the click.
    const viewport = page.viewportSize() ?? { width: 1700, height: 1020 };
    const boxes = await nodes.evaluateAll((elements) =>
      elements.map((element) => {
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, right: box.x + box.width, bottom: box.y + box.height };
      }),
    );
    const fits = (box) => box.x > 8 && box.y > 8 && box.right < viewport.width - 8 && box.bottom < viewport.height - 8;
    let target = boxes.findIndex((box, index) => index > 0 && fits(box));
    if (target === -1) target = boxes.findIndex(fits);
    if (target === -1) target = 0;
    await nodes.nth(target).click({ force: target === 0 && !fits(boxes[0] ?? { x: 0, y: 0, right: 0, bottom: 0 }) });
    await page.waitForTimeout(1500);
    const before = await readState(page);

    // Hide failed nodes, when the tree holds any.
    const hideFailed = page.getByRole('checkbox', { name: /hide failed/i });
    const hideAvailable = (await hideFailed.count()) > 0 && (await hideFailed.isEnabled());
    let hidden = null;
    if (hideAvailable) {
      await hideFailed.check();
      await page.waitForTimeout(800);
      hidden = await nodes.count();
      await hideFailed.uncheck();
      await page.waitForTimeout(800);
      const restored = await nodes.count();
      if (restored !== before.nodes) errors.push(`unhiding failed nodes gave ${restored} nodes, expected ${before.nodes}`);
      if (hidden > before.nodes) errors.push('hiding failed nodes added nodes');
    }

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
    if (hidden !== null) console.log(`hide failed    ${before.nodes} nodes -> ${hidden} nodes`);

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
