// ─────────────────────────────────────────────────────────────────────────────
// service.mjs — bounded measurement of one artwork, as a background task.
//
// A measurement run is bounded on purpose. It has a fixed pair budget, it
// records its own progress, and it can be cancelled. Each pair is isolated: a
// failed pair becomes an error record and the run continues, until the run
// collects more failures than its limit allows.
//
// A run is never resumed automatically after a restart, because a half-measured
// set must not look complete. It is marked failed and can be rebuilt.
// ─────────────────────────────────────────────────────────────────────────────
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { ArtworkError } from '../../../runtime/contract.js';
import { walkPackage } from '../../../runtime/node/package-checks.js';
import { sha256Hex, stableStringify } from '../util.mjs';
import { MEASURES, measureById, measurePair, pairKey, planPairs, revisionOf } from './relationships.mjs';

/** The text files a source comparison reads, and the ceiling on each. */
const SOURCE_DIRS = ['src', 'runtime'];
const MAX_SOURCE_BYTES = 400000;

function nowIso() {
  return new Date().toISOString();
}

/** The hash of the configuration a version was created from. */
export function configurationHashOf(version) {
  return sha256Hex(stableStringify(version.configuration ?? {}));
}

function hashOfVersion(version) {
  return `${version.sourceHash ?? ''}:${configurationHashOf(version)}`;
}

export class RelationshipAnalysis {
  constructor({ store, config, logger = () => {} }) {
    this.store = store;
    this.config = config;
    this.logger = logger;
    /** runId -> { cancelled: boolean } */
    this.active = new Map();
  }

  /** The measures this build offers, with the reason when one is unavailable. */
  measures() {
    return MEASURES.map((measure) => ({ ...measure }));
  }

  /**
   * The newest record of one measure, with the pairs it holds and a staleness
   * check against the versions that exist now.
   */
  status(artworkId, measureId) {
    const measure = measureById(measureId);
    if (!measure) throw new ArtworkError('measure_unknown', `No measure is named ${measureId}`);
    const versions = this.store.listVersions(artworkId);
    const run = this.store.latestAnalysisRun(artworkId, measureId);
    const hashes = new Map(versions.map((version) => [version.id, hashOfVersion(version)]));
    const currentRevision = revisionOf({ measure: measureId, versions, hashes });
    if (!run) {
      return { measure, run: null, pairs: [], currentRevision, stale: true, reason: 'This artwork has never been measured with this measure.' };
    }
    const pairs = run.state === 'succeeded' ? this.store.listPairMeasurements(run.id, { limit: this.config.analysis.maxPairs * 2 }) : [];
    const stale = run.state !== 'succeeded' || run.revision !== currentRevision;
    return {
      measure,
      run,
      pairs,
      currentRevision,
      stale,
      reason: stale
        ? run.state !== 'succeeded'
          ? `The last measurement is ${run.state}.`
          : 'The artwork changed after this measurement, so it is out of date.'
        : null,
    };
  }

  /**
   * Start a bounded measurement. Returns the record at once; the work continues
   * in the background.
   */
  async start({ artwork, measureId, limit, force = false }) {
    const measure = measureById(measureId);
    if (!measure) throw new ArtworkError('measure_unknown', `No measure is named ${measureId}`);
    if (measure.method === 'model' && !measure.available) {
      throw new ArtworkError('measure_not_enabled', measure.unavailableReason ?? `${measure.label} is not enabled.`);
    }
    const versions = this.store.listVersions(artwork.id);
    if (versions.length < 2) throw new ArtworkError('measure_too_few_versions', 'The artwork holds fewer than two versions');

    const existing = this.store.latestAnalysisRun(artwork.id, measureId);
    if (existing && ['queued', 'running'].includes(existing.state)) {
      throw new ArtworkError('measure_already_running', 'A measurement of this artwork is already running', { runId: existing.id });
    }

    const budget = Math.max(1, Math.min(Number(limit) || this.config.analysis.maxPairs, this.config.analysis.maxPairs));
    const plan = planPairs({ versions, measure: measureId, limit: budget });
    const run = this.store.createAnalysisRun({
      artworkId: artwork.id,
      measure: measureId,
      state: 'running',
      startedAt: nowIso(),
      params: { limit: budget, groups: plan.groups, considered: plan.considered, force: force === true },
      progress: { total: plan.pairs.length, done: 0, reused: 0, failed: 0 },
    });
    this.active.set(run.id, { cancelled: false });
    this.logger('info', `Measurement ${run.id}: ${measure.label}, ${plan.pairs.length} of ${plan.considered} pair(s)`);
    void this.#execute({ run, artwork, measure: measureId, pairs: plan.pairs, versions }).catch((error) => {
      this.logger('error', `Measurement ${run.id} failed: ${error.message}`);
    });
    return this.store.getAnalysisRun(run.id);
  }

  cancel(runId) {
    const context = this.active.get(runId);
    if (!context) return this.store.getAnalysisRun(runId);
    context.cancelled = true;
    return this.store.updateAnalysisRun(runId, { progress: { ...(this.store.getAnalysisRun(runId)?.progress ?? {}), cancelling: true } });
  }

  /** A restart leaves nothing half-measured looking complete. */
  recover() {
    const interrupted = [];
    for (const run of this.store.listUnfinishedAnalysisRuns()) {
      this.store.updateAnalysisRun(run.id, {
        state: 'failed',
        errorCode: 'interrupted_by_restart',
        errorMessage: 'The server restarted while this measurement was running. Run it again.',
        finishedAt: nowIso(),
      });
      interrupted.push(run.id);
    }
    if (interrupted.length > 0) this.logger('warn', `${interrupted.length} measurement(s) were interrupted by a restart.`);
    return interrupted;
  }

  async #execute({ run, artwork, measure, pairs, versions }) {
    const context = this.active.get(run.id);
    const byId = new Map(versions.map((version) => [version.id, version]));
    const hashes = new Map(versions.map((version) => [version.id, hashOfVersion(version)]));
    const revision = revisionOf({ measure, versions, hashes });
    const sources = new Map();
    const sourceFor = async (versionId) => {
      if (sources.has(versionId)) return sources.get(versionId);
      const version = byId.get(versionId);
      const loaded = version ? await this.#readSources(version) : { files: new Map() };
      sources.set(versionId, loaded);
      return loaded;
    };

    let done = 0;
    let reused = 0;
    let failed = 0;
    const failureLimit = this.config.analysis.failureLimit;
    const started = Date.now();

    try {
      for (const pair of pairs) {
        if (context?.cancelled) {
          this.store.updateAnalysisRun(run.id, {
            state: 'cancelled',
            revision,
            finishedAt: nowIso(),
            progress: { total: pairs.length, done, reused, failed },
          });
          this.logger('info', `Measurement ${run.id} was cancelled after ${done} pair(s)`);
          return;
        }
        const a = byId.get(pair.a);
        const b = byId.get(pair.b);
        if (!a || !b) continue;
        const key = pairKey(a.id, b.id);
        const base = {
          analysisRunId: run.id,
          artworkId: artwork.id,
          measure,
          versionA: a.id < b.id ? a.id : b.id,
          versionB: a.id < b.id ? b.id : a.id,
          pairKey: key,
          sourceHashA: a.sourceHash,
          sourceHashB: b.sourceHash,
          configurationHashA: configurationHashOf(a),
          configurationHashB: configurationHashOf(b),
        };
        // Reuse a record only when both versions still hold the same evidence.
        const reusable = this.store.findReusablePairMeasurement(base);
        if (reusable) {
          reused += 1;
          this.store.upsertPairMeasurement({ ...base, sourceHashA: base.sourceHashA, sourceHashB: base.sourceHashB, outcome: 'ok', score: reusable.score, band: reusable.band, evidence: { ...reusable.evidence, reused: true } });
          done += 1;
          continue;
        }
        try {
          const aSources = measure === 'source' ? await sourceFor(a.id) : undefined;
          const bSources = measure === 'source' ? await sourceFor(b.id) : undefined;
          const result = measurePair({ measure, a, b, aSources, bSources });
          this.store.upsertPairMeasurement({ ...base, outcome: 'ok', score: result.score, band: result.band, evidence: { ...result.evidence, group: pair.group } });
        } catch (error) {
          failed += 1;
          this.store.upsertPairMeasurement({ ...base, outcome: 'error', errorCode: error.code ?? 'pair_failed', errorMessage: String(error.message ?? error).slice(0, 400), evidence: { group: pair.group } });
          if (failed > failureLimit) {
            throw new ArtworkError('measure_failure_limit', `Measurement stopped after ${failed} failed pair(s). The last failure was: ${error.message}`);
          }
        }
        done += 1;
        if (done % 25 === 0) {
          this.store.updateAnalysisRun(run.id, { progress: { total: pairs.length, done, reused, failed, elapsedMs: Date.now() - started } });
        }
      }

      this.store.updateAnalysisRun(run.id, {
        state: 'succeeded',
        revision,
        finishedAt: nowIso(),
        progress: { total: pairs.length, done, reused, failed, elapsedMs: Date.now() - started },
      });
      this.logger('info', `Measurement ${run.id} finished: ${done} pair(s), ${failed} error(s)`);
    } catch (error) {
      this.store.updateAnalysisRun(run.id, {
        state: 'failed',
        revision,
        errorCode: error.code ?? 'measure_failed',
        errorMessage: String(error.message ?? error).slice(0, 600),
        finishedAt: nowIso(),
        progress: { total: pairs.length, done, reused, failed },
      });
    } finally {
      this.active.delete(run.id);
    }
  }

  /** The source text a comparison reads. Bounded, and never outside the snapshot. */
  async #readSources(version) {
    const files = new Map();
    const root = version.snapshotPath ? join(version.snapshotPath, 'files') : null;
    if (!root) return { files };
    const walked = await walkPackage(root);
    for (const file of walked) {
      if (file.symlink) continue;
      if (!SOURCE_DIRS.some((dir) => file.rel.startsWith(`${dir}/`))) continue;
      if (!/\.(m?js|json|css)$/.test(file.rel)) continue;
      if (file.bytes !== undefined && file.bytes > MAX_SOURCE_BYTES) continue;
      try {
        const text = await readFile(file.full, 'utf8');
        if (text.length <= MAX_SOURCE_BYTES) files.set(file.rel, text);
      } catch {
        // An unreadable file is not a measurement failure: it is simply absent.
      }
    }
    return { files };
  }
}
