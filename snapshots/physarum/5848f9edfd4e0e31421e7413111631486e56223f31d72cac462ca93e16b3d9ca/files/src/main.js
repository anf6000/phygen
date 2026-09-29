// ─────────────────────────────────────────────────────────────────────────────
// main.js — the physarum demo page.
//
//   npm start            → http://localhost:8138/
//   ?palette=ice         white | bone | ice | ember | viridis | inferno | magma
//   ?gain=1.5&gamma=0.8  display mapping
//   ?num=20000           molds
//   ?sensorAngle=45&sensorDist=10&rotAngle=45&decay=5&spawnRadius=20
//   ?speed=2&scale=0.5   steps per frame / trail resolution
//   ?seed=7              reproducible run
//   ?config=variants/example.json   load a variant "genome"
//   ?steps=2000          stop after N steps (for reproducible captures)
//   ?paused=1&dpr=1
//
// Keys: space pause · r reseed · c palette · s save png
//
// The page is a thin driver. It reads the manifest, loads and validates the
// configuration, then works only through the adapter contract. A failed load
// stops the page with a diagnostic and never draws the baseline.
//
// Hooks for a capture harness: window.__ready, window.__failed, window.__error,
// window.__done, window.__state, window.__capture(), window.__step(n).
// ─────────────────────────────────────────────────────────────────────────────
import { ArtworkError, assertAdapter } from '../../runtime/contract.js';
import { assertManifest } from '../../runtime/manifest.js';
import { loadConfiguration } from '../../runtime/config.js';
import createArtwork from './adapter.js';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('c');

/** Keep the live page usable when the window is small. */
const MIN_VIEWPORT = { width: 320, height: 240 };

const run = {
  steps: Math.max(0, Math.floor(Number(q.get('steps')) || 0)),
  paused: q.get('paused') !== null && q.get('paused') !== '0' && q.get('paused') !== 'false',
  note: '',
};

async function fetchJson(url, label) {
  let response;
  try {
    response = await fetch(url, { cache: 'no-cache' });
  } catch (cause) {
    throw new ArtworkError('fetch_failed', `${label} could not be fetched from ${url}: ${cause.message}`, { url });
  }
  if (!response.ok) {
    throw new ArtworkError('fetch_failed', `${label} is not available at ${url} (HTTP ${response.status})`, { url, status: response.status });
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new ArtworkError('fetch_failed', `${label} at ${url} is not valid JSON: ${cause.message}`, { url });
  }
}

function viewportFor(dpr) {
  return {
    width: Math.max(MIN_VIEWPORT.width, Math.round(window.innerWidth * dpr)),
    height: Math.max(MIN_VIEWPORT.height, Math.round(window.innerHeight * dpr)),
    dpr,
  };
}

/** Show a failure. A stopped run shows diagnostics; it never shows baseline art. */
function showStop(error) {
  const code = error?.code ?? 'failed';
  const message = error?.message ?? String(error);
  const details = error?.details && Object.keys(error.details).length > 0 ? JSON.stringify(error.details, null, 2) : '';
  document.title = `stopped — ${code}`;
  const box = document.createElement('pre');
  box.id = 'stop';
  box.style.cssText = [
    'position:fixed', 'inset:0', 'margin:0', 'padding:24px', 'overflow:auto', 'z-index:10',
    'background:#12100e', 'color:#f4ece0', 'white-space:pre-wrap',
    'font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace',
  ].join(';');
  box.textContent = `phyvolution stopped\n\n${code}\n${message}${details ? `\n\n${details}` : ''}`;
  document.body.appendChild(box);
  window.__error = { code, message, details: error?.details ?? {} };
  window.__failed = true;
}

async function boot() {
  const baseUrl = new URL('.', location.href).href;
  const manifest = assertManifest(await fetchJson(new URL('manifest.json', baseUrl).href, 'manifest.json'));

  const loaded = await loadConfiguration({
    baseUrl,
    baselineUrl: manifest.configuration.baseline,
    schemaUrl: manifest.configuration.schema,
    variantUrl: q.get('config'),
    overrides: q,
  });
  run.note = loaded.sources.join(' → ');

  const artwork = assertAdapter(await createArtwork(), manifest.entry);
  await artwork.initialize({
    canvas,
    seed: loaded.configuration.seed,
    viewport: viewportFor(loaded.configuration.dpr),
    configuration: loaded.configuration,
    schema: loaded.schema,
    artworkId: manifest.id,
    // live playback is not an evaluation, so it runs on the playback step budget
    limits: { ...manifest.resourceLimits, maxStepsPerEvaluation: manifest.resourceLimits.maxPlaybackSteps },
  });
  return { artwork, configuration: loaded.configuration, schema: loaded.schema };
}

function start(artwork, configuration, schema) {
  const palettes = schema?.properties?.palette?.enum ?? [configuration.palette];
  let palette = configuration.palette;
  let paused = run.paused;
  let fps = 0;
  let last = performance.now();
  let fpsAccum = 0;
  let fpsFrames = 0;

  canvas.setAttribute(
    'aria-label',
    'A slime-mould (physarum) simulation. Each mould senses the trail in front, ' +
      'to its left and to its right, turns towards the strongest one and leaves a ' +
      'trace behind it.',
  );

  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    const key = event.key.toLowerCase();
    if (key === ' ') {
      paused = !paused;
      event.preventDefault();
    } else if (key === 'r') {
      artwork.reset({ seed: (Math.random() * 1e6) | 0 });
      paused = false;
    } else if (key === 'c') {
      palette = palettes[(palettes.indexOf(palette) + 1) % palettes.length];
      artwork.setDisplayPalette(palette);
    } else if (key === 's') {
      savePng();
    }
  });

  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      artwork.resize(viewportFor(configuration.dpr));
    }, 180);
  });

  function savePng() {
    const anchor = document.createElement('a');
    anchor.download = `phyvolution-${Date.now()}.png`;
    anchor.href = capture();
    anchor.click();
  }

  function capture() {
    artwork.render();
    return artwork.view.toDataURL();
  }

  function frame(now) {
    const dt = now - last;
    last = now;

    const simulation = artwork.simulation;
    try {
      if (!paused) {
        let count = Math.max(1, Math.round(configuration.speed || 1));
        if (run.steps > 0) count = Math.min(count, run.steps - simulation.iteration);
        if (count > 0) artwork.step(count);
        if (run.steps > 0 && simulation.iteration >= run.steps) paused = true;
      }
      artwork.render();
    } catch (error) {
      showStop(error);
      return;
    }

    fpsAccum += dt;
    fpsFrames++;
    if (fpsAccum > 250) {
      fps = Math.round(1000 / (fpsAccum / fpsFrames));
      fpsAccum = 0;
      fpsFrames = 0;
    }

    window.__state = {
      iteration: simulation.iteration,
      fps,
      agents: simulation.num,
      W: simulation.W,
      H: simulation.H,
      seed: simulation.seed,
      palette,
      paused,
      note: run.note,
      params: { ...configuration },
    };

    if (run.steps > 0 && simulation.iteration >= run.steps) {
      window.__done = true;
      return;
    }
    requestAnimationFrame(frame);
  }

  window.__artwork = artwork;
  window.__sim = artwork.simulation;
  window.__renderer = artwork.view;
  window.__capture = capture;
  window.__step = (n = 1) => artwork.step(n);
  window.__ready = true;

  requestAnimationFrame(frame);
}

try {
  const { artwork, configuration, schema } = await boot();
  start(artwork, configuration, schema);
} catch (error) {
  showStop(error);
}
