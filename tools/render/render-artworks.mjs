// Render every evolved artwork version at frame 1000 into docs/image-renders.
//
// One PNG per distinct package content hash, at the requested size. Each branch
// folder is numbered from 001 in creation order. A version that appears in more
// than one era store is written into each branch folder. A file that already
// exists in a branch "selected" folder keeps its name and is refreshed too.
//
// Usage:
//   node tools/render/render-artworks.mjs
// Environment:
//   RENDER_SIZE         output size in pixels (default 2048)
//   RENDER_CONCURRENCY  parallel renders (default 6)
//   RENDER_LIMIT        render only the first N pending versions (default 0 = all)
//
// The run is resumable. State is kept in docs/image-renders/progress.json.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('../../server/node_modules/playwright-core');

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const OUT = path.join(REPO, 'docs', 'image-renders');
const RUNTIME = path.join(REPO, 'runtime');
const MODULES = path.join(REPO, 'threejs', 'node_modules');
const PLAN = path.join(REPO, 'tools', 'render', 'artwork-plan.json');
const PROGRESS = path.join(OUT, 'progress.json');
const LOG = path.join(OUT, 'render.log');

const SIZE = Number(process.env.RENDER_SIZE || 2048);
const CONCURRENCY = Number(process.env.RENDER_CONCURRENCY || 6);
const LIMIT = Number(process.env.RENDER_LIMIT || 0);
const STEPS = 1000;
const SPEED = 8;
const RENDER_TIMEOUT_MS = Number(process.env.RENDER_TIMEOUT_SECONDS || 2400) * 1000;
const GO_TIMEOUT_MS = 90000;

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm' };

const plan = JSON.parse(fs.readFileSync(PLAN, 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

// Final name per version per branch, numbered in creation order within each branch.
const nameByBranch = new Map(); // branch -> Map(hash -> name)
const branches = new Set();
for (const entry of plan) for (const branch of entry.branches) branches.add(branch);
for (const branch of branches) {
  const rows = plan.filter(entry => entry.branches.includes(branch)).sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.hash < b.hash ? -1 : 1));
  const map = new Map();
  rows.forEach((entry, i) => {
    const date = entry.createdAt.slice(0, 10);
    const time = entry.createdAt.slice(11, 19).replace(/:/g, '');
    map.set(entry.hash, `${String(i + 1).padStart(3, '0')}_${date}_${time}_${entry.hash.slice(0, 12)}.png`);
  });
  nameByBranch.set(branch, map);
}

let progress = { startedAt: new Date().toISOString(), size: SIZE, total: plan.length, done: {}, failed: {}, seeds: {} };
if (fs.existsSync(PROGRESS)) {
  try {
    const prior = JSON.parse(fs.readFileSync(PROGRESS, 'utf8'));
    if (prior.size === SIZE) progress = { ...progress, ...prior, size: SIZE, total: plan.length };
  } catch { /* start fresh if the file is corrupt */ }
}
// Every version gets its own fresh seed. It is recorded so a re-run reproduces
// the image instead of choosing another seed.
function seedFor(hash) {
  if (!progress.seeds) progress.seeds = {};
  if (!progress.seeds[hash]) progress.seeds[hash] = 1 + Math.floor(Math.random() * 2147483646);
  return progress.seeds[hash];
}
function saveProgress() {
  progress.updatedAt = new Date().toISOString();
  const text = JSON.stringify(progress, null, 1);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.writeFileSync(PROGRESS + '.tmp', text);
      fs.renameSync(PROGRESS + '.tmp', PROGRESS);
      return;
    } catch {
      // A transient Windows lock on the target can make rename fail. Fall back
      // to a direct write so the run never stops for a state-file problem.
      try {
        fs.writeFileSync(PROGRESS, text);
        try { fs.unlinkSync(PROGRESS + '.tmp'); } catch { /* ignore */ }
        return;
      } catch { /* try again */ }
    }
  }
  log('WARN could not save progress.json');
}
function log(line) {
  const text = `[${new Date().toISOString()}] ${line}`;
  fs.appendFileSync(LOG, text + '\n');
  console.log(text);
}
function place(source, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { if (fs.existsSync(dest)) fs.unlinkSync(dest); fs.linkSync(source, dest); }
  catch { fs.copyFileSync(source, dest); }
}

const packageByIndex = new Map();
plan.forEach((entry, i) => packageByIndex.set(i, path.join(REPO, entry.package)));

function fileFor(rawUrl) {
  const clean = decodeURIComponent(String(rawUrl).split('?')[0]);
  const mod = clean.match(/^\/pkg\/(\d+)\/node_modules\/(.*)$/);
  if (mod) return path.join(MODULES, mod[2]);
  if (clean.startsWith('/pkg/node_modules/')) return path.join(MODULES, clean.slice('/pkg/node_modules/'.length));
  const rt = clean.match(/^\/pkg\/(\d+)\/runtime\/(.*)$/);
  if (rt) return path.join(RUNTIME, rt[2]);
  if (clean.startsWith('/pkg/runtime/')) return path.join(RUNTIME, clean.slice('/pkg/runtime/'.length));
  const pkg = clean.match(/^\/pkg\/(\d+)\/?(.*)$/);
  if (pkg && packageByIndex.has(Number(pkg[1]))) {
    const dir = packageByIndex.get(Number(pkg[1]));
    return path.join(dir, pkg[2] === '' ? 'index.html' : pkg[2]);
  }
  return null;
}

(async () => {
  const server = http.createServer((req, res) => {
    const file = fileFor(req.url || '/');
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const pending = plan.map((entry, i) => ({ entry, i })).filter(({ entry, i }) => {
    if (progress.done[entry.hash]) return false;
    return entry.branches.some(branch => !fs.existsSync(path.join(OUT, branch, nameByBranch.get(branch).get(entry.hash))));
  });
  const todo = LIMIT > 0 ? pending.slice(0, LIMIT) : pending;
  let cursor = 0;
  log(`start: size ${SIZE}px, ${plan.length} versions, ${todo.length} to render, concurrency ${CONCURRENCY}`);

  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  let finished = 0;

  async function renderOne({ entry, i }) {
    const context = await browser.newContext({ viewport: { width: SIZE, height: SIZE }, deviceScaleFactor: 1 });
    const page = await context.newPage();
    const started = Date.now();
    const seed = seedFor(entry.hash);
    const pageErrors = [];
    page.on('pageerror', error => { if (pageErrors.length < 20) pageErrors.push(String(error && error.message || error)); });
    try {
      await page.goto(`http://127.0.0.1:${port}/pkg/${i}/?steps=${STEPS}&speed=${SPEED}&seed=${seed}&paused=0&dpr=1`, { waitUntil: 'domcontentloaded', timeout: GO_TIMEOUT_MS });
      await page.waitForFunction(() => window.__done === true || window.__failed === true, null, { timeout: RENDER_TIMEOUT_MS });
      const result = await page.evaluate(() => ({ done: window.__done === true, failed: window.__failed === true, error: window.__error || null, iteration: window.__state && window.__state.iteration }));
      if (!result.done || result.failed) {
        throw new Error(`page ${result.failed ? 'failed' : 'did not finish'}: ${result.error ? result.error.code + ' ' + result.error.message : pageErrors[0] || 'unknown'}`);
      }
      const temp = path.join(OUT, '.tmp-' + entry.hash.slice(0, 12) + '.png');
      await page.screenshot({ path: temp, clip: { x: 0, y: 0, width: SIZE, height: SIZE } });
      const files = {};
      for (const branch of entry.branches) {
        const name = nameByBranch.get(branch).get(entry.hash);
        const dest = path.join(OUT, branch, name);
        place(temp, dest);
        files[branch] = `${branch}/${name}`;
        const selected = path.join(OUT, branch, 'selected', name);
        if (fs.existsSync(selected)) place(temp, selected);
      }
      fs.unlinkSync(temp);
      progress.done[entry.hash] = { branches: entry.branches, stores: entry.stores, artwork: entry.artwork, seed, num: entry.num, palette: entry.palette, createdAt: entry.createdAt, size: SIZE, files, ms: Date.now() - started, iteration: result.iteration };
      delete progress.failed[entry.hash];
    } catch (error) {
      progress.failed[entry.hash] = { error: String(error && error.message || error).slice(0, 500), branches: entry.branches, package: entry.package };
      log(`FAILED ${entry.hash.slice(0, 10)}: ${String(error && error.message || error).split('\n')[0].slice(0, 200)}`);
    } finally {
      await page.close().catch(() => {});
      await context.close().catch(() => {});
      finished += 1;
      if (finished % 5 === 0 || finished === todo.length) {
        saveProgress();
        log(`progress ${Object.keys(progress.done).length}/${plan.length} (${finished}/${todo.length} this run)`);
      }
    }
  }

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= todo.length) return;
      await renderOne(todo[index]);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  saveProgress();

  const versions = Object.keys(progress.done).sort().map(hash => ({ hash, ...progress.done[hash] }));
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({
    generatedAt: new Date().toISOString(), step: STEPS, speed: SPEED, size: SIZE,
    note: 'One PNG per distinct evolved artwork content hash at simulation frame 1000. Each branch folder is numbered from 001 in creation order.',
    total: plan.length, rendered: versions.length, failed: Object.keys(progress.failed).length, versions,
    failedVersions: Object.keys(progress.failed).sort().map(hash => ({ hash, ...progress.failed[hash] })),
  }, null, 1));
  log(`done: ${versions.length} rendered, ${Object.keys(progress.failed).length} failed`);
  await browser.close();
  server.close();
  process.exit(0);
})().catch(error => { log('FATAL ' + String(error && error.stack || error)); process.exit(1); });
