// ─────────────────────────────────────────────────────────────────────────────
// budget.mjs — cost and resource limits.
//
// The controller reserves the maximum bound of a request before it starts.
// A request that does not fit under the limit never starts. After the request,
// the real reported cost replaces the reservation. When a provider reports no
// cost, the conservative bound is charged and the record says so.
// ─────────────────────────────────────────────────────────────────────────────
import { ArtworkError } from '../../runtime/contract.js';
import { round6 } from './util.mjs';

export class BudgetError extends ArtworkError {
  constructor(code, message, details) {
    super(code, message, details);
    this.name = 'BudgetError';
  }
}

export class Budget {
  constructor({ store, events, config, catalog = null }) {
    this.store = store;
    this.events = events;
    this.config = config;
    this.catalog = catalog;
    /** runId -> { reservations: Map<label, amount> } */
    this.held = new Map();
  }

  reservations(runId) {
    return this.held.get(runId) ?? new Map();
  }

  reservedTotal(runId) {
    let total = 0;
    for (const amount of this.reservations(runId).values()) total += amount;
    return round6(total);
  }

  limitFor(run) {
    // 0 means no cost guardrail: the spend is recorded, never enforced.
    if (!Number.isFinite(run.limitUsd) || run.limitUsd <= 0) return Number.POSITIVE_INFINITY;
    return Math.min(run.limitUsd, this.config.cost.maxRunUsd > 0 ? this.config.cost.maxRunUsd : Number.POSITIVE_INFINITY);
  }

  /** The highest possible cost of one run, before it starts. */
  boundFor({ evolutions, variants, candidatesPerRound, protocol, authorModel, judgeModel }) {
    const perLevel = variants ?? candidatesPerRound ?? this.config.evolution.variants;
    if (this.catalog) {
      const estimate = this.catalog.estimateRun({
        evolutions,
        candidatesPerRound: perLevel,
        protocol,
        authorModel: authorModel ?? this.config.provider.authorModel,
        judgeModel: judgeModel ?? this.config.provider.model,
      });
      return { ...estimate, pricingSource: estimate.pricingSource };
    }
    const rounds = Math.max(1, evolutions);
    const candidates = Math.max(1, perLevel);
    const judgeCallsPerRound = candidates + 1 + (protocol?.tieBreak === false ? 0 : 1);
    const authorCalls = rounds * candidates;
    const repairCalls = rounds * candidates * this.config.evolution.repairAttempts;
    const judgeCalls = rounds * judgeCallsPerRound;
    const tieBreakCalls = rounds * (protocol?.tieBreak === false ? 0 : 1);
    const usd =
      (authorCalls + repairCalls) * this.config.cost.authorCallUsd +
      judgeCalls * this.config.cost.judgeCallUsd +
      tieBreakCalls * this.config.cost.tieBreakCallUsd;
    return {
      rounds,
      candidatesPerRound: candidates,
      authorCalls: authorCalls + repairCalls,
      judgeCalls: judgeCalls + tieBreakCalls,
      estimateUsd: round6(usd),
      boundUsd: round6(usd),
      safetyFactor: 1,
      pricingSource: 'configured',
      note: 'No catalog price is available, so the estimate uses configured conservative bounds.',
    };
  }

  /** Reserve the bound of one request, or fail with budget_exceeded. */
  reserve(run, amountUsd, label, { emit = true } = {}) {
    const limit = this.limitFor(run);
    const already = round6(run.spentUsd + this.reservedTotal(run.id));
    if (already + amountUsd > limit) {
      throw new BudgetError(
        'budget_exceeded',
        `The run cannot reserve ${amountUsd.toFixed(4)} USD: ${already.toFixed(4)} USD is spent or reserved and the limit is ${limit.toFixed(4)} USD`,
        { runId: run.id, requested: amountUsd, committed: already, limit },
      );
    }
    const map = this.held.get(run.id) ?? new Map();
    map.set(label, amountUsd);
    this.held.set(run.id, map);
    const reservedUsd = this.reservedTotal(run.id);
    this.store.updateRun(run.id, { reservedUsd });
    if (!emit) return reservedUsd;
    this.events.emit(run.id, 'budget', {
      spentUsd: run.spentUsd,
      reservedUsd,
      limitUsd: limit,
      boundUsd: run.costBoundUsd,
      label,
    });
    return reservedUsd;
  }

  /**
   * Replace one reservation with the real cost.
   * @returns {object} the updated run
   */
  commit(runId, label, { reportedUsd = 0, boundUsd = 0, inputTokens = 0, outputTokens = 0, costKnown = false }) {
    const map = this.held.get(runId) ?? new Map();
    const reserved = map.get(label) ?? 0;
    map.delete(label);
    this.held.set(runId, map);

    // A provider that reports no cost is charged its conservative bound, so the
    // limit stays meaningful. A driver that knows the cost of a request pays it.
    const known = costKnown || reportedUsd > 0;
    const costSource = known ? 'provider' : 'bound';
    const charged = known ? reportedUsd : boundUsd;
    const excessUsd = known && boundUsd > 0 ? Math.max(0, round6(reportedUsd - boundUsd)) : 0;
    const run = this.store.getRun(runId);
    const next = this.store.updateRun(runId, {
      spentUsd: round6(run.spentUsd + charged),
      reservedUsd: this.reservedTotal(runId),
      calls: run.calls + 1,
      tokens: run.tokens + inputTokens + outputTokens,
    });
    this.events.emit(runId, 'budget', {
      spentUsd: next.spentUsd,
      reservedUsd: next.reservedUsd,
      limitUsd: this.limitFor(next),
      boundUsd: next.costBoundUsd,
      label,
      reservedReleased: reserved,
      charged: round6(charged),
      costSource,
      excessUsd,
    });
    return { run: next, charged: round6(charged), costSource, excessUsd };
  }

  /** Drop a reservation without a charge, for example after a cancelled task. */
  release(runId, label) {
    const map = this.held.get(runId) ?? new Map();
    map.delete(label);
    this.held.set(runId, map);
    const run = this.store.getRun(runId);
    return this.store.updateRun(runId, { reservedUsd: this.reservedTotal(runId) });
  }

  /**
   * Refuse a run BEFORE any record is created. An admitted run must be able to
   * reserve its own bound: a rejection after the record exists leaves a queued
   * run that nobody runs.
   *
   * @param {object} options
   * @param {number} options.evolutions
   * @param {number} [options.variants] variants per level
   * @param {number} options.limitUsd 0 means no per-run limit
   * @param {number} options.boundUsd the highest possible cost of the run
   */
  assertAdmission({ evolutions, variants, limitUsd = 0, boundUsd = 0 }) {
    const { maxRunUsd, maxRounds, maxCallsPerRun } = this.config.cost;
    if (maxRounds > 0 && evolutions > maxRounds) {
      throw new BudgetError('round_limit_reached', `The run asks for ${evolutions} rounds; the limit is ${maxRounds}`, {
        rounds: evolutions,
        limit: maxRounds,
      });
    }
    const configured = Number.isFinite(limitUsd) && limitUsd > 0 ? limitUsd : Number.POSITIVE_INFINITY;
    const ceiling = maxRunUsd > 0 ? maxRunUsd : Number.POSITIVE_INFINITY;
    const limit = Math.min(configured, ceiling);
    if (!Number.isFinite(limit)) return true;
    if (boundUsd > limit) {
      throw new BudgetError(
        'budget_exceeded',
        `The run cannot start: its highest possible cost is ${boundUsd.toFixed(4)} USD and the limit is ${limit.toFixed(4)} USD`,
        { requested: boundUsd, limit, evolutions },
      );
    }
    if (maxCallsPerRun > 0) {
      const perLevel = Math.max(1, variants ?? this.config.evolution.variants);
      const authorCalls = evolutions * perLevel;
      if (authorCalls > maxCallsPerRun) {
        throw new BudgetError('request_limit_reached', `The run would make at least ${authorCalls} author requests; the limit is ${maxCallsPerRun}`, {
          calls: authorCalls,
          limit: maxCallsPerRun,
        });
      }
    }
    return true;
  }

  /**
   * Throw when a run has used its request count, token budget, round count, or
   * elapsed time. A limit of 0 removes that guardrail.
   */
  assertRunLimits(run) {
    const { maxCallsPerRun, maxTokensPerRun, maxRounds, maxRunSeconds } = this.config.cost;
    if (maxCallsPerRun > 0 && run.calls >= maxCallsPerRun) {
      throw new BudgetError('request_limit_reached', `The run used ${run.calls} requests; the limit is ${maxCallsPerRun}`, { runId: run.id, calls: run.calls, limit: maxCallsPerRun });
    }
    if (maxTokensPerRun > 0 && run.tokens >= maxTokensPerRun) {
      throw new BudgetError('token_limit_reached', `The run used ${run.tokens} tokens; the limit is ${maxTokensPerRun}`, { runId: run.id, tokens: run.tokens, limit: maxTokensPerRun });
    }
    if (maxRounds > 0 && run.evolutionsRequested > maxRounds) {
      throw new BudgetError('round_limit_reached', `The run asks for ${run.evolutionsRequested} rounds; the limit is ${maxRounds}`, { runId: run.id, rounds: run.evolutionsRequested, limit: maxRounds });
    }
    if (maxRunSeconds > 0 && run.startedAt) {
      const elapsed = (Date.now() - new Date(run.startedAt).valueOf()) / 1000;
      if (elapsed > maxRunSeconds) {
        throw new BudgetError('time_limit_reached', `The run ran for ${Math.round(elapsed)} seconds; the limit is ${maxRunSeconds}`, { runId: run.id, elapsed, limit: maxRunSeconds });
      }
    }
    return true;
  }

  /** True when the record shows more spend than the limit allows. */
  isOverrun(run) {
    return round6(run.spentUsd) > this.limitFor(run);
  }
}

