// ─────────────────────────────────────────────────────────────────────────────
// calibrate-gate.mjs — fit the perceptual gate floors from real records.
//
// It never writes. It measures every captured frame of one artwork, computes the
// coherence and the novelty, and prints the score distribution grouped by seed,
// step, and renderer. It then suggests a floor at the fifth percentile of the
// kept versions, with a bootstrapped 95% interval, and lists the versions below
// that floor.
//
// The operator copies the fitted values into docs/MEASUREMENTS.md and into the
// environment. Warn mode is the first step; the next step uses the fitted floor.
//
//   node tools/calibrate-gate.mjs [--artwork <id>] [--json]
// ─────────────────────────────────────────────────────────────────────────────
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadConfig } from '../src/config.mjs';
import { Store } from '../src/db.mjs';
import { measurePngFile } from '../src/gate/gate.mjs';
import { perceptualDistance } from '../src/vision/distance.mjs';
import { coherenceScore, meanScore } from '../src/vision/rubric.mjs';
import { runHardTests } from '../src/vision/tests.mjs';

/** A deterministic generator, so a repeated run gives the same interval. */
function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(values, p) {
  const sorted = [...values].filter((value) => typeof value === 'number' && Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[index];
}

function distribution(values) {
  return {
    count: values.length,
    min: values.length ? Math.min(...values) : null,
    p5: percentile(values, 5),
    median: percentile(values, 50),
    p95: percentile(values, 95),
    max: values.length ? Math.max(...values) : null,
  };
}

/** A bootstrapped 95% interval for the p-th percentile. */
function bootstrapInterval(values, p, { resamples = 2000, seed = 1337 } = {}) {
  if (values.length < 5) return { low: null, high: null, resamples: 0 };
  const random = mulberry32(seed);
  const picks = [];
  for (let run = 0; run < resamples; run++) {
    const sample = [];
    for (let index = 0; index < values.length; index++) sample.push(values[Math.floor(random() * values.length)]);
    picks.push(percentile(sample, p));
  }
  picks.sort((a, b) => a - b);
  return { low: picks[Math.floor(picks.length * 0.025)], high: picks[Math.floor(picks.length * 0.975)], resamples };
}

function round(value, digits = 3) {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

/** Measure every version of one artwork and return the rows. */
export async function collectRows({ store, artworkId }) {
  const versions = [...store.listVersions(artworkId)].sort((a, b) => a.generation - b.generation || String(a.createdAt).localeCompare(String(b.createdAt)));
  const judgments = new Map(store.listJudgmentsByArtwork(artworkId).map((judgment) => [judgment.versionId, judgment]));
  const featuresById = new Map();
  const rows = [];

  for (const version of versions) {
    const captures = store.listCaptures(version.id).filter((capture) => capture.sourceHash === version.sourceHash);
    const late = captures.find((capture) => capture.stage === 'late') ?? captures[captures.length - 1] ?? null;
    const early = captures.find((capture) => capture.stage === 'early') ?? null;
    if (!late) continue;
    const measured = await measurePngFile(late.path);
    if (!measured.ok) {
      rows.push({ versionId: version.id, generation: version.generation, status: version.status, seed: late.seed, step: late.step, backend: late.rendererBackend, measured: false, reason: measured.code });
      continue;
    }
    const features = measured.features;
    featuresById.set(version.id, features);
    const earlyMeasured = early ? await measurePngFile(early.path) : null;
    const hard = runHardTests({ features, early: earlyMeasured?.ok ? earlyMeasured.features : null });
    const coherence = coherenceScore(features).score;
    const judgment = judgments.get(version.id) ?? null;
    rows.push({
      versionId: version.id,
      parentId: version.parentId,
      generation: version.generation,
      status: version.status,
      seed: late.seed,
      step: late.step,
      backend: late.rendererBackend,
      measured: true,
      features,
      coherence: round(coherence),
      novelty: null,
      quality: judgment ? round(meanScore(judgment.scores)) : null,
      tripped: hard.tripped,
    });
  }

  // The novelty is the distance to the parent, once the parent is measured.
  for (const row of rows) {
    if (!row.measured || !row.parentId) continue;
    const child = store.getVersion(row.versionId);
    const parentFeatures = child?.parentId ? featuresById.get(child.parentId) : null;
    if (parentFeatures) row.novelty = round(perceptualDistance(featuresById.get(row.versionId), parentFeatures));
  }
  return rows;
}

function groupKey(row) {
  return `${row.seed}/${row.step}/${row.backend ?? 'unknown'}`;
}

/** The metric values of every measured kept frame, for the floor fit. */
function metricValues(kept) {
  const pick = (name) => kept.map((row) => row.features?.[name]).filter((value) => typeof value === 'number');
  return {
    saturationClipFraction: pick('saturationClipFraction'),
    luminanceEntropy: pick('luminanceEntropy'),
    edgeDensity: pick('edgeDensity'),
    occupiedFraction: pick('occupiedFraction'),
    dominantRidgeShare: pick('dominantRidgeShare'),
    hueSpread: pick('hueSpread'),
  };
}

/**
 * Fit each hard-test threshold so it keeps about 95% of the known-good frames.
 * A metric that trips when it is HIGH gets a ceiling at its 95th percentile; a
 * metric that trips when it is LOW gets a floor at its 5th percentile.
 */
function fitFloors(kept) {
  const values = metricValues(kept);
  return {
    saturationClipMax: round(percentile(values.saturationClipFraction, 95)),
    uniformEntropyMax: round(percentile(values.luminanceEntropy, 5)),
    uniformEdgeMin: round(percentile(values.edgeDensity, 95)),
    emptyOccupiedMin: round(percentile(values.occupiedFraction, 5)),
    cordRidgeMax: round(percentile(values.dominantRidgeShare, 95)),
    rainbowHueSpreadMax: round(percentile(values.hueSpread, 95)),
  };
}

function report(rows) {
  const measured = rows.filter((row) => row.measured);
  const kept = measured.filter((row) => row.status === 'promoted');
  const groups = new Map();
  for (const row of measured) {
    const key = groupKey(row);
    const bucket = groups.get(key) ?? { coherence: [], novelty: [] };
    bucket.coherence.push(row.coherence);
    if (typeof row.novelty === 'number') bucket.novelty.push(row.novelty);
    groups.set(key, bucket);
  }
  const groupRows = [...groups.entries()].map(([key, bucket]) => ({
    group: key,
    coherence: distribution(bucket.coherence),
    novelty: distribution(bucket.novelty),
  }));

  const coherenceValues = kept.map((row) => row.coherence).filter((value) => typeof value === 'number');
  const noveltyValues = kept.map((row) => row.novelty).filter((value) => typeof value === 'number');
  const coherenceFloor = percentile(coherenceValues, 5);
  const noveltyFloor = percentile(noveltyValues, 5);
  const tripCounts = new Map();
  for (const row of measured) for (const name of row.tripped) tripCounts.set(name, (tripCounts.get(name) ?? 0) + 1);

  return {
    measured: measured.length,
    unmeasured: rows.length - measured.length,
    kept: kept.length,
    groups: groupRows,
    coherence: distribution(coherenceValues),
    novelty: distribution(noveltyValues),
    suggested: {
      coherenceFloor: round(coherenceFloor),
      noveltyFloor: round(noveltyFloor),
      coherenceInterval: bootstrapInterval(coherenceValues, 5),
      noveltyInterval: bootstrapInterval(noveltyValues, 5),
      provisional: kept.length < 20,
    },
    trips: [...tripCounts.entries()].map(([name, count]) => ({ name, count, share: round(count / Math.max(1, measured.length)) })),
    metricDistributions: Object.fromEntries(Object.entries(metricValues(kept)).map(([name, values]) => [name, distribution(values)])),
    fittedFloors: fitFloors(kept),
    below: measured
      .filter((row) => (typeof row.coherence === 'number' && coherenceFloor !== null && row.coherence < coherenceFloor) || (typeof row.novelty === 'number' && noveltyFloor !== null && row.novelty < noveltyFloor))
      .map((row) => ({ versionId: row.versionId, generation: row.generation, coherence: row.coherence, novelty: row.novelty, tripped: row.tripped })),
  };
}

function printHuman(result) {
  const line = (label, value) => console.log(`  ${label.padEnd(22)} ${value}`);
  console.log('perceptual gate calibration');
  line('measured versions', result.measured);
  line('unmeasured versions', result.unmeasured);
  line('kept versions', result.kept);
  console.log('');
  console.log('coherence distribution (kept versions)');
  for (const [key, value] of Object.entries(result.coherence)) line(key, value);
  console.log('');
  console.log('novelty distribution (kept versions)');
  for (const [key, value] of Object.entries(result.novelty)) line(key, value);
  console.log('');
  console.log('groups (seed / step / renderer)');
  for (const group of result.groups) {
    line(group.group, `coherence p5 ${group.coherence.p5} median ${group.coherence.median} | novelty p5 ${group.novelty.p5} median ${group.novelty.median}`);
  }
  console.log('');
  console.log('suggested floors (fifth percentile of kept versions)');
  line('coherenceFloor', `${result.suggested.coherenceFloor} (95% ${result.suggested.coherenceInterval.low} .. ${result.suggested.coherenceInterval.high})`);
  line('noveltyFloor', `${result.suggested.noveltyFloor} (95% ${result.suggested.noveltyInterval.low} .. ${result.suggested.noveltyInterval.high})`);
  if (result.suggested.provisional) console.log('  PROVISIONAL: fewer than twenty kept versions; treat the floor as a placeholder.');
  console.log('');
  console.log('fitted hard-test thresholds (about 95% of known-good frames are kept)');
  for (const [name, value] of Object.entries(result.fittedFloors)) line(name, value);
  console.log('');
  console.log('hard-test trips');
  for (const trip of result.trips) line(trip.name, `${trip.count} (${trip.share})`);
  console.log('');
  console.log('versions below a suggested floor');
  for (const row of result.below) line(row.versionId.slice(0, 12), `coherence ${row.coherence} novelty ${row.novelty} tripped ${row.tripped.join(',') || 'none'}`);
  if (result.below.length === 0) console.log('  none');
}

async function main() {
  const argv = process.argv.slice(2);
  const artworkIndex = argv.indexOf('--artwork');
  const artworkId = artworkIndex >= 0 ? argv[artworkIndex + 1] : null;
  const asJson = argv.includes('--json');
  const config = loadConfig();
  const store = new Store(join(config.dataDir, 'phygen.db'));
  try {
    const artwork = artworkId ? store.getArtwork(artworkId) : store.listArtworks()[0];
    if (!artwork) {
      console.error('No artwork is recorded.');
      process.exitCode = 1;
      return;
    }
    const rows = await collectRows({ store, artworkId: artwork.id });
    const result = report(rows);
    if (asJson) console.log(JSON.stringify({ artworkId: artwork.id, ...result }, null, 2));
    else printHuman(result);
  } finally {
    store.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
