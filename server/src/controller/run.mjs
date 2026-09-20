// ─────────────────────────────────────────────────────────────────────────────
// run.mjs — the run controller.
//
// The controller owns budgets, step counts, and job state. Agents never
// enforce their own limits.
//
// One step is:
//   read the chain head → create the child row → copy the parent package into
//   its workspace → run one author session with the fixed instruction and the
//   last three frames attached → review the edits → validate the package →
//   publish the snapshot → capture one late square frame → promote the child.
//
// The child is always kept: no judge, no comparison, no variants. A technical
// failure gets one repair session; a second failure marks the version failed,
// the chain head stays, and the next step starts from the last good version.
// ─────────────────────────────────────────────────────────────────────────────
import { readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { ArtworkError } from '../../../runtime/contract.js';
import { validateConfiguration } from '../../../runtime/config.js';
import { checkPackage, walkPackage } from '../../../runtime/node/package-checks.js';

import { newId, nowIso, sha256Hex, sleep, stableStringify, truncate } from '../util.mjs';
import { canTransition, isTerminal, transition } from '../state.mjs';
import { BudgetError } from '../budget.mjs';
import { copyPackage, publishSnapshot, reviewEdits } from '../artwork/workspace.mjs';
import { assertSourceMode, decideSourceMode, isLocalHost } from '../capture/index.mjs';
import { isTransientProviderError } from '../providers/index.mjs';
import { EVOLVE_SYSTEM_PROMPT, REFACTOR_SYSTEM_PROMPT, STEP_INSTRUCTION, buildEvolvePrompt, buildRefactorPrompt, buildRepairPrompt } from './prompts.mjs';
import { feedRows } from './agent-events.mjs';
import { WorkspaceReader } from './workspace-reader.mjs';

const CAPTURE_TIMESTEP = 8;
const LEASE_MS = 120000;

/** A limit that stops admission. These end the run; they do not fail a candidate. */
const BUDGET_STOP_CODES = new Set(['budget_exceeded', 'request_limit_reached', 'token_limit_reached', 'round_limit_reached', 'time_limit_reached']);

export function isBudgetStop(error) {
  return error instanceof BudgetError || (error?.code !== undefined && BUDGET_STOP_CODES.has(error.code));
}

/**
 * A wall-clock ceiling around one capture. A capture backend that hangs must
 * never hold the run: the step fails, the chain head stays, and the next step
 * continues.
 */
function withCaptureCeiling(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new ArtworkError('capture_timeout', `The capture did not finish within ${Math.round(ms / 1000)} seconds`, { limitMs: ms }));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * A short title for one step, taken from the agent answer. The step number is
 * already on the card, so the title carries the change instead of repeating it.
 * @param {string} text  the agent answer
 * @param {number} step  the CHAIN position, which is what the card shows
 */
export function titleFromExplanation(text, step) {
  const fallback = `Step ${step}`;
  for (const raw of String(text ?? '').split('\n')) {
    let line = raw
      .replace(/^#+\s*/, '')
      .replace(/[*_`]/g, '')
      .trim();
    // An answer often starts with a bullet, a number, or a path label.
    line = line.replace(/^[-•\d.)\s]+/, '').trim();
    line = line.replace(/^(src\/[\w./-]+|config\.json)\s*:\s*/i, '').trim();
    if (line.length < 12) continue;
    // A line of code, a bare path, or a heading with no content is not a title.
    if (/[{};]|=>|\bconst\b|\bfunction\b/.test(line)) continue;
    if (/^[\w./-]+$/.test(line)) continue;
    if (line.endsWith(':')) continue;
    if (/^files?\b/i.test(line)) continue;
    return line.length > 72 ? `${line.slice(0, 69)}...` : line;
  }
  return fallback;
}

/**
 * A stored capture, in the shape the capture backend returns. */
function asCaptureResult(capture) {  return {
    id: capture.id,
    stage: capture.stage,
    seed: capture.seed,
    step: capture.step,
    width: capture.width,
    height: capture.height,
    dpr: capture.dpr,
    rendererBackend: capture.rendererBackend,
    sourceHash: capture.sourceHash,
    configurationHash: capture.configurationHash,
    timestep: capture.meta?.timestep ?? CAPTURE_TIMESTEP,
    path: capture.path,
    url: capture.meta?.url ?? `/api/captures/${capture.id}.png`,
    fps: capture.meta?.fps ?? null,
    iteration: capture.meta?.iteration ?? capture.step,
    trailChecksum: capture.meta?.trailChecksum ?? null,
    agentChecksum: capture.meta?.agentChecksum ?? null,
    consoleErrors: capture.meta?.consoleErrors ?? [],
    reused: true,
  };
}

export class RunController {
  constructor({ store, events, budget, capture, provider, config, artifacts, logger = () => {} }) {
    this.store = store;
    this.events = events;
    this.budget = budget;
    this.capture = capture;
    this.provider = provider;
    this.config = config;
    this.artifacts = artifacts;
    this.logger = logger;
    this.leases = new Map();
    this.active = new Map();
    this.contexts = new Map();
  }

  isActive(runId) {
    return this.active.has(runId);
  }

  /** True when the run is stopping or has been aborted. */
  #stopping(runId) {
    const context = this.active.get(runId);
    return Boolean(context && (context.stopping || context.abort.signal.aborted));
  }

  /**
   * A delay that Stop interrupts at once. A Stop during a retry delay must
   * never be followed by another paid session.
   */
  async #abortableDelay(runId, ms) {
    if (this.#stopping(runId)) throw new ArtworkError('cancelled', 'The run stopped during a retry delay');
    const signal = this.active.get(runId)?.abort.signal;
    if (!signal) return sleep(ms);
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new ArtworkError('cancelled', 'The run stopped during a retry delay'));
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Start the run loop. Resolves when the run reaches a terminal state. */
  async start(runId) {
    if (this.active.has(runId)) throw new ArtworkError('run_state_invalid', `Run ${runId} is already active`);
    this.active.set(runId, { abort: new AbortController(), paused: false, stopping: false });
    try {
      await this.#loop(runId);
    } finally {
      this.active.delete(runId);
    }
  }

  /** Pause stops new steps. The current bounded step finishes. */
  async pause(runId) {
    const run = this.store.getRun(runId);
    if (!run) throw new ArtworkError('run_not_found', `No run ${runId}`);
    const context = this.active.get(runId);
    if (context) context.paused = true;
    if (run.state === 'running') return this.#setRunState(runId, 'paused');
    return run;
  }

  async resume(runId) {
    const run = this.store.getRun(runId);
    if (!run) throw new ArtworkError('run_not_found', `No run ${runId}`);
    const context = this.active.get(runId);
    if (!context) {
      // the loop is not running: continue in a new loop
      void this.start(runId).catch((error) => this.#failRun(runId, error));
      return this.store.getRun(runId);
    }
    context.paused = false;
    return run.state === 'paused' ? this.#setRunState(runId, 'running') : run;
  }

  /** Stop cancels active tasks and prevents new model calls. */
  async stop(runId, reason = 'stop_requested') {
    const run = this.store.getRun(runId);
    if (!run) throw new ArtworkError('run_not_found', `No run ${runId}`);
    const context = this.active.get(runId);
    if (context) {
      context.stopping = true;
      context.abort.abort();
      this.#emit(runId, 'run.state', { state: 'stopping', stopReason: reason });
      return this.#setRunState(runId, 'stopping', { stopReason: reason });
    }
    const stopped = this.#setRunState(runId, 'stopped', { stopReason: reason, finishedAt: nowIso() });
    this.#emit(runId, 'run.completed', { state: 'stopped', stopReason: reason, evolutionsDone: stopped.evolutionsDone });
    return stopped;
  }

  /**
   * After a restart, never repeat a paid request whose outcome is unknown.
   * Runs that were in flight pause, and their running jobs become failed.
   *
   * A version whose snapshot was already PUBLISHED is durable work: it is kept
   * as it is, so a resume can continue that step without paying for it again. A
   * version that was not published is failed, because its outcome is unknown.
   */
  async recover() {
    const recovered = [];
    const failures = [];
    for (const run of this.store.listActiveRuns()) {
      try {
        const published = new Set(
          this.store
            .listJobs(run.id)
            .filter((job) => job.kind === 'publish' && job.state === 'done' && job.versionId)
            .map((job) => job.versionId),
        );
        for (const job of this.store.listJobs(run.id)) {
          if (job.state === 'running' || job.state === 'queued') {
            this.store.updateJob(job.id, {
              state: job.state === 'running' ? 'failed' : 'cancelled',
              errorCode: 'interrupted_by_restart',
              errorMessage: 'The server restarted while this task was in flight.',
            });
          }
        }
        for (const version of this.store.listVersions(run.artworkId)) {
          if (version.runId !== run.id) continue;
          if (!['queued', 'authoring', 'validating', 'capturing'].includes(version.status)) continue;
          if (published.has(version.id)) {
            // The snapshot is immutable and its step can continue on resume.
            this.#emit(run.id, 'version.state', {
              versionId: version.id,
              status: version.status,
              detail: 'the server restarted, and this published snapshot is kept for the resume',
            });
            continue;
          }
          this.store.updateVersion(version.id, {
            status: 'failed',
            errorCode: 'interrupted_by_restart',
            errorMessage: 'The server restarted during this stage. The next step starts from the last good version.',
          });
          this.#emit(run.id, 'version.state', { versionId: version.id, status: 'failed', detail: 'interrupted_by_restart' });
        }
        // A run that was stopping has nothing left to stop.
        const target = run.state === 'stopping' ? 'stopped' : 'paused';
        const state = this.#setRunState(run.id, target, {
          stopReason: target === 'stopped' ? run.stopReason ?? 'stopped_by_restart' : 'paused_after_restart',
          finishedAt: target === 'stopped' ? nowIso() : null,
        });
        this.#emit(run.id, 'run.state', {
          state: target,
          stopReason: state.stopReason ?? null,
          detail: 'A paid request may have been accepted before the restart. The run waits for a person.',
        });
        recovered.push(state);
        this.logger('warn', `Run ${run.id} is ${target} after a restart. Review the record before you resume it.`);
      } catch (error) {
        failures.push({ runId: run.id, message: error.message });
        this.logger('error', `Run ${run.id} could not be recovered: ${error.message}`);
      }
    }
    if (failures.length > 0) {
      this.logger('warn', `${failures.length} run(s) need attention after a restart. The server continues.`);
    }
    return recovered;
  }

  // ── the loop ──────────────────────────────────────────────────────────────

  async #loop(runId) {
    try {
      let run = this.store.getRun(runId);
      run = this.#setRunState(runId, 'running', { startedAt: run.startedAt ?? nowIso(), stopReason: null });
      this.logger('info', `Run ${runId} started: ${run.evolutionsRequested} evolution(s)`);

      while (true) {
        const context = this.active.get(runId);
        run = this.store.getRun(runId);

        if (!context || context.stopping || context.abort.signal.aborted) {
          const state = this.#setRunState(runId, 'stopped', { stopReason: run.stopReason ?? 'stop_requested', finishedAt: nowIso() });
          this.#emit(runId, 'run.completed', { state: state.state, stopReason: state.stopReason, evolutionsDone: state.evolutionsDone });
          this.#terminateVersions(runId, 'The run stopped during this stage.');
          await this.#cleanupRun(runId);
          return;
        }
        if (context.paused) {
          await sleep(250);
          continue;
        }
        if (run.evolutionsDone >= run.evolutionsRequested) {
          const state = this.#setRunState(runId, 'completed', { stopReason: 'evolutions_complete', finishedAt: nowIso() });
          this.#emit(runId, 'run.completed', { state: state.state, stopReason: state.stopReason, evolutionsDone: state.evolutionsDone });
          this.#terminateVersions(runId, 'The run completed during this stage.');
          await this.#cleanupRun(runId);
          return;
        }

        // A configured limit stops admission. It must not consume a step
        // and it must not look like a candidate fault.
        this.budget.assertRunLimits(run);

        const round = run.evolutionsDone + 1;
        const parent = this.#chainHead(run);
        this.#emit(runId, 'run.round', {
          round,
          phase: 'author',
          parentVersionId: parent.id,
          detail: parent.generation === 0 ? 'the chain is empty, so this step starts from the root' : `step ${round} evolves ${parent.title}`,
        });
        this.logger('info', `Run ${runId} step ${round}: parent ${parent.id} (${parent.title})`);

        const outcome = await this.#runStep({ run, round, parent });

        // An interrupted step is recorded, but it does not consume an
        // evolution: Resume continues the same step from what is durable.
        if (outcome.interrupted) {
          this.store.upsertRound({
            runId,
            round,
            parentVersionId: parent.id,
            candidateIds: outcome.candidateIds ?? [],
            winnerVersionId: null,
            promoted: false,
            note: outcome.note,
          });
          this.#emit(runId, 'run.round', { round, phase: 'interrupted', note: outcome.note, candidateIds: outcome.candidateIds ?? [] });
          this.logger('info', `Run ${runId} step ${round} was interrupted: ${outcome.note}`);
          continue;
        }

        this.store.updateRun(runId, { evolutionsDone: run.evolutionsDone + 1 });
        this.store.upsertRound({
          runId,
          round,
          parentVersionId: parent.id,
          candidateIds: outcome.candidateIds,
          winnerVersionId: outcome.winnerVersionId,
          promoted: outcome.promoted,
          note: outcome.note,
        });
        this.#emit(runId, 'run.round', {
          round,
          phase: 'done',
          promoted: outcome.promoted,
          winnerVersionId: outcome.winnerVersionId,
          note: outcome.note,
        });
        this.logger('info', `Run ${runId} step ${round} finished: ${outcome.promoted ? `promoted ${outcome.winnerVersionId}` : `failed: ${outcome.note}`}`);
      }
    } catch (error) {
      const context = this.active.get(runId);
      if (context?.stopping || context?.abort.signal.aborted) {
        const current = this.store.getRun(runId);
        if (!['stopped', 'completed', 'failed'].includes(current.state)) {
          const stopped = this.#setRunState(runId, 'stopped', {
            stopReason: current.stopReason ?? 'stop_requested',
            finishedAt: nowIso(),
          });
          this.#emit(runId, 'run.completed', { state: stopped.state, stopReason: stopped.stopReason, evolutionsDone: stopped.evolutionsDone });
        }
        // The step that the Stop interrupted is NOT terminal. Close it, or its
        // card would stay on "the agent writes code" forever.
        this.#terminateVersions(runId, 'The run stopped during this stage.');
        await this.#cleanupRun(runId);
        return;
      }
      // A configured limit stopped admission. Stop the run with the exact
      // reason and keep the remaining steps unused.
      if (isBudgetStop(error)) {
        const current = this.store.getRun(runId);
        if (!['stopped', 'completed', 'failed'].includes(current.state)) {
          const stopped = this.#setRunState(runId, 'stopped', { stopReason: error.code, finishedAt: nowIso() });
          this.#emit(runId, 'error', { code: error.code, message: error.message, detail: { ...(error.details ?? {}), budgetStop: true } });
          this.#emit(runId, 'run.completed', {
            state: stopped.state,
            stopReason: error.code,
            evolutionsDone: stopped.evolutionsDone,
            detail: error.message,
          });
          this.#terminateVersions(runId, `The run stopped at a configured limit: ${error.message}`);
          await this.#cleanupRun(runId);
        }
        this.logger('warn', `Run ${runId} stopped at a configured limit (${error.code}): ${error.message}`);
        return;
      }
      // A provider that is unavailable is not the fault of the work. Pause the
      // run so it can be resumed when the provider answers again, instead of
      // failing the job and losing the remaining steps.
      if (error?.code === 'provider_unavailable') {
        const current = this.store.getRun(runId);
        if (!['stopped', 'completed', 'failed'].includes(current.state)) {
          this.#setRunState(runId, 'paused', { stopReason: 'provider_unavailable' });
          this.#emit(runId, 'log', {
            level: 'warn',
            message: `The run paused because the provider did not answer: ${error.message} Resume it when the provider is back.`,
          });
          this.logger('warn', `Run ${runId} paused: ${error.message}`);
        }
        return;
      }
      await this.#failRun(runId, error);
    }
  }

  async #failRun(runId, error) {
    const code = error?.code ?? 'run_failed';
    const message = error?.message ?? String(error);
    this.logger('error', `Run ${runId} failed: ${code} ${message}`);
    this.#emit(runId, 'error', { code, message, detail: error?.details ?? {} });
    try {
      const run = this.store.getRun(runId);
      if (run && !['stopped', 'completed', 'failed'].includes(run.state)) {
        this.#setRunState(runId, 'failed', { stopReason: code, finishedAt: nowIso() });
        this.#terminateVersions(runId, `The run failed with ${code}.`);
        this.#emit(runId, 'run.completed', { state: 'failed', stopReason: code, evolutionsDone: run.evolutionsDone });
      }
    } catch {
      // the record is already unusable
    }
  }

  /** A finished run keeps its records, but not its temporary directories. */
  async #cleanupRun(runId) {
    if (!this.config.evolution.cleanupWorkspaces) return;
    await rm(join(this.config.dataDir, 'workspaces', runId), { recursive: true, force: true }).catch(() => {});
    this.logger('info', `Run ${runId}: removed the temporary workspaces`);
  }

  /** A run that ends must not leave a version in a running stage. */
  #terminateVersions(runId, reason) {
    const run = this.store.getRun(runId);
    if (!run) return 0;
    let closed = 0;
    for (const version of this.store.listVersions(run.artworkId)) {
      if (version.runId !== runId) continue;
      if (isTerminal('version', version.status)) continue;
      const status = transition('version', version.status, 'failed');
      this.store.updateVersion(version.id, { status, errorCode: 'run_ended', errorMessage: reason });
      this.#emit(runId, 'version.state', { versionId: version.id, status, detail: reason });
      closed++;
    }
    return closed;
  }

  /**
   * The head of the chain: the newest version with status `promoted`. The
   * records are ordered by generation, so the last promoted version is the
   * newest. The root version takes over when the chain holds nothing else.
   */
  #chainHead(run) {
    const versions = this.store.listVersions(run.artworkId);
    const promoted = versions.filter((version) => version.status === 'promoted');
    const head = promoted[promoted.length - 1];
    if (head) return head;
    const root = this.store.getVersion(run.rootVersionId) ?? this.store.getVersion(run.artwork?.rootVersionId ?? '');
    if (root) return root;
    throw new ArtworkError('version_not_found', 'This artwork has no promoted version to evolve');
  }

  /** The versions of one run whose snapshot publish job completed. */
  #publishedVersionIds(runId) {
    return new Set(
      this.store
        .listJobs(runId)
        .filter((job) => job.kind === 'publish' && job.state === 'done' && job.versionId)
        .map((job) => job.versionId),
    );
  }

  /**
   * Refactor one version: the code changes shape, the artwork does not.
   *
   * The acceptance test is the artwork itself. A frame is captured from the
   * published snapshot before the session runs, and again after it, at the same
   * seed and step. The refactor is kept only when the trail checksum is
   * unchanged: a refactor that changes the image is a behaviour change, and it
   * is rejected.
   */
  async refactorVersion({ versionId }) {
    const version = this.store.getVersion(versionId);
    if (!version) throw new ArtworkError('version_not_found', `No version ${versionId}`);
    if (version.status !== 'promoted') throw new ArtworkError('version_state_invalid', `Only a kept version can be refactored (${versionId} is ${version.status})`);
    const parent = version.parentId ? this.store.getVersion(version.parentId) : null;
    if (!parent) throw new ArtworkError('version_not_found', `Version ${versionId} has no parent to review against`);
    const run = this.store.getRun(version.runId ?? '') ?? this.#latestRunForArtwork(version.artworkId);
    if (!run) throw new ArtworkError('run_not_found', `Version ${versionId} has no run to record the refactor against`);
    const context = this.#artworkContext(version.artworkId);

    // 1. The baseline: the artwork as it is, before any edit.
    this.#emit(run.id, 'log', { level: 'info', message: `Refactoring ${version.title}: capturing the baseline frame` });
    const baseline = await this.#captureForCheck({ run, version, label: 'baseline' });

    // 2. The session works on a copy of the version's own package.
    const workspaceDir = join(this.config.dataDir, 'workspaces', run.id, `${versionId}-refactor`);
    await copyPackage(this.artifacts.snapshotDirFor(version), workspaceDir);
    const failure = new ArtworkError('refactor_failed', 'A refactor has no failure to repair.');
    const ran = await this.#repair({
      run,
      versionId,
      workspaceDir,
      failure,
      systemPrompt: REFACTOR_SYSTEM_PROMPT,
      prompt: buildRefactorPrompt({ manifest: context.manifest, configuration: version.configuration }),
      label: 'refactor',
    });
    if (!ran) throw new ArtworkError('refactor_failed', 'The refactor session did not finish');

    // 3. The edits must stay inside the manifest, and the package must be valid.
    const reviewed = await this.#validateCandidate({ run, versionId, workspaceDir, context, parent, phase: 'after-repair' });
    if (!reviewed.ok) {
      return { ok: false, version: this.store.getVersion(versionId), error: reviewed.error, baseline };
    }

    // 4. The configuration is frozen: a refactor must not move a number.
    if (sha256Hex(stableStringify(reviewed.configuration)) !== sha256Hex(stableStringify(version.configuration))) {
      const error = new ArtworkError('refactor_changed_config', 'The refactor changed config.json. A refactor must not move a number.');
      this.#emit(run.id, 'error', { code: error.code, message: error.message, detail: { versionId } });
      return { ok: false, version: this.store.getVersion(versionId), error, baseline };
    }

    // 5. Publish the refactored package, then check the artwork itself.
    let published;
    await this.#withJob({ run, round: version.round, kind: 'publish', versionId }, async () => {
      published = await publishSnapshot({
        workspaceDir,
        snapshotRoot: this.config.artifactsDir,
        artworkId: context.manifest.id,
        packageHash: reviewed.packageHash,
      });
    });
    const candidate = { ...version, snapshotPath: published.path, sourceHash: reviewed.packageHash, configuration: reviewed.configuration };
    let after;
    try {
      after = await this.#captureForCheck({ run, version: candidate, label: 'after' });
    } catch (error) {
      if (isBudgetStop(error) || this.#stopping(run.id)) throw error;
      return { ok: false, version: this.store.getVersion(versionId), error, baseline };
    }

    if (baseline.trailChecksum !== after.trailChecksum) {
      const error = new ArtworkError(
        'refactor_changed_image',
        `The refactor changed the image: the trail checksum was ${baseline.trailChecksum} and is now ${after.trailChecksum}.`,
        { before: baseline.trailChecksum, after: after.trailChecksum },
      );
      this.#emit(run.id, 'error', { code: error.code, message: error.message, detail: { versionId } });
      return { ok: false, version: this.store.getVersion(versionId), error, baseline };
    }

    // 6. Keep it. The snapshot path, the source hash, and the changes move; the
    //    artwork, the configuration, and the lineage stay.
    const updated = this.store.updateVersion(versionId, {
      sourceHash: reviewed.packageHash,
      snapshotPath: published.path,
      configuration: reviewed.configuration,
      changes: reviewed.changes,
      workspacePath: workspaceDir,
      explanation: truncate(`Refactor. ${after.title ?? ''}`.trim(), 4000),
      errorCode: null,
      errorMessage: null,
    });
    this.#emit(run.id, 'version.state', {
      versionId,
      status: 'promoted',
      detail: `refactored: the image is unchanged (trail checksum ${after.trailChecksum})`,
    });
    this.#emit(run.id, 'log', {
      level: 'info',
      message: `Refactored ${versionId}: the trail checksum is unchanged (${after.trailChecksum})`,
    });
    return { ok: true, version: updated, error: null, baseline, after };
  }

  /** Capture one frame for a comparison, and return its trail checksum. */
  async #captureForCheck({ run, version, label }) {
    const { viewport, seeds, stages, steps } = this.#protocol(run);
    const sample = { stage: 'refactor', seed: seeds[0], step: steps[steps.length - 1] };
    const outDir = join(this.config.dataDir, 'captures', `${version.id}-${label}`);
    const configurationHash = sha256Hex(stableStringify(version.configuration));
    const results = await withCaptureCeiling(
      this.capture.capture({
        liveBaseUrl: this.artifacts.liveUrlFor(version.id),
        snapshotDir: this.artifacts.snapshotDirFor(version),
        runtimeDir: this.artifacts.runtimeDir,
        nodeModulesDir: this.artifacts.nodeModulesDir(this.#artworkContext(run.artworkId).packageDir),
        samples: [{ ...sample, stage: stages[0] ?? 'late' }],
        viewport,
        timestep: CAPTURE_TIMESTEP,
        outDir,
        sourceHash: version.sourceHash,
        configurationHash,
        signal: this.active.get(run.id)?.abort.signal,
      }),
      this.config.capture.captureTimeoutMs + Math.max(5000, Math.round(this.config.capture.captureTimeoutMs * 0.2)),
    );
    const result = results[0];
    this.#emit(run.id, 'log', {
      level: 'info',
      message: `${label}: trail checksum ${result.trailChecksum} at step ${result.step} (${result.path})`,
    });
    return result;
  }

  /**
   * Revive a version that a rule refused, when that rule has since been
   * corrected. It re-captures the published snapshot and keeps the version when
   * the frame passes. No session runs, so a revive costs nothing.
   *
   * This is an operator correction of the record, not part of the loop.
   */
  async reviveVersion({ versionId }) {
    const version = this.store.getVersion(versionId);
    if (!version) throw new ArtworkError('version_not_found', `No version ${versionId}`);
    if (version.status === 'promoted') throw new ArtworkError('version_state_invalid', `${versionId} is already kept`);
    const run = this.store.getRun(version.runId ?? '') ?? this.#latestRunForArtwork(version.artworkId);
    if (!run) throw new ArtworkError('run_not_found', `Version ${versionId} has no run to record the capture against`);
    const wasRefused = version.errorCode ?? 'unknown';

    this.store.updateVersion(versionId, { status: 'capturing', errorCode: null, errorMessage: null });
    this.#emit(run.id, 'version.state', { versionId, status: 'capturing', detail: `an operator revived this step (was refused with ${wasRefused})` });
    try {
      const captures = await this.#captureVersion({ run, version: this.store.getVersion(versionId) });
      this.#promoteVersion(versionId, 'an operator revived this step');
      this.#emit(run.id, 'log', { level: 'info', message: `Revived ${versionId}: the frame passes, so the step is kept` });
      return { ok: true, version: this.store.getVersion(versionId), captures, wasRefused };
    } catch (error) {
      // The frame is still refused, so the version goes back as it was.
      this.store.updateVersion(versionId, {
        status: 'failed',
        errorCode: error.code ?? 'revive_failed',
        errorMessage: truncate(error?.message ?? String(error), 500),
      });
      this.#emit(run.id, 'version.state', { versionId, status: 'failed', detail: `the revive was refused: ${error?.message}` });
      return { ok: false, version: this.store.getVersion(versionId), error, wasRefused };
    }
  }

  /** The newest run of one artwork. The record for an operator action. */
  #latestRunForArtwork(artworkId) {
    const runs = this.store.listRuns(200).filter((run) => run.artworkId === artworkId);
    return runs[0] ?? null;
  }

  /**
   * Capture one frame for a version that has none. The imported root has no
   * capture until this runs, so its card can show a real frame.
   */  async captureFrame({ versionId }) {
    const version = this.store.getVersion(versionId);
    if (!version) throw new ArtworkError('version_not_found', `No version ${versionId}`);
    const run = this.store.getRun(version.runId ?? '') ?? this.#latestRunForArtwork(version.artworkId);
    if (!run) throw new ArtworkError('run_not_found', `Version ${versionId} has no run to record the frame against`);
    const existing = this.store.listCaptures(version.id);
    if (existing.length > 0) return existing.map(asCaptureResult);
    this.logger('info', `Capturing a frame for ${versionId} (${version.title})`);
    return this.#captureVersion({ run, version });
  }

  /**
   * Repair one failed version and continue its step.
   *
   * An operator action, not part of the loop. It starts from the failed
   * candidate's OWN published snapshot, so the repair fixes the code that
   * failed instead of throwing the attempt away. One repair session runs, then
   * the package is validated, published, captured, and kept.
   */
  async repairVersion({ versionId }) {
    const version = this.store.getVersion(versionId);
    if (!version) throw new ArtworkError('version_not_found', `No version ${versionId}`);
    if (version.status === 'promoted') throw new ArtworkError('version_state_invalid', `${versionId} is already kept`);
    const parent = version.parentId ? this.store.getVersion(version.parentId) : null;
    if (!parent) throw new ArtworkError('version_not_found', `Version ${versionId} has no parent to review against`);
    const run = this.store.getRun(version.runId ?? '') ?? this.#latestRunForArtwork(version.artworkId);
    if (!run) throw new ArtworkError('run_not_found', `Version ${versionId} has no run to record the repair against`);

    const context = this.#artworkContext(version.artworkId);
    const workspaceDir = join(this.config.dataDir, 'workspaces', run.id, `${versionId}-repair`);
    const failure = new ArtworkError(
      version.errorCode ?? 'candidate_failed',
      version.errorMessage ?? 'This step failed a technical check.',
      { repairedFrom: version.id },
    );

    // Start from the failed candidate's own snapshot. It was published before the
    // capture failed, so its intent is intact and only the fault is repaired.
    await copyPackage(this.artifacts.snapshotDirFor(version), workspaceDir);
    this.#emit(run.id, 'log', { level: 'info', message: `Repairing ${version.title}: ${failure.message}` });

    const repaired = await this.#repair({ run, versionId, workspaceDir, failure });
    if (!repaired) return { ok: false, version: this.store.getVersion(versionId), error: failure };

    // The repair fixed the code, so the version returns to the live machine and
    // its step continues. This is the only path from `failed` back.
    this.store.updateVersion(versionId, { status: 'capturing', errorCode: null, errorMessage: null });
    this.#emit(run.id, 'version.state', { versionId, status: 'capturing', detail: 'an operator repaired this step' });

    const reviewed = await this.#validateCandidate({ run, versionId, workspaceDir, context, parent, phase: 'after-repair' });
    if (!reviewed.ok) {
      this.#failVersion(versionId, reviewed.error);
      return { ok: false, version: this.store.getVersion(versionId), error: reviewed.error };
    }

    await this.#withJob({ run, round: version.round, kind: 'publish', versionId }, async () => {
      const published = await publishSnapshot({
        workspaceDir,
        snapshotRoot: this.config.artifactsDir,
        artworkId: context.manifest.id,
        packageHash: reviewed.packageHash,
      });
      this.store.updateVersion(versionId, {
        sourceHash: reviewed.packageHash,
        snapshotPath: published.path,
        configuration: reviewed.configuration,
        changes: reviewed.changes,
        workspacePath: workspaceDir,
      });
    });

    await this.#captureVersion({ run, version: this.store.getVersion(versionId) });
    this.#promoteVersion(versionId, 'an operator repaired this step');
    return { ok: true, version: this.store.getVersion(versionId), error: null };
  }

  // ── one step ──────────────────────────────────────────────────────────────

  /**
   * A reporter that reads the real files as well as the events. It replaces the
   * estimates with the true line count of every file, the true width of every
   * line, and the true size of each change.
   */
  #fileReporter(runId, versionId, workspaceDir) {
    const reader = new WorkspaceReader(workspaceDir);
    /** toolCallId -> the file that call touched. */
    const pending = new Map();
    /** The last path seen for each tool, for a call that carries no id. */
    const lastPathForTool = new Map();
    // A bound emitter: these methods are not called on the controller itself.
    const announceFile = (file) => this.#emit(runId, 'file', { versionId, ...file });

    return {
      /** Announce the package once, so the column shows the real file. */
      async announce() {
        const files = await walkPackage(workspaceDir);
        const described = await reader.inventory(files);
        for (const file of described) {
          announceFile({ kind: 'inventory', ...file });
        }
      },

      /** Read a file the session just wrote, and report the real change. */
      onEvent(event) {
        // The start event carries the arguments, the end event carries the
        // result, so the path is remembered in between.
        if (event?.type === 'tool_execution_start') {
          const path = event.args?.path ?? event.args?.file_path ?? null;
          if (typeof path === 'string' && path.length > 0) {
            pending.set(event.toolCallId ?? `${event.toolName}:${path}`, { tool: event.toolName, path });
            lastPathForTool.set(event.toolName, path);
          }
          return;
        }
        if (event?.type !== 'tool_execution_end' || event.isError === true) return;
        if (event.toolName !== 'edit' && event.toolName !== 'write') return;
        const remembered = pending.get(event.toolCallId ?? '') ?? null;
        pending.delete(event.toolCallId ?? '');
        const path = remembered?.path ?? lastPathForTool.get(event.toolName) ?? null;
        if (!path) return;
        // The session may still be flushing the write, so read on the next tick.
        setTimeout(() => {
          void reader
            .touched(path)
            .then((change) => {
              if (change) announceFile({ kind: 'change', ...change });
            })
            .catch(() => {});
        }, 80);
      },
    };
  }

  /** Map the session events of one version to feed rows on the run stream. */
  #agentReporter(runId, versionId) {
    let lastTextAt = 0;
    let lastReasonAt = 0;
    return (event) => {
      for (const row of feedRows(event, versionId)) {
        // The text and the reasoning arrive token by token. Keep the ticker
        // readable and the stream small.
        if (row.kind === 'text' || row.kind === 'reason') {
          const now = Date.now();
          if (row.kind === 'text' && now - lastTextAt < 500) continue;
          if (row.kind === 'reason' && now - lastReasonAt < 500) continue;
          if (row.kind === 'text') lastTextAt = now;
          if (row.kind === 'reason') lastReasonAt = now;
        }
        this.#emit(runId, 'agent', row);
      }
    };
  }

  async #runStep({ run, round, parent }) {
    const isolation = await this.capture.available();
    const localOnly = isLocalHost(this.config.host);
    const sourceMode = decideSourceMode({
      status: isolation,
      touchesSource: true,
      requireIsolation: this.config.safety.requireIsolation,
      localOnly,
    });
    assertSourceMode({ mode: sourceMode, status: isolation, touchesSource: true, localOnly });
    if (sourceMode === 'sandboxed-browser' && round === 1) {
      this.#emit(run.id, 'log', {
        level: 'warn',
        message: 'Source changes run in the sandboxed artwork page, not in a container. The page has no credentials, no network, and no host access.',
      });
    }

    // The provider extension fetches its model list as a session starts and
    // keeps it in memory only: a failed fetch there leaves no provider at all.
    // Check the catalog before a step spends anything.
    if (typeof this.provider.probe === 'function') {
      const health = await this.provider.probe();
      if (!health.ok) {
        throw new ArtworkError('provider_unavailable', `The provider catalog did not answer: ${health.detail}`, { probe: health });
      }
    }

    const paused = () => Boolean(this.active.get(run.id)?.paused);

    // A resumed step reuses the child an interrupted attempt already published.
    // A published snapshot is immutable, so capture and promotion continue from
    // it without repeating a paid author session.
    const publishedBefore = this.#publishedVersionIds(run.id);
    const prior = this.store
      .listVersions(run.artworkId)
      .find(
        (version) =>
          version.runId === run.id &&
          version.round === round &&
          publishedBefore.has(version.id) &&
          // A version that failed a real check is never reused. Only an
          // interruption of already published work may continue.
          !(version.status === 'failed' && version.errorCode !== 'interrupted_by_restart'),
      );
    if (prior) {
      // A restart can leave a version that was already published marked failed.
      // Its paid work is durable, so the step continues instead of paying again.
      if (prior.status === 'failed' && prior.errorCode === 'interrupted_by_restart') {
        this.store.updateVersion(prior.id, { status: 'capturing', errorCode: null, errorMessage: null });
        this.#emit(run.id, 'version.state', {
          versionId: prior.id,
          status: 'capturing',
          detail: 'the published snapshot of this step is reused after the restart',
        });
      }
      this.#emit(run.id, 'run.round', {
        round,
        phase: 'author',
        detail: `reusing ${prior.title} that this run already published`,
      });
    }

    // A reused child is already durable, so it needs no author session.
    const authored = prior ? { version: prior, ok: true } : await this.#createChild({ run, round, parent });
    const child = authored.version;
    const candidateIds = [child.id];

    if (paused()) {
      return { interrupted: true, promoted: false, winnerVersionId: null, candidateIds, note: 'The run was paused during this step, so the parent stays.' };
    }

    // The candidate failed authoring or validation: the version is recorded as
    // failed with its reason, the chain head stays, and the next step starts
    // from the last good version.
    if (!authored.ok) {
      const reason = child.errorMessage ?? authored.error?.message ?? 'The candidate failed a technical check.';
      return { promoted: false, winnerVersionId: null, candidateIds, note: reason };
    }

    // The frame is the evidence of the step, and a capture can fail on a
    // technical fault: the artwork throws at load, or the trail died. That is
    // the same class of fault as a rejected package, so it gets the same one
    // bounded repair session before the step is given up.
    let failure = null;
    try {
      await this.#captureVersion({ run, version: child });
    } catch (error) {
      // A limit ends the RUN; it must not burn the remaining steps as a run of
      // technical candidate failures.
      if (isBudgetStop(error)) throw error;
      if (this.#stopping(run.id)) throw error;
      failure = error;
    }
    if (failure && this.config.evolution.repairAttempts > 0 && failure.code !== 'capture_timeout') {
      // A timeout is an infrastructure fault, not a fault of the code, so it
      // does not spend a repair session.
      const outcome = await this.#repairAndRecapture({ run, round, versionId: child.id, workspaceDir: child.workspacePath, parent, failure });
      failure = outcome.ok ? null : outcome.error;
    }
    if (failure) {
      this.#failVersion(child.id, failure);
      return { promoted: false, winnerVersionId: null, candidateIds, note: `The frame could not be captured: ${truncate(failure?.message ?? String(failure), 200)}` };
    }

    // A promotion fault is a fault of this step, never of the run: the card is
    // recorded as failed and the next step starts from the last good version.
    try {
      this.#promoteVersion(child.id, `step ${round}: the child is always kept`);
    } catch (error) {
      this.logger('error', `Step ${round}: ${child.id} could not be promoted: ${error.message}`);
      this.#failVersion(child.id, error);
      return { promoted: false, winnerVersionId: null, candidateIds, note: `The step could not be kept: ${truncate(error?.message ?? String(error), 200)}` };
    }
    const promoted = this.store.getVersion(child.id) ?? child;
    return { promoted: true, winnerVersionId: child.id, candidateIds, note: `${promoted.title} evolved from ${parent.title}.` };
  }

  /**
   * Repair a workspace whose frame failed, then validate, publish, and capture
   * it again. A repaired workspace is a new package, so it must be reviewed and
   * published again before the frame can be trusted.
   */
  async #repairAndRecapture({ run, round, versionId, workspaceDir, parent, failure }) {
    const context = this.#artworkContext(run.artworkId);
    const repaired = await this.#repair({ run, versionId, workspaceDir, failure });
    if (!repaired) return { ok: false, error: failure };

    const reviewed = await this.#validateCandidate({ run, versionId, workspaceDir, context, parent, phase: 'after-repair' });
    if (!reviewed.ok) return { ok: false, error: reviewed.error };

    try {
      await this.#withJob({ run, round, kind: 'publish', versionId }, async () => {
        const published = await publishSnapshot({
          workspaceDir,
          snapshotRoot: this.config.artifactsDir,
          artworkId: context.manifest.id,
          packageHash: reviewed.packageHash,
        });
        this.store.updateVersion(versionId, {
          sourceHash: reviewed.packageHash,
          snapshotPath: published.path,
          configuration: reviewed.configuration,
          changes: reviewed.changes,
        });
      });
      await this.#captureVersion({ run, version: this.store.getVersion(versionId) });
      return { ok: true, error: null };
    } catch (error) {
      if (isBudgetStop(error) || this.#stopping(run.id)) throw error;
      return { ok: false, error };
    }
  }

  /** Create the child row and copy the parent package into its workspace. */
  async #createChild({ run, round, parent }) {
    const context = this.#artworkContext(run.artworkId);
    const versionId = newId('ver');
    const workspaceDir = join(this.config.dataDir, 'workspaces', run.id, versionId);
    const version = this.store.createVersion({
      id: versionId,
      artworkId: run.artworkId,
      parentId: parent.id,
      runId: run.id,
      generation: parent.generation + 1,
      round,
      // The title is the CHAIN position, so it agrees with the card name when a
      // second run continues the chain.
      title: `Step ${parent.generation + 1}`,
      status: 'queued',
      sourceHash: parent.sourceHash,
      snapshotPath: parent.snapshotPath,
      workspacePath: workspaceDir,
      configuration: parent.configuration,
      changes: [],
      onLineage: false,
    });
    this.#emit(run.id, 'version.created', { version: this.#publicVersion(version) });

    try {
      await copyPackage(this.artifacts.snapshotDirFor(parent), workspaceDir);
      await this.#withJob({ run, round, kind: 'author', versionId }, async (job) => {
        this.#setVersionState(versionId, 'authoring');
        // Read the package before the session changes it, then follow the writes.
        const files = this.#fileReporter(run.id, versionId, workspaceDir);
        const agent = this.#agentReporter(run.id, versionId);
        await files.announce();
        // Tell the session what this run already did, so a change an earlier
        // step made is not applied again.
        const earlier = this.store.listRounds(run.id).filter((entry) => entry.round > 0 && entry.round < round);
        const history = [
          ...earlier.map((entry) => `step ${entry.round}: ${truncate(entry.note ?? 'no note', 160)}`),
          ...parent.changes.slice(0, 8).map((change) => `the parent changed ${change.path} (+${change.added} -${change.removed})`),
        ];
        const prompt = buildEvolvePrompt({
          instruction: STEP_INSTRUCTION,
          manifest: context.manifest,
          parentConfiguration: parent.configuration,
          history,
        });
        const images = this.#chainFrames(parent, 3).map((frame) => frame.path);
        const sessionId = `phygen-${versionId}`;
        const attemptCall = (attempt) =>
          this.#providerCall({
            run,
            kind: 'author',
            label: attempt === 1 ? `author:${versionId}` : `author-retry:${versionId}`,
            versionId,
            call: (signal) =>
              this.provider.author({
                workspaceDir,
                prompt,
                images,
                systemPrompt: EVOLVE_SYSTEM_PROMPT,
                model: run.protocol?.authorModel,
                onEvent: (event) => {
                  agent(event);
                  files.onEvent(event);
                },
                sessionId,
                signal,
                round,
                parentConfig: parent.configuration,
                seedKey: run.id,
              }),
          });

        // A gateway error while the session starts is worth one more try: the
        // provider extension fetches its catalog as the process starts, and a
        // 500 there fails the session before any work happens.
        let result;
        try {
          result = await attemptCall(1);
        } catch (error) {
          if (isBudgetStop(error) || !isTransientProviderError(error)) throw error;
          this.#emit(run.id, 'log', {
            level: 'warn',
            message: `The author session failed before it started (${error.code}): ${truncate(error.message, 200)}. One more try in 20 seconds.`,
          });
          await this.#abortableDelay(run.id, 20000);
          try {
            result = await attemptCall(2);
          } catch (retry) {
            if (isBudgetStop(retry) || !isTransientProviderError(retry)) throw retry;
            // The extension keeps its model list in memory only, so a slow
            // gateway needs patience rather than another dead candidate.
            this.#emit(run.id, 'log', {
              level: 'warn',
              message: 'The provider failed a second time. One last try in 60 seconds.',
            });
            await this.#abortableDelay(run.id, 60000);
            result = await attemptCall(3);
          }
        }
        this.store.updateVersion(versionId, {
          explanation: truncate(result.text, 4000),
          title: titleFromExplanation(result.text, parent.generation + 1),
        });
        this.#emit(run.id, 'version.state', { versionId, status: 'authoring', detail: `author session ${result.sessionId ?? 'unknown'} finished` });
      });

      this.#setVersionState(versionId, 'validating');
      const reviewed = await this.#validateCandidate({ run, versionId, workspaceDir, context, parent, phase: 'first' });
      if (!reviewed.ok) {
        this.#failVersion(versionId, reviewed.error);
        return { version: this.store.getVersion(versionId), ok: false, error: reviewed.error };
      }
      await this.#withJob({ run, round, kind: 'publish', versionId }, async () => {
        const published = await publishSnapshot({
          workspaceDir,
          snapshotRoot: this.config.artifactsDir,
          artworkId: context.manifest.id,
          packageHash: reviewed.packageHash,
        });
        this.store.updateVersion(versionId, {
          sourceHash: reviewed.packageHash,
          snapshotPath: published.path,
          configuration: reviewed.configuration,
          changes: reviewed.changes,
          workspacePath: workspaceDir,
        });
        this.#emit(run.id, 'version.state', {
          versionId,
          status: 'validating',
          detail: `source hash ${reviewed.packageHash.slice(0, 12)}`,
        });
      });
      return { version: this.store.getVersion(versionId), ok: true };
    } catch (error) {
      // A configured limit ends the RUN; it must not burn the remaining
      // steps as a run of technical candidate failures.
      if (isBudgetStop(error)) throw error;
      // A Stop cancels the session. The run ends; this must not be recorded as
      // a candidate fault or as a consumed step.
      if (this.#stopping(run.id)) throw error;
      // A provider that went away mid-run pauses the run, not the candidate.
      if (isTransientProviderError(error)) {
        throw new ArtworkError('provider_unavailable', `The author session did not answer: ${truncate(error?.message ?? String(error), 300)}`, {
          round,
          cause: error?.code ?? 'unknown',
        });
      }
      this.#failVersion(versionId, error);
      return { version: this.store.getVersion(versionId), ok: false, error };
    }
  }

  /**
   * The last `count` frames of the chain, newest first: the parent, then the
   * two versions before it. Each version holds one late capture.
   */
  #chainFrames(parent, count) {
    const lineage = this.store.lineage(parent.id);
    const frames = [];
    for (const version of [...lineage].reverse()) {
      const captures = this.store.listCaptures(version.id);
      if (captures.length === 0) continue;
      const latest = captures[captures.length - 1];
      frames.push({ versionId: version.id, path: latest.path, url: `/api/captures/${latest.id}.png` });
      if (frames.length >= count) break;
    }
    return frames;
  }

  /** Review the edits, repair once, then check the package and its configuration. */
  async #validateCandidate({ run, versionId, workspaceDir, context, parent, phase }) {
    // The parent package is the baseline: the report then names exactly what
    // THIS step changed, and the protected paths are checked against it.
    const review = await reviewEdits({ originalDir: this.artifacts.snapshotDirFor(parent), workspaceDir, manifest: context.manifest });
    if (review.violations.length > 0) {
      return { ok: false, error: new ArtworkError('edit_surface_violation', review.violations[0], { violations: review.violations }) };
    }

    const check = await checkPackage({ packageDir: workspaceDir, verifyEntry: false });
    if (!check.ok) {
      const failure = new ArtworkError('package_invalid', check.problems[0] ?? 'The candidate package is invalid', { problems: check.problems });
      if (phase === 'first' && this.config.evolution.repairAttempts > 0) {
        const repair = await this.#repair({ run, versionId, workspaceDir, failure });
        if (repair) return this.#validateCandidate({ run, versionId, workspaceDir, context, parent, phase: 'after-repair' });
      }
      return { ok: false, error: failure };
    }

    let configuration;
    try {
      configuration = JSON.parse(await readFile(join(workspaceDir, context.manifest.configuration.baseline), 'utf8'));
      validateConfiguration(configuration, context.schema);
    } catch (error) {
      const failure = new ArtworkError('configuration_invalid', `The candidate configuration is invalid: ${error.message}`, error.details ?? {});
      if (phase === 'first' && this.config.evolution.repairAttempts > 0) {
        const repair = await this.#repair({ run, versionId, workspaceDir, failure });
        if (repair) return this.#validateCandidate({ run, versionId, workspaceDir, context, parent, phase: 'after-repair' });
      }
      return { ok: false, error: failure };
    }

    const configurationHash = sha256Hex(stableStringify(configuration));
    return {
      ok: true,
      packageHash: check.packageHash,
      configuration,
      configurationHash,
      changes: review.changes.map((change) => ({ ...change, summary: change.status })),
    };
  }

  /**
   * Run one bounded session that edits a workspace in place.
   *
   * A repair uses the default prompt and system prompt. A refactor passes its
   * own, so one helper serves both and the budget label stays exact.
   */
  async #repair({ run, versionId, workspaceDir, failure, systemPrompt, prompt, label }) {
    const isRefactor = label === 'refactor';
    this.#emit(run.id, 'version.state', {
      versionId,
      status: 'validating',
      detail: isRefactor ? 'a refactor session' : `one repair attempt: ${failure.code}`,
    });
    try {
      await this.#withJob({ run, round: null, kind: 'author', versionId }, async () => {
        await this.#providerCall({
          run,
          kind: 'author',
          label: isRefactor ? `refactor:${versionId}` : `repair:${versionId}`,
          versionId,
          call: (signal) =>
            this.provider.author({
              workspaceDir,
              prompt: prompt ?? buildRepairPrompt({ failure }),
              model: run.protocol?.authorModel,
              onEvent: this.#agentReporter(run.id, versionId),
              systemPrompt: systemPrompt ?? EVOLVE_SYSTEM_PROMPT,
              sessionId: `phygen-${versionId}${isRefactor ? '-refactor' : ''}`,
              signal,
            }),
        });
      });
      return true;
    } catch (error) {
      this.logger('warn', `${isRefactor ? 'Refactor' : 'Repair'} attempt for ${versionId} failed: ${error.message}`);
      return false;
    }
  }

  // ── capture ───────────────────────────────────────────────────────────────

  /** The frame protocol of one run: the run's own values, or the configured defaults. */
  #protocol(run) {    const protocol = run.protocol ?? {};
    return {
      viewport: protocol.viewport ?? this.config.evolution.viewport,
      seeds: protocol.seeds ?? this.config.evolution.seeds,
      stages: protocol.frameRoles ?? this.config.evolution.frameRoles,
      steps: protocol.stepSchedule ?? this.config.evolution.stepSchedule,
    };
  }

  async #captureVersion({ run, version }) {
    const { viewport, seeds, stages, steps } = this.#protocol(run);
    const context = this.#artworkContext(run.artworkId);
    const outDir = join(this.config.dataDir, 'captures', version.id);
    const configurationHash = sha256Hex(stableStringify(version.configuration));
    const samples = [];
    for (const seed of seeds) {
      stages.forEach((stage, index) => {
        samples.push({ stage, step: steps[Math.min(index, steps.length - 1)], seed });
      });
    }

    // A resumed step must not duplicate or overwrite frame evidence. A frame
    // this version already captured for the same seed, stage, step and inputs
    // is reused as it is.
    const existing = new Map(
      this.store
        .listCaptures(version.id)
        .filter((capture) => capture.sourceHash === version.sourceHash && capture.configurationHash === configurationHash)
        .map((capture) => [`${capture.stage}|${capture.seed}|${capture.step}`, capture]),
    );
    const reused = [];
    const missing = [];
    for (const sample of samples) {
      const found = existing.get(`${sample.stage}|${sample.seed}|${sample.step}`);
      if (found) reused.push(asCaptureResult(found));
      else missing.push(sample);
    }

    return this.#withJob({ run, round: version.round, kind: 'capture', versionId: version.id }, async (job) => {
      // Read the current record: the caller may hold a snapshot from an earlier
      // stage, and a stale status must not drive a transition.
      const current = this.store.getVersion(version.id) ?? version;
      if (canTransition('version', current.status, 'capturing')) this.#setVersionState(version.id, 'capturing');
      if (missing.length === 0) return reused;
      const results = await withCaptureCeiling(
        this.capture.capture({
          liveBaseUrl: this.artifacts.liveUrlFor(version.id),
          snapshotDir: this.artifacts.snapshotDirFor(version),
          runtimeDir: this.artifacts.runtimeDir,
          nodeModulesDir: this.artifacts.nodeModulesDir(context.packageDir),
          samples: missing,
          viewport,
          timestep: CAPTURE_TIMESTEP,
          outDir,
          sourceHash: version.sourceHash,
          configurationHash,
          signal: this.active.get(run.id)?.abort.signal,
        }),
        // The ceiling is the configured capture time plus a startup margin.
        this.config.capture.captureTimeoutMs * Math.max(1, missing.length) +
          Math.max(5000, Math.round(this.config.capture.captureTimeoutMs * 0.2)),
      );


      for (const result of results) {
        const record = this.store.createCapture({
          versionId: version.id,
          runId: run.id,
          stage: result.stage,
          seed: result.seed,
          step: result.step,
          width: result.width,
          height: result.height,
          dpr: result.dpr,
          rendererBackend: result.rendererBackend,
          sourceHash: version.sourceHash,
          configurationHash,
          path: result.path,
          bytes: (await stat(result.path)).size,
          meta: {
            url: result.url,
            fps: result.fps,
            iteration: result.iteration,
            trailChecksum: result.trailChecksum,
            agentChecksum: result.agentChecksum,
            timestep: result.timestep,
            consoleErrors: result.consoleErrors,
          },
        });
        // The card shows the newest frame while the capture continues.
        this.#emit(run.id, 'capture.ready', {
          versionId: version.id,
          captureId: record.id,
          stage: record.stage,
          step: record.step,
          seed: record.seed,
          url: `/api/captures/${record.id}.png`,
        });
      }
      return [...reused, ...results];
    });
  }

  // ── provider and job plumbing ──────────────────────────────────────────────

  /** Reserve the bound, call the provider, then commit the real cost. */
  async #providerCall({ run, kind, label, versionId, call }) {
    const bound = label.startsWith('repair:') || label.startsWith('refactor:') ? this.config.cost.repairCallUsd : this.config.cost.authorCallUsd;

    // Never start a request for a run that is stopping, and never start one
    // that a configured limit already refuses.
    if (this.#stopping(run.id)) throw new ArtworkError('cancelled', 'The run stopped before the provider request');
    this.budget.assertRunLimits(this.store.getRun(run.id));

    const requestId = newId('req');
    const model = run.protocol?.authorModel ?? this.config.provider.authorModel;

    const fresh = this.store.getRun(run.id);
    // The run holds one overall reservation until the first request replaces it
    // with per-request reservations.
    if (this.budget.reservations(run.id).has('run-estimate')) {
      this.budget.release(run.id, 'run-estimate');
    }
    this.budget.reserve(fresh, bound, label);
    let result;
    try {
      if (this.#stopping(run.id)) throw new ArtworkError('cancelled', 'The run stopped before the provider request');
      result = await call(this.active.get(run.id)?.abort.signal);
    } catch (error) {
      // A session that timed out or failed may still cost money. Charge what
      // the provider reported, and record which request it was.
      const spent = error?.details?.usage;
      if (spent && (spent.inputTokens > 0 || spent.outputTokens > 0 || spent.costUsd > 0)) {
        const committed = this.budget.commit(run.id, label, {
          reportedUsd: spent.costUsd ?? 0,
          boundUsd: bound,
          costKnown: spent.costKnown === true,
          inputTokens: spent.inputTokens ?? 0,
          outputTokens: spent.outputTokens ?? 0,
        });
        this.store.createUsage({
          runId: run.id,
          versionId,
          kind,
          model,
          sessionId: null,
          inputTokens: spent.inputTokens ?? 0,
          outputTokens: spent.outputTokens ?? 0,
          costUsd: committed.charged,
          raw: {
            ...(spent.raw ?? {}),
            costSource: committed.costSource,
            label,
            requestId,
            attempt: label,
            outcome: error.code ?? 'failed',
            certainty: 'uncertain',
          },
        });
        this.#emit(run.id, 'usage', {
          model,
          inputTokens: spent.inputTokens ?? 0,
          outputTokens: spent.outputTokens ?? 0,
          costUsd: committed.charged,
          costSource: committed.costSource,
          spentUsd: committed.run.spentUsd,
          limitUsd: this.budget.limitFor(committed.run),
          detail: `the ${kind} session did not finish (${error.code ?? 'failed'})`,
        });
      } else {
        this.budget.release(run.id, label);
      }
      throw error;
    }

    const usage = result.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, raw: {} };
    const committed = this.budget.commit(run.id, label, {
      reportedUsd: usage.costUsd ?? 0,
      boundUsd: bound,
      costKnown: usage.costKnown === true,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
    });
    this.store.createUsage({
      runId: run.id,
      versionId,
      kind,
      model: result.model ?? model,
      sessionId: result.sessionId ?? null,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      costUsd: committed.charged,
      raw: { ...usage.raw, costSource: committed.costSource, stub: result.stub ?? false, label, requestId, attempt: label, certainty: 'known' },
    });
    this.#emit(run.id, 'usage', {
      model: result.model ?? model,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      costUsd: committed.charged,
      costSource: committed.costSource,
      spentUsd: committed.run.spentUsd,
      limitUsd: this.budget.limitFor(committed.run),
    });
    return result;
  }

  /** Run one job: take a lease, publish every transition, release the lease. */
  async #withJob({ run, round, kind, versionId }, work) {
    const job = this.store.createJob({ runId: run.id, versionId, round, kind, state: 'queued' });
    const owner = `${process.pid}-${newId('w')}`;
    this.leases.set(job.id, owner);
    this.#emit(run.id, 'job.state', { jobId: job.id, kind, state: 'queued', detail: `round ${round ?? '-'}` });
    this.store.updateJob(job.id, {
      state: transition('job', 'queued', 'running'),
      leaseOwner: owner,
      leaseExpiresAt: new Date(Date.now() + LEASE_MS).toISOString(),
      attempts: job.attempts + 1,
    });
    this.#emit(run.id, 'job.state', { jobId: job.id, kind, state: 'running' });
    try {
      const result = await work(job);
      this.store.updateJob(job.id, { state: transition('job', 'running', 'done'), result: { ok: true } });
      this.#emit(run.id, 'job.state', { jobId: job.id, kind, state: 'done' });
      return result;
    } catch (error) {
      const cancelled = this.active.get(run.id)?.abort.signal.aborted;
      const nextState = cancelled ? 'cancelled' : 'failed';
      this.store.updateJob(job.id, {
        state: nextState,
        errorCode: error?.code ?? 'job_failed',
        errorMessage: truncate(error?.message ?? String(error), 500),
      });
      this.#emit(run.id, 'job.state', { jobId: job.id, kind, state: nextState, detail: error?.code ?? 'job_failed' });
      throw error;
    } finally {
      this.leases.delete(job.id);
    }
  }

  // ── record helpers ────────────────────────────────────────────────────────

  #artworkContext(artworkId) {
    if (this.contexts.has(artworkId)) return this.contexts.get(artworkId);
    const artwork = this.store.getArtwork(artworkId);
    if (!artwork) throw new ArtworkError('artwork_not_found', `No artwork ${artworkId}`);
    const context = this.artifacts.artworkContext(artwork);
    this.contexts.set(artworkId, context);
    return context;
  }

  #publicVersion(version) {
    return {
      id: version.id,
      parentId: version.parentId,
      generation: version.generation,
      round: version.round,
      title: version.title,
      status: version.status,
      onLineage: version.onLineage,
      livePath: `/live/${version.id}`,
      sourceHash: version.sourceHash,
      createdAt: version.createdAt,
    };
  }

  #setRunState(runId, to, patch = {}) {
    const run = this.store.getRun(runId);
    const state = transition('run', run.state, to);
    const updated = this.store.updateRun(runId, { ...patch, state });
    this.#emit(runId, 'run.state', { state, stopReason: updated.stopReason ?? null, evolutionsDone: updated.evolutionsDone });
    return updated;
  }

  #setVersionState(versionId, to, patch = {}) {
    const version = this.store.getVersion(versionId);
    const status = transition('version', version.status, to);
    const updated = this.store.updateVersion(versionId, { ...patch, status });
    this.#emit(version.runId ?? null, 'version.state', { versionId, status, parentId: version.parentId, title: version.title, generation: version.generation });
    return updated;
  }

  #promoteVersion(versionId, reason) {
    const version = this.store.getVersion(versionId);
    const status = transition('version', version.status, 'promoted');
    const updated = this.store.updateVersion(versionId, { status, onLineage: true });
    this.#emit(version.runId, 'version.state', { versionId, status, detail: reason, onLineage: true });
    return updated;
  }

  #failVersion(versionId, error) {
    const version = this.store.getVersion(versionId);
    if (!version) return null;
    if (['promoted', 'failed'].includes(version.status)) return version;
    const status = transition('version', version.status, 'failed');
    const updated = this.store.updateVersion(versionId, {
      status,
      errorCode: error?.code ?? 'candidate_failed',
      errorMessage: truncate(error?.message ?? String(error), 500),
    });
    this.#emit(version.runId, 'version.state', {
      versionId,
      status,
      detail: truncate(error?.message ?? String(error), 300),
      errorCode: error?.code ?? 'candidate_failed',
      errorDetail: error?.details ?? {},
    });
    this.#emit(version.runId, 'error', { code: error?.code ?? 'candidate_failed', message: truncate(error?.message ?? String(error), 300), detail: { versionId } });
    return updated;
  }

  #emit(runId, type, payload) {
    if (!runId) return null;
    return this.events.emit(runId, type, payload);
  }
}
