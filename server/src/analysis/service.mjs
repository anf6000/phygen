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
import { MEASURES, bandFor, measureById, measurePair, pairKey, planPairs, revisionOf } from './relationships.mjs';
import { appearanceFrames, measureAppearance } from './appearance.mjs';

/** The text files a source comparison reads, and the ceiling on each. */
const SOURCE_DIRS = ['src', 'runtime'];
const MAX_SOURCE_BYTES = 400000;

/** The identity of the frames a record was measured from, for reuse. */
function frameIdentityOf(frames) {
  if (!Array.isArray(frames)) return null;
  return frames.map((frame) => `${frame.label}:${frame.stage}@${frame.step}`).sort();
}

/** Two frame identities are the same list, or both unknown. */
function sameList(left, right) {
  if (!left || !right) return false;
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

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
  constructor({ store, config, logger = () => {}, provider = null, providerStub = false }) {
    this.store = store;
    this.config = config;
    this.logger = logger;
    /** The provider, for the measures that read frames with a model. */
    this.provider = provider;
    /** True when the provider is the deterministic test double. */
    this.providerStub = providerStub;
    /** runId -> { cancelled: boolean } */
    this.active = new Map();
  }

  /** The measures this build offers, with the reason when one is unavailable. */
  measures() {
    return MEASURES.map((measure) => {
      if (measure.method !== 'model') return { ...measure };
      // A model measure is available only when a provider that can look at frames
      // is configured. The test double cannot, and pretending otherwise would
      // produce numbers that mean nothing.
      const available = Boolean(this.provider) && !this.providerStub;
      return {
        ...measure,
        available,
        unavailableReason: available
          ? undefined
          : this.providerStub
            ? 'The provider is the deterministic test double, which cannot look at frames. Configure a real provider to measure appearance.'
            : 'No provider is configured, so no model can compare the frames.',
        model: this.appearanceModel(),
        costPerCallUsd: this.config.analysis.appearanceCallUsd,
        maxPairs: this.config.analysis.appearancePairs,
      };
    });
  }

  /** The model that compares frames: the configured one, else the judge model. */
  appearanceModel() {
    return this.config.analysis.appearanceModel || this.config.provider.model;
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
    const measure = this.measures().find((entry) => entry.id === measureId) ?? null;
    if (!measure) throw new ArtworkError('measure_unknown', `No measure is named ${measureId}`);
    if (!measure.available) {
      throw new ArtworkError('measure_not_enabled', measure.unavailableReason ?? `${measure.label} is not enabled.`);
    }
    const versions = this.store.listVersions(artwork.id);
    if (versions.length < 2) throw new ArtworkError('measure_too_few_versions', 'The artwork holds fewer than two versions');

    const existing = this.store.latestAnalysisRun(artwork.id, measureId);
    if (existing && ['queued', 'running'].includes(existing.state)) {
      throw new ArtworkError('measure_already_running', 'A measurement of this artwork is already running', { runId: existing.id });
    }

    // A model measure is bounded by pairs, not by money, so its default budget is
    // its own: sixty frames pair calls, not four hundred.
    const defaultBudget = measure.method === 'model' ? this.config.analysis.appearancePairs : this.config.analysis.maxPairs;
    const budget = Math.max(1, Math.min(Number(limit) || defaultBudget, defaultBudget));
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
    /** What the measurement has really cost, from the provider's own numbers. */
    let spent = 0;
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
        // The appearance measure also depends on the FRAMES, so a recapture
        // invalidates its record even when the code and configuration are
        // unchanged. The frames are checked against the ones the record names.
        const reusable = this.store.findReusablePairMeasurement(base);
        if (reusable) {
          const stillValid = measure !== 'appearance' || sameList(frameIdentityOf(reusable.evidence?.frames), this.#frameIdentity(a, b));
          if (stillValid) {
            reused += 1;
            this.store.upsertPairMeasurement({ ...base, sourceHashA: base.sourceHashA, sourceHashB: base.sourceHashB, outcome: 'ok', score: reusable.score, band: reusable.band, evidence: { ...reusable.evidence, reused: true } });
            spent += Number(reusable.evidence?.costUsd ?? 0);
            done += 1;
            continue;
          }
        }
        try {
          if (measure === 'appearance') {
            const measured = await this.#measureAppearance({ a, b, run });
            this.store.upsertPairMeasurement({
              ...base,
              outcome: 'ok',
              score: measured.score,
              band: bandFor(measured.score),
              evidence: { ...measured.evidence, group: pair.group },
            });
            spent += measured.costUsd;
            if (done % 10 === 0 || measured.costUsd > 0) {
              this.logger('info', `Appearance pair ${done + 1}/${pairs.length}: ${measured.score.toFixed(2)} for ${measured.costUsd.toFixed(4)} USD`);
            }
          } else {
            const aSources = measure === 'source' ? await sourceFor(a.id) : undefined;
            const bSources = measure === 'source' ? await sourceFor(b.id) : undefined;
            const result = measurePair({ measure, a, b, aSources, bSources });
            this.store.upsertPairMeasurement({ ...base, outcome: 'ok', score: result.score, band: result.band, evidence: { ...result.evidence, group: pair.group } });
          }
        } catch (error) {
          failed += 1;
          this.store.upsertPairMeasurement({ ...base, outcome: 'error', errorCode: error.code ?? 'pair_failed', errorMessage: String(error.message ?? error).slice(0, 400), evidence: { group: pair.group } });
          if (failed > failureLimit) {
            throw new ArtworkError('measure_failure_limit', `Measurement stopped after ${failed} failed pair(s). The last failure was: ${error.message}`);
          }
        }
        done += 1;
        if (done % 25 === 0) {
          this.store.updateAnalysisRun(run.id, { progress: { total: pairs.length, done, reused, failed, spentUsd: spent, elapsedMs: Date.now() - started } });
        }
      }

      this.store.updateAnalysisRun(run.id, {
        state: 'succeeded',
        revision,
        finishedAt: nowIso(),
        progress: { total: pairs.length, done, reused, failed, spentUsd: spent, elapsedMs: Date.now() - started },
      });
      this.logger('info', `Measurement ${run.id} finished: ${done} pair(s), ${failed} error(s), ${spent.toFixed(4)} USD`);
    } catch (error) {
      this.store.updateAnalysisRun(run.id, {
        state: 'failed',
        revision,
        errorCode: error.code ?? 'measure_failed',
        errorMessage: String(error.message ?? error).slice(0, 600),
        finishedAt: nowIso(),
        progress: { total: pairs.length, done, reused, failed, spentUsd: spent },
      });
    } finally {
      this.active.delete(run.id);
    }
  }

  /**
   * Measure one pair by appearance: one frame of each version, under blind
   * labels, through the configured model. The cost is recorded per pair, here
   * and in the usage ledger, so the estimate can be replaced by the real number.
   */
  async #measureAppearance({ a, b, run }) {
    if (!this.provider || this.providerStub) {
      throw new ArtworkError('measure_not_enabled', 'No model is configured to compare frames');
    }
    const aFrames = await this.#framesFor(a);
    const bFrames = await this.#framesFor(b);
    const measured = await measureAppearance({
      ask: (request) =>
        this.provider.judge({
          prompt: request.prompt,
          images: request.images.map((image) => ({ path: image.path })),
          cwd: this.config.repoRoot,
          model: this.appearanceModel(),
        }),
      aFrames,
      bFrames,
      direction: run?.params?.direction ?? null,
      cwd: this.config.repoRoot,
      model: this.appearanceModel(),
    });
    const usage = measured.usage ?? {};
    const costUsd = typeof usage.costUsd === 'number' ? usage.costUsd : 0;
    // The ledger row belongs to no run and no version: it is the cost of a
    // measurement, not of an artwork that was made.
    this.store.createUsage({
      runId: null,
      jobId: null,
      versionId: null,
      kind: 'appearance',
      model: measured.model ?? this.appearanceModel(),
      sessionId: null,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      costUsd,
      raw: { ...(usage.raw ?? {}), costSource: usage.costKnown === true ? 'provider' : 'bound', pairKey: pairKey(a.id, b.id), score: measured.score },
    });
    return {
      score: measured.score,
      costUsd,
      evidence: {
        differences: measured.differences,
        note: measured.note,
        frames: measured.frames,
        model: measured.model ?? this.appearanceModel(),
        costUsd,
        inputTokens: usage.inputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
        labels: ['A', 'B'],
      },
    };
  }

  /** The one frame of a version that the appearance measure uses. */
  async #framesFor(version) {
    const captures = this.store.listCaptures(version.id);
    if (captures.length === 0) {
      throw new ArtworkError('image_missing', `Version ${version.id} holds no frame to compare`);
    }
    return appearanceFrames(captures.map((capture) => ({ path: capture.path, stage: capture.stage, step: capture.step })));
  }

  /** The identity of the frames a pair would be measured from, without reading bytes. */
  #frameIdentity(a, b) {
    const middle = (captures) => (captures.length === 0 ? null : captures[Math.floor(captures.length / 2)]);
    const left = middle(this.store.listCaptures(a.id));
    const right = middle(this.store.listCaptures(b.id));
    return [
      left ? `A:${left.stage}@${left.step}` : 'A:none',
      right ? `B:${right.stage}@${right.step}` : 'B:none',
    ].sort();
  }

  /** The source text a comparison reads. Bounded, and never outside the snapshot. */
  async #readSources(version) {
    return readVersionSources(version);
  }
}

/**
 * The source text of one published version. Bounded, and never outside the
 * snapshot directory. Shared with the archive report, which needs the same text
 * to compare two versions without a measurement run.
 */
export async function readVersionSources(version) {
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
