// ─────────────────────────────────────────────────────────────────────────────
// run.mjs — the run controller.
//
// The controller owns budgets, round counts, selection rules, and job state.
// Agents never enforce their own limits.
//
// One round is:
//   plan 3 candidates → author each in its own workspace → review the edits →
//   validate the package → publish a snapshot → capture parent and candidates →
//   judge the images → capture dense frames for the finalist → compare the
//   finalist against the parent in a fresh session with the order reversed →
//   promote, or keep the parent.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { ArtworkError } from '../../../runtime/contract.js';
import { validateConfiguration } from '../../../runtime/config.js';
import { checkPackage, walkPackage } from '../../../runtime/node/package-checks.js';

import { mapLimit, newId, nowIso, sha256Hex, sleep, stableStringify, truncate, unique } from '../util.mjs';
import { canTransition, isTerminal, transition } from '../state.mjs';
import { copyPackage, publishSnapshot, reviewEdits } from '../artwork/workspace.mjs';
import { assertSourceMode, decideSourceMode, isLocalHost } from '../capture/index.mjs';
import { isTransientProviderError } from '../providers/index.mjs';
import { extractJson } from '../providers/json.mjs';
import {
  JUDGE_SYSTEM_PROMPT,
  assignLabels,
  buildJudgePrompt,
  decideWinner,
  validateVerdict,
  verdictsAgree,
  JudgeError,
} from '../judge/protocol.mjs';
import { AUTHOR_SYSTEM_PROMPT, buildAuthorPrompt, buildRepairPrompt } from './prompts.mjs';
import { feedRows } from './agent-events.mjs';
import { WorkspaceReader } from './workspace-reader.mjs';
import { planRound } from './plan.mjs';

const CAPTURE_TIMESTEP = 8;
const LEASE_MS = 120000;

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

  /** Pause stops new tasks. The current bounded task finishes. */
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
   */
  async recover() {
    const recovered = [];
    const failures = [];
    for (const run of this.store.listActiveRuns()) {
      try {
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
          if (version.runId === run.id && ['queued', 'authoring', 'validating', 'capturing', 'judging'].includes(version.status)) {
            this.store.updateVersion(version.id, { status: 'failed', errorCode: 'interrupted_by_restart', errorMessage: 'The server restarted during this stage. A new candidate replaces it.' });
          }
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
    let run = this.store.getRun(runId);
    try {
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

        const round = run.evolutionsDone + 1;
        const parent = this.#lineageHead(run);
        this.#emit(runId, 'run.round', { round, phase: 'author', parentVersionId: parent.id });
        this.logger('info', `Run ${runId} round ${round}: parent ${parent.id}`);

        const outcome = await this.#runRound({ run, round, parent });
        const state = this.store.getRun(runId);
        const next = this.store.updateRun(runId, {
          evolutionsDone: state.evolutionsDone + 1,
          unchangedRounds: outcome.promoted ? 0 : state.unchangedRounds + 1,
        });
        // A resumed round keeps the earlier candidate set in the record.
        const previousRound = this.store.listRounds(runId).find((entry) => entry.round === round);
        this.store.upsertRound({
          runId,
          round,
          parentVersionId: parent.id,
          candidateIds: unique([...(previousRound?.candidateIds ?? []), ...outcome.candidateIds]),
          winnerVersionId: outcome.winnerVersionId,
          promoted: outcome.promoted,
          note: outcome.note,
        });
        for (const candidateId of outcome.candidateIds) {
          if (candidateId === outcome.winnerVersionId) continue;
          this.store.createEvaluation({ runId, round, versionId: candidateId, outcome: 'rejected', note: outcome.note });
        }
        this.#emit(runId, 'run.round', {
          round,
          phase: 'done',
          promoted: outcome.promoted,
          winnerVersionId: outcome.winnerVersionId,
          note: outcome.note,
        });
        this.logger('info', `Run ${runId} round ${round} finished: ${outcome.promoted ? `promoted ${outcome.winnerVersionId}` : 'parent retained'}`);
        void next;
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
        return;
      }
      // A provider that is unavailable is not the fault of the work. Pause the
      // run so a person can resume it when the provider answers again, instead
      // of failing the job and losing the remaining evolutions.
      if (error?.code === 'provider_unavailable') {
        const current = this.store.getRun(runId);
        if (!['stopped', 'completed', 'failed'].includes(current.state)) {
          const paused = this.#setRunState(runId, 'paused', { stopReason: 'provider_unavailable' });
          this.#emit(runId, 'log', {
            level: 'warn',
            message: `The run paused because the provider did not answer: ${error.message} Resume it when the provider is back.`,
          });
          this.logger('warn', `Run ${runId} paused: ${error.message}`);
          void paused;
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
    for (const dir of [join(this.config.dataDir, 'workspaces', runId), join(this.config.dataDir, 'judge', runId)]) {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
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

  #lineageHead(run) {
    const rounds = this.store.listRounds(run.id).filter((round) => round.promoted && round.winnerVersionId);
    if (rounds.length === 0) return this.store.getVersion(run.rootVersionId);
    return this.store.getVersion(rounds[rounds.length - 1].winnerVersionId);
  }

  // ── one round ─────────────────────────────────────────────────────────────

  async #runRound({ run, round, parent }) {
    const isolation = await this.capture.available();
    const localOnly = isLocalHost(this.config.host);
    const sourceMode = decideSourceMode({
      status: isolation,
      touchesSource: true,
      requireIsolation: this.config.safety.requireIsolation,
      localOnly,
    });
    assertSourceMode({ mode: sourceMode, status: isolation, touchesSource: true, localOnly });
    if (sourceMode === 'sandboxed-browser') {
      this.#emit(run.id, 'log', {
        level: 'warn',
        message: 'Source changes run in the sandboxed artwork page, not in a container. The page has no credentials, no network, and no host access.',
      });
    }
    const paused = () => Boolean(this.active.get(run.id)?.paused);

    // The provider extension fetches its model list as a session starts and
    // keeps it in memory only: a failed fetch there leaves no provider at all.
    // Check the catalog before a level spends anything.
    if (typeof this.provider.probe === 'function') {
      const health = await this.provider.probe();
      if (!health.ok) {
        throw new ArtworkError('provider_unavailable', `The provider catalog did not answer: ${health.detail}`, { probe: health });
      }
    }
    const variants = run.protocol?.variantsPerEvolution ?? this.config.evolution.variants;
    const plans = planRound({
      level: round,
      direction: run.direction,
      variants,
      unchangedLevels: run.unchangedRounds,
      redirectAfter: this.config.evolution.unchangedRoundsBeforeRedirect,
    });

    // Several sessions at once: faster, and the tree shows them together.
    const authored = await mapLimit(plans, Math.max(1, this.config.evolution.authorConcurrency), async (plan) => {
      // A pause must stop new paid work, not only new rounds.
      if (paused()) return { version: null, ok: false, paused: true };
      return this.#authorCandidate({ run, round, parent, plan });
    });
    const candidates = authored.filter((entry) => entry.version && entry.ok);
    const candidateIds = authored.map((entry) => entry.version?.id).filter(Boolean);

    if (paused()) {
      this.#rejectOtherCandidates(candidates.map((entry) => entry.version), null, 'The run was paused during authoring.');
      return { promoted: false, winnerVersionId: parent.id, candidateIds, note: 'The run was paused during authoring, so the parent stays.' };
    }

    if (candidates.length === 0) {
      const failures = authored.map((entry) => entry.error).filter(Boolean);
      // A provider that is down fails every session. Stop the run instead of
      // spending the remaining evolutions on the same fault.
      if (failures.length > 0 && failures.every((error) => isTransientProviderError(error))) {
        throw new ArtworkError(
          'provider_unavailable',
          `Every variant failed before it started: ${truncate(failures[0].message, 300)}`,
          { failures: failures.length, round },
        );
      }
      this.#emit(run.id, 'run.round', { round, phase: 'author', detail: 'no candidate survived authoring' });
      return { promoted: false, winnerVersionId: parent.id, candidateIds, note: 'All candidates failed a technical check. The parent stays.' };
    }

    const protocol = this.#protocol(run);
    const entries = [parent, ...candidates.map((entry) => entry.version)];

    // capture the round frames for the parent and for every valid candidate
    const captured = await mapLimit(entries, this.config.capture.captureConcurrency, async (version) => {
      try {
        const captures = await this.#captureVersion({
          run,
          version,
          stages: protocol.stages,
          steps: protocol.steps,
          seeds: protocol.seeds,
          dense: false,
        });
        return { version, captures, ok: true };
      } catch (error) {
        return { version, captures: [], ok: false, error };
      }
    });

    for (const entry of captured) {
      if (entry.ok || entry.version.id === parent.id) continue;
      this.#failVersion(entry.version.id, entry.error);
    }
    const judged = captured.filter((entry) => entry.ok && entry.captures.length > 0);
    if (judged.length < 2) {
      this.#rejectOtherCandidates(candidates.map((entry) => entry.version), null, 'Too few versions could be captured.');
      return { promoted: false, winnerVersionId: parent.id, candidateIds, note: 'Too few versions could be captured. The parent stays.' };
    }
    for (const entry of judged) {
      if (entry.version.id === parent.id) continue;
      if (!['promoted', 'rejected', 'failed'].includes(entry.version.status)) this.#setVersionState(entry.version.id, 'judging');
    }

    const roundVerdict = await this.#judgeOrRetain({
      run,
      parent,
      candidates,
      candidateIds,
      round,
      entries: judged.map((entry) => ({ versionId: entry.version.id, captures: entry.captures })),
      referenceVersionId: parent.id,
      kind: 'round',
    });
    if (roundVerdict === null) {
      return { promoted: false, winnerVersionId: parent.id, candidateIds, note: 'The round comparison failed, so the parent stays.' };
    }

    const finalistVersionId = roundVerdict.winnerVersionId;
    this.#emit(run.id, 'run.round', {
      round,
      phase: 'judge',
      detail: `the round comparison chose ${finalistVersionId ?? 'no candidate'}`,
    });
    if (!finalistVersionId || finalistVersionId === parent.id) {
      this.#rejectOtherCandidates(candidates.map((entry) => entry.version), null, 'No candidate beat the parent.');
      return {
        promoted: false,
        winnerVersionId: parent.id,
        candidateIds,
        note: 'No candidate beat the parent in the round comparison, so the parent stays.',
      };
    }

    const finalist = judged.find((entry) => entry.version.id === finalistVersionId)?.version ?? this.store.getVersion(finalistVersionId);

    // a denser sequence for the finalist and the parent
    const dense = await mapLimit([parent, finalist], this.config.capture.captureConcurrency, async (version) => {
      try {
        const captures = await this.#captureVersion({
          run,
          version,
          stages: protocol.denseStages,
          steps: protocol.denseSteps,
          seeds: protocol.seeds,
          dense: true,
        });
        return { version, captures, ok: true };
      } catch (error) {
        return { version, captures: [], ok: false, error };
      }
    });
    const denseOk = dense.filter((entry) => entry.ok && entry.captures.length > 0);
    const denseEntries = denseOk.length === 2 ? denseOk : judged.filter((entry) => [parent.id, finalist.id].includes(entry.version.id));
    const comparisonEntries = denseEntries.map((entry) => ({ versionId: entry.version.id, captures: entry.captures }));

    const primary = await this.#judgeOrRetain({
      run,
      parent,
      candidates,
      candidateIds,
      round,
      kind: 'finalist',
      entries: comparisonEntries,
      referenceVersionId: parent.id,
    });
    if (primary === null) {
      return { promoted: false, winnerVersionId: parent.id, candidateIds, note: 'The finalist comparison failed, so the parent stays.' };
    }
    if (paused()) {
      this.#rejectOtherCandidates(candidates.map((entry) => entry.version), null, 'The run was paused during judging.');
      return { promoted: false, winnerVersionId: parent.id, candidateIds, note: 'The run was paused during judging, so the parent stays.' };
    }

    const reversedComparison = await this.#judgeOrRetain({
      run,
      parent,
      candidates,
      candidateIds,
      round,
      kind: 'finalist-reversed',
      entries: comparisonEntries,
      referenceVersionId: parent.id,
      reversed: true,
    });

    let tieBreak = null;
    const first = primary.winnerVersionId;
    const second = reversedComparison?.winnerVersionId ?? null;
    const tieBreakEnabled = this.#protocol(run).tieBreak;
    if (tieBreakEnabled && !verdictsAgree(primary, reversedComparison)) {
      this.#emit(run.id, 'run.round', { round, phase: 'judge', detail: 'the two comparisons disagree, so one tie-break runs' });
      tieBreak = await this.#judgeOrRetain({
        run,
        parent,
        candidates,
        candidateIds,
        round,
        kind: 'tie-break',
        entries: comparisonEntries,
        referenceVersionId: parent.id,
        tieBreak: true,
      });
    }
    void first;
    void second;

    const decision = decideWinner({
      primary,
      reversed: reversedComparison,
      tieBreak,
      parentVersionId: parent.id,
      promoteMargin: this.config.evolution.promoteMargin,
    });

    if (!decision.promoted) {
      this.#rejectVersion(finalist.id, decision.reason);
      this.store.createEvaluation({ runId: run.id, round, versionId: finalist.id, comparisonId: primary.comparisonId, outcome: 'rejected', note: decision.reason });
      this.#rejectOtherCandidates(candidates.map((entry) => entry.version), finalist.id, 'The parent was retained.');
      return { promoted: false, winnerVersionId: parent.id, candidateIds, note: decision.reason };
    }

    this.#promoteVersion(finalist.id, decision.reason);
    this.#rejectOtherCandidates(candidates.map((entry) => entry.version), finalist.id, `Round ${round} promoted another candidate.`);
    this.store.createEvaluation({ runId: run.id, round, versionId: finalist.id, comparisonId: primary.comparisonId, outcome: 'promoted', note: decision.reason });
    if (tieBreak) {
      this.store.createEvaluation({ runId: run.id, round, versionId: finalist.id, comparisonId: tieBreak.comparisonId, outcome: 'tie-break', note: `The tie-break chose ${finalist.id}` });
    }
    return { promoted: true, winnerVersionId: finalist.id, candidateIds, note: decision.reason };
  }

  // ── authoring ─────────────────────────────────────────────────────────────

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
    return (event) => {
      for (const row of feedRows(event, versionId)) {
        if (row.kind === 'text') {
          // The text arrives token by token. Keep the ticker readable.
          const now = Date.now();
          if (now - lastTextAt < 500) continue;
          lastTextAt = now;
        }
        this.#emit(runId, 'agent', row);
      }
    };
  }

  async #authorCandidate({ run, round, parent, plan }) {
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
      slot: plan.slot,
      title: plan.title,
      status: 'queued',
      direction: run.direction,
      sourceHash: parent.sourceHash,
      snapshotPath: parent.snapshotPath,
      workspacePath: workspaceDir,
      configuration: parent.configuration,
      changes: [],
      onLineage: false,
    });
    this.#emit(run.id, 'version.created', { version: this.#publicVersion(version) });

    try {
      await copyPackage(context.packageDir, workspaceDir);
      await this.#withJob({ run, round, slot: plan.slot, kind: 'author', versionId }, async (job) => {
        this.#setVersionState(versionId, 'authoring');
        // Read the package before the session changes it, then follow the writes.
        const files = this.#fileReporter(run.id, versionId, workspaceDir);
        const agent = this.#agentReporter(run.id, versionId);
        await files.announce();
        // Tell the session what this run already did, so a one-time change in
        // the direction is not applied again at every evolution.
        const earlier = this.store.listRounds(run.id).filter((entry) => entry.round > 0 && entry.round < round);
        const history = [
          ...earlier.map((entry) => `evolution ${entry.round}: ${truncate(entry.note ?? 'no note', 160)}`),
          ...parent.changes.slice(0, 8).map((change) => `the parent changed ${change.path} (+${change.added} -${change.removed})`),
        ];
        const prompt = buildAuthorPrompt({
          direction: run.direction,
          plan,
          manifest: context.manifest,
          parentConfiguration: parent.configuration,
          history,
        });
        const sessionId = `phygen-${versionId}`;
        const attemptCall = (attempt) =>
          this.#providerCall({
            run,
            kind: 'author',
            label: attempt === 1 ? `author:${versionId}` : `author-retry:${versionId}`,
            versionId,
            jobId: job.id,
            call: (signal) =>
              this.provider.author({
                workspaceDir,
                prompt,
                systemPrompt: AUTHOR_SYSTEM_PROMPT,
                model: run.protocol?.authorModel,
                onEvent: (event) => {
                  agent(event);
                  files.onEvent(event);
                },
                sessionId,
                signal,
                plan,
                direction: run.direction,
                round,
                slot: plan.slot,
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
          if (!isTransientProviderError(error)) throw error;
          this.#emit(run.id, 'log', {
            level: 'warn',
            message: `The author session failed before it started (${error.code}): ${truncate(error.message, 200)}. One more try in 20 seconds.`,
          });
          await sleep(20000);
          try {
            result = await attemptCall(2);
          } catch (retry) {
            if (!isTransientProviderError(retry)) throw retry;
            // The extension keeps its model list in memory only, so a slow
            // gateway needs patience rather than another dead candidate.
            this.#emit(run.id, 'log', {
              level: 'warn',
              message: 'The provider failed a second time. One last try in 60 seconds.',
            });
            await sleep(60000);
            result = await attemptCall(3);
          }
        }
        this.store.updateVersion(versionId, { explanation: truncate(result.text, 4000) });
        this.#emit(run.id, 'version.state', { versionId, status: 'authoring', detail: `author session ${result.sessionId ?? 'unknown'} finished` });
      });

      this.#setVersionState(versionId, 'validating');
      const reviewed = await this.#validateCandidate({ run, versionId, workspaceDir, context, phase: 'first' });
      if (!reviewed.ok) {
        this.#failVersion(versionId, reviewed.error);
        return { version: this.store.getVersion(versionId), ok: false };
      }
      await this.#withJob({ run, round, slot: plan.slot, kind: 'publish', versionId }, async () => {
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
      this.#failVersion(versionId, error);
      return { version: this.store.getVersion(versionId), ok: false, error };
    }
  }

  /** Review the edits, repair once, then check the package and its configuration. */
  async #validateCandidate({ run, versionId, workspaceDir, context, phase }) {
    const review = await reviewEdits({ originalDir: context.packageDir, workspaceDir, manifest: context.manifest });
    if (review.violations.length > 0) {
      return { ok: false, error: new ArtworkError('edit_surface_violation', review.violations[0], { violations: review.violations }) };
    }

    const check = await checkPackage({ packageDir: workspaceDir, verifyEntry: false });
    if (!check.ok) {
      const failure = new ArtworkError('package_invalid', check.problems[0] ?? 'The candidate package is invalid', { problems: check.problems });
      if (phase === 'first' && this.config.evolution.repairAttempts > 0) {
        const repair = await this.#repair({ run, versionId, workspaceDir, failure });
        if (repair) return this.#validateCandidate({ run, versionId, workspaceDir, context, phase: 'after-repair' });
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
        if (repair) return this.#validateCandidate({ run, versionId, workspaceDir, context, phase: 'after-repair' });
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

  async #repair({ run, versionId, workspaceDir, failure }) {
    this.#emit(run.id, 'version.state', { versionId, status: 'validating', detail: `one repair attempt: ${failure.code}` });
    try {
      await this.#withJob({ run, round: null, slot: null, kind: 'author', versionId }, async (job) => {
        await this.#providerCall({
          run,
          kind: 'author',
          label: `repair:${versionId}`,
          versionId,
          jobId: job.id,
          call: (signal) =>
            this.provider.author({
              workspaceDir,
              prompt: buildRepairPrompt({ failure }),
              model: run.protocol?.authorModel,
              onEvent: this.#agentReporter(run.id, versionId),
              systemPrompt: AUTHOR_SYSTEM_PROMPT,
              sessionId: `phygen-${versionId}`,
              signal,
            }),
        });
      });
      return true;
    } catch (error) {
      this.logger('warn', `Repair attempt for ${versionId} failed: ${error.message}`);
      return false;
    }
  }

  // ── capture ───────────────────────────────────────────────────────────────

  async #captureVersion({ run, version, stages, steps, seeds, dense }) {
    const context = this.#artworkContext(run.artworkId);
    const outDir = join(this.config.dataDir, 'captures', version.id, dense ? 'dense' : 'round');
    const samples = [];
    for (const seed of seeds) {
      stages.forEach((stage, index) => {
        samples.push({ stage: dense ? `dense-${stage}` : stage, step: steps[Math.min(index, steps.length - 1)], seed });
      });
    }

    return this.#withJob({ run, round: version.round, slot: version.slot, kind: 'capture', versionId: version.id }, async (job) => {
      // Read the current record: the caller may hold a snapshot from an earlier
      // stage, and a stale status must not drive a transition.
      const current = this.store.getVersion(version.id) ?? version;
      if (canTransition('version', current.status, 'capturing')) this.#setVersionState(version.id, 'capturing');
      const configurationHash = sha256Hex(stableStringify(version.configuration));
      const results = await this.capture.capture({
        liveBaseUrl: this.artifacts.liveUrlFor(version.id),
        snapshotDir: this.artifacts.snapshotDirFor(version),
        runtimeDir: this.artifacts.runtimeDir,
        nodeModulesDir: this.artifacts.nodeModulesDir(context.packageDir),
        samples,
        viewport: this.#protocol(run).viewport,
        timestep: CAPTURE_TIMESTEP,
        outDir,
        sourceHash: version.sourceHash,
        configurationHash,
        signal: this.active.get(run.id)?.abort.signal,
      });

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
        // The node shows the newest frame while the capture continues.
        this.#emit(run.id, 'capture.ready', {
          versionId: version.id,
          captureId: record.id,
          stage: record.stage,
          step: record.step,
          seed: record.seed,
          url: `/api/captures/${record.id}.png`,
        });
      }
      return results;
    });
  }

  // ── judging ───────────────────────────────────────────────────────────────

  /**
   * Run one comparison. A judge answer that breaks the contract fails the
   * COMPARISON, not the run: the round then keeps the parent.
   * @returns {Promise<object|null>} null when the comparison failed
   */
  async #judgeOrRetain(options) {
    try {
      return await this.#judge(options);
    } catch (error) {
      if (!(error instanceof JudgeError)) throw error;
      this.#emit(options.run.id, 'error', {
        code: error.code,
        message: error.message,
        detail: { round: options.round, kind: options.kind, ...(error.details ?? {}) },
      });
      this.logger('warn', `Round ${options.round} ${options.kind} comparison failed: ${error.code}`);
      return null;
    }
  }

  async #judge({ run, round, kind, entries, referenceVersionId, reversed, tieBreak }) {
    const available = entries.filter((entry) => entry.captures.length > 0);
    if (available.length < 2) {
      throw new JudgeError('comparison_too_small', `The ${kind} comparison needs at least two versions`);
    }
    const { ordered, labels, labelToVersion } = assignLabels(available);
    // A comparison without its reference must fail, never silently relabel a
    // candidate as the reference.
    if (labels[referenceVersionId] === undefined) {
      throw new JudgeError('reference_missing', 'The reference version has no captured frame, so the comparison cannot run', {
        referenceVersionId,
        compared: Object.keys(labels),
      });
    }
    const referenceLabel = labels[referenceVersionId];
    const orderedForPrompt = reversed ? [...ordered].reverse() : ordered;

    const buildCaptures = (entry) =>
      [...entry.captures]
        .sort((a, b) => (a.stage === b.stage ? a.seed - b.seed : String(a.stage).localeCompare(String(b.stage))))
        .map((capture) => ({
          stage: capture.stage,
          step: capture.step,
          seed: capture.seed,
          fileName: basename(capture.path),
          path: capture.path,
          url: `/api/captures/${capture.id}.png`,
        }));

    const promptEntries = orderedForPrompt.map((entry) => ({ versionId: entry.versionId, captures: buildCaptures(entry) }));
    const prompt = buildJudgePrompt({
      direction: run.direction,
      entries: promptEntries,
      labels,
      referenceLabel,
      reversed,
      tieBreak,
    });

    const images = [];
    for (const entry of promptEntries) {
      for (const capture of entry.captures) {
        images.push({
          label: labels[entry.versionId],
          path: capture.path,
          fileName: capture.fileName,
          stage: capture.stage,
          step: capture.step,
          seed: capture.seed,
        });
      }
    }

    const workDir = join(this.config.dataDir, 'judge', run.id);
    await mkdir(workDir, { recursive: true });

    const result = await this.#withJob({ run, round, slot: null, kind: 'judge', versionId: referenceVersionId }, async (job) =>
      this.#providerCall({
        run,
        kind: 'judge',
        label: `judge:${kind}:r${round}`,
        versionId: referenceVersionId,
        jobId: job.id,
        call: (signal) =>
          this.provider.judge({
            prompt,
            images,
            cwd: workDir,
            model: run.protocol?.providerModel,
            systemPrompt: JUDGE_SYSTEM_PROMPT,
            signal,
            stub: { referenceLabel },
          }),
      }),
    );

    const verdict = extractJson(result.text);
    if (!verdict) {
      throw new JudgeError('judge_response_invalid', 'The judge answer holds no JSON object', { text: truncate(result.text, 800), kind });
    }
    const validated = validateVerdict(verdict, { labelToVersion, entries: promptEntries, labels });

    const comparison = this.store.createComparison({
      runId: run.id,
      round,
      kind,
      order: promptEntries.map((entry) => labels[entry.versionId]),
      labels,
      verdict: { ...validated, model: result.model, stub: result.stub ?? false },
      winnerVersionId: validated.preference === 'none' ? null : labelToVersion[validated.preference],
      confidence: validated.confidence,
      uncertainty: validated.uncertainty,
      judgeSession: result.sessionId,
      sourceHash: sha256Hex(stableStringify(promptEntries.map((entry) => [entry.versionId, entry.captures.map((capture) => capture.fileName)]))),
    });

    this.#emit(run.id, 'comparison.result', {
      round,
      kind,
      labels,
      order: comparison.order,
      winnerVersionId: comparison.winnerVersionId,
      confidence: comparison.confidence,
      uncertainty: comparison.uncertainty,
    });

    return {
      comparisonId: comparison.id,
      winnerVersionId: comparison.winnerVersionId,
      labelToVersion,
      labels,
      verdict: validated,
    };
  }

  // ── provider and job plumbing ──────────────────────────────────────────────

  /** Reserve the bound, call the provider, then commit the real cost. */
  async #providerCall({ run, kind, label, versionId, jobId, call }) {
    const bound =
      kind === 'author'
        ? label.startsWith('repair:')
          ? this.config.cost.repairCallUsd
          : this.config.cost.authorCallUsd
        : label.startsWith('judge:tie-break')
          ? this.config.cost.tieBreakCallUsd
          : this.config.cost.judgeCallUsd;

    const fresh = this.store.getRun(run.id);
    // The run holds one overall reservation until the first request replaces it
    // with per-request reservations.
    if (this.budget.reservations(run.id).has('run-estimate')) {
      this.budget.release(run.id, 'run-estimate');
    }
    this.budget.reserve(fresh, bound, label);
    let result;
    try {
      result = await call(this.active.get(run.id)?.abort.signal);
    } catch (error) {
      // A session that timed out or failed still costs money. Charge what the
      // provider reported, and keep the record honest.
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
          jobId,
          versionId,
          kind,
          model: this.config.provider.authorModel,
          sessionId: null,
          inputTokens: spent.inputTokens ?? 0,
          outputTokens: spent.outputTokens ?? 0,
          costUsd: committed.charged,
          raw: { ...(spent.raw ?? {}), costSource: committed.costSource, label, outcome: error.code ?? 'failed' },
        });
        this.#emit(run.id, 'usage', {
          model: this.config.provider.model,
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
      jobId,
      versionId,
      kind,
      model: result.model ?? this.config.provider.model,
      sessionId: result.sessionId ?? null,
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      costUsd: committed.charged,
      raw: { ...usage.raw, costSource: committed.costSource, stub: result.stub ?? false, label },
    });
    this.#emit(run.id, 'usage', {
      model: result.model ?? this.config.provider.model,
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
  async #withJob({ run, round, slot, kind, versionId }, work) {
    const job = this.store.createJob({ runId: run.id, versionId, round, slot, kind, state: 'queued' });
    const owner = `${process.pid}-${newId('w')}`;
    this.leases.set(job.id, owner);
    this.#emit(run.id, 'job.state', { jobId: job.id, kind, state: 'queued', detail: `round ${round ?? '-'} slot ${slot ?? '-'}` });
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

  #protocol(run) {
    const protocol = run.protocol ?? {};
    const fallback = {
      viewport: this.config.evolution.viewport,
      seeds: this.config.evolution.seeds,
      stages: this.config.evolution.frameRoles,
      steps: this.config.evolution.stepSchedule,
      denseStages: this.config.evolution.denseFrameRoles,
      denseSteps: this.config.evolution.denseStepSchedule,
      tieBreak: this.config.evolution.tieBreak,
    };
    return {
      viewport: protocol.viewport ?? fallback.viewport,
      seeds: protocol.seeds ?? fallback.seeds,
      stages: protocol.frameRoles ?? fallback.stages,
      steps: protocol.stepSchedule ?? fallback.steps,
      denseStages: protocol.denseFrameRoles ?? fallback.denseStages,
      denseSteps: protocol.denseStepSchedule ?? fallback.denseSteps,
      tieBreak: protocol.tieBreak ?? fallback.tieBreak,
    };
  }

  #publicVersion(version) {
    return {
      id: version.id,
      parentId: version.parentId,
      generation: version.generation,
      round: version.round,
      slot: version.slot,
      title: version.title,
      status: version.status,
      direction: version.direction,
      onLineage: version.onLineage,
      thumbnailUrl: `/api/versions/${version.id}/artifacts/thumb`,
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
    // The interface announces the decision over the node.
    this.#emit(version.runId, 'version.decision', { versionId, outcome: 'winner', reason });
    return updated;
  }

  #rejectVersion(versionId, reason) {
    const version = this.store.getVersion(versionId);
    if (['promoted', 'rejected', 'failed'].includes(version.status)) return version;
    const status = transition('version', version.status, 'rejected');
    const updated = this.store.updateVersion(versionId, { status, onLineage: false });
    this.#emit(version.runId, 'version.state', { versionId, status, detail: reason, onLineage: false });
    this.#emit(version.runId, 'version.decision', { versionId, outcome: 'yeeted', reason });
    return updated;
  }

  /** Every candidate of a round that the round did not promote is rejected. */
  #rejectOtherCandidates(versions, winnerVersionId, note) {
    for (const version of versions) {
      if (version.id === winnerVersionId) continue;
      const current = this.store.getVersion(version.id);
      if (!current || ['promoted', 'rejected', 'failed'].includes(current.status)) continue;
      this.#rejectVersion(current.id, note);
    }
  }

  #failVersion(versionId, error) {
    const version = this.store.getVersion(versionId);
    if (!version) return null;
    if (['promoted', 'rejected', 'failed'].includes(version.status)) return version;
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


