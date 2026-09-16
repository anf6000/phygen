// ─────────────────────────────────────────────────────────────────────────────
// models.mjs — the Kilo model catalog, its prices, and the cost estimate.
//
// The catalog is the same list the Pi provider uses, read from the Kilo
// gateway. Prices arrive per token and are stored per million tokens.
//
// The estimate is computed from a token model, not from a guess:
//   - text tokens ≈ characters / 4
//   - one image token ≈ (width × height) / 750
//   - an author session also writes files, so it gets an output allowance
// When a price is missing, the configured bounds apply instead.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CACHE_TTL_MS = 60 * 60 * 1000;
const IMAGE_TOKENS_PER_PIXEL = 1 / 750;
const CHARS_PER_TOKEN = 4;

function price(perToken) {
  const value = Number.parseFloat(perToken);
  return Number.isFinite(value) ? Math.round(value * 1e6 * 1e6) / 1e6 : 0;
}

export function estimateImageTokens({ width, height }) {
  return Math.max(1, Math.ceil((width * height) * IMAGE_TOKENS_PER_PIXEL));
}

export class ModelCatalog {
  constructor({ config, logger = () => {} }) {
    this.config = config;
    this.logger = logger;
    this.models = new Map();
    this.fetchedAt = 0;
    this.source = 'unavailable';
    this.cachePath = join(config.dataDir, 'models.json');
  }

  async #loadFromDisk() {
    if (this.models.size > 0) return true;
    try {
      const cached = JSON.parse(await readFile(this.cachePath, 'utf8'));
      for (const model of cached.models ?? []) this.models.set(model.id, model);
      this.fetchedAt = cached.fetchedAt ?? 0;
      this.source = 'cache';
      return this.models.size > 0;
    } catch {
      return false;
    }
  }

  async refresh({ force = false } = {}) {
    if (!force && Date.now() - this.fetchedAt < CACHE_TTL_MS && this.models.size > 0) return this.list();
    const base = this.config.models.baseUrl.replace(/\/$/, '');
    const url = this.config.models.organizationId
      ? `${base}/api/organizations/${encodeURIComponent(this.config.models.organizationId)}/models`
      : `${base}/api/gateway/models`;
    const headers = { 'content-type': 'application/json', 'user-agent': 'phygen' };
    if (this.config.models.apiKey) headers.authorization = `Bearer ${this.config.models.apiKey}`;
    if (this.config.models.organizationId) headers['x-kilocode-organizationid'] = this.config.models.organizationId;

    try {
      const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = await response.json();
      const rows = Array.isArray(body.data) ? body.data : [];
      if (rows.length === 0) throw new Error('the catalog is empty');

      const next = new Map();
      for (const row of rows) {
        const modalities = row.architecture?.input_modalities ?? ['text'];
        if ((row.architecture?.output_modalities ?? []).includes('image')) continue;
        const priceIn = price(row.pricing?.prompt);
        const priceOut = price(row.pricing?.completion);
        next.set(row.id, {
          id: row.id,
          name: row.name ?? row.id,
          priceInUsdPerMTok: priceIn,
          priceOutUsdPerMTok: priceOut,
          priceCacheReadUsdPerMTok: price(row.pricing?.input_cache_read),
          contextWindow: row.context_length ?? null,
          maxCompletionTokens: row.top_provider?.max_completion_tokens ?? row.max_completion_tokens ?? null,
          acceptsImages: modalities.includes('image'),
          supportsReasoning: (row.supported_parameters ?? []).includes('reasoning'),
          free: priceIn === 0 && priceOut === 0,
        });
      }
      this.models = next;
      this.fetchedAt = Date.now();
      this.source = 'gateway';
      await mkdir(dirname(this.cachePath), { recursive: true });
      await writeFile(this.cachePath, `${JSON.stringify({ fetchedAt: this.fetchedAt, models: [...next.values()] }, null, 2)}\n`, 'utf8');
      this.logger('info', `Model catalog loaded: ${next.size} model(s)`);
      return this.list();
    } catch (error) {
      await this.#loadFromDisk();
      this.source = this.models.size > 0 ? 'cache' : 'unavailable';
      this.logger('warn', `Model catalog unavailable (${error.message}); ${this.source === 'cache' ? 'using the saved copy' : 'using configured bounds'}`);
      return this.list();
    }
  }

  list() {
    return [...this.models.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  get(id) {
    return this.models.get(id) ?? null;
  }

  status() {
    return {
      source: this.source,
      count: this.models.size,
      fetchedAt: this.fetchedAt ? new Date(this.fetchedAt).toISOString() : null,
      models: this.list(),
    };
  }

  /**
   * Tokens and dollars for one run.
   *
   * @param {object} options
   * @param {number} options.evolutions
   * @param {number} options.candidatesPerRound
   * @param {object} options.protocol
   * @param {string} options.authorModel
   * @param {string} options.judgeModel
   * @param {number} options.authorPromptTokens  measured from a real prompt
   * @param {number} options.judgePromptTokens
   * @param {number} options.imagesPerJudgeCall
   */
  estimateRun({
    evolutions,
    candidatesPerRound,
    protocol,
    authorModel,
    judgeModel,
    // Measured: the base system prompt alone costs about 4500 input tokens, and
    // an author session reads files across several turns.
    authorPromptTokens = 12000,
    judgePromptTokens = 6000,
    authorOutputTokens = 6000,
    judgeOutputTokens = 1200,
    imagesPerJudgeCall = 12,
  }) {
    const rounds = Math.max(1, evolutions);
    const candidates = Math.max(1, candidatesPerRound);
    const perRoundJudgeCalls = candidates + 1 + (protocol?.tieBreak === false ? 0 : 1) + 1;
    const authorCalls = rounds * candidates;
    const repairCalls = rounds * candidates * this.config.evolution.repairAttempts;
    const judgeCalls = rounds * perRoundJudgeCalls;

    const imageTokens = estimateImageTokens(protocol?.viewport ?? this.config.evolution.viewport) * imagesPerJudgeCall;
    const authorTokens = {
      input: authorPromptTokens,
      output: authorOutputTokens,
      calls: authorCalls + repairCalls,
    };
    const judgeTokens = {
      input: judgePromptTokens + imageTokens,
      output: judgeOutputTokens,
      calls: judgeCalls,
    };

    const priceOf = (modelId) => this.models.get(modelId) ?? null;
    const author = priceOf(authorModel);
    const judge = priceOf(judgeModel);
    const costOf = (model, tokens) =>
      model === null ? null : (tokens.input * tokens.calls * model.priceInUsdPerMTok + tokens.output * tokens.calls * model.priceOutUsdPerMTok) / 1e6;

    const authorUsd = costOf(author, authorTokens);
    const judgeUsd = costOf(judge, judgeTokens);
    const priced = authorUsd !== null && judgeUsd !== null;

    const estimateUsd = priced ? authorUsd + judgeUsd : null;
    const safety = this.config.models.safetyFactor;
    const boundUsd = priced
      ? Math.max(estimateUsd * safety, 0.02)
      : (authorCalls + repairCalls) * this.config.cost.authorCallUsd + judgeCalls * this.config.cost.judgeCallUsd;

    return {
      evolutions: rounds,
      candidatesPerRound: candidates,
      authorCalls: authorTokens.calls,
      judgeCalls: judgeTokens.calls,
      imagesPerJudgeCall,
      tokens: {
        authorInputPerCall: authorTokens.input,
        authorOutputPerCall: authorTokens.output,
        judgeInputPerCall: judgeTokens.input,
        judgeOutputPerCall: judgeTokens.output,
        totalInput: authorTokens.input * authorTokens.calls + judgeTokens.input * judgeTokens.calls,
        totalOutput: authorTokens.output * authorTokens.calls + judgeTokens.output * judgeTokens.calls,
      },
      estimateUsd: estimateUsd === null ? null : round6(estimateUsd),
      boundUsd: round6(boundUsd),
      safetyFactor: safety,
      pricingSource: priced ? 'catalog' : 'configured',
      authorModel: { id: authorModel, known: Boolean(author), priceInUsdPerMTok: author?.priceInUsdPerMTok ?? null, priceOutUsdPerMTok: author?.priceOutUsdPerMTok ?? null },
      judgeModel: { id: judgeModel, known: Boolean(judge), priceInUsdPerMTok: judge?.priceInUsdPerMTok ?? null, priceOutUsdPerMTok: judge?.priceOutUsdPerMTok ?? null },
      note: priced
        ? 'The estimate uses catalog prices and an estimated token count. Provider usage is authoritative.'
        : 'No catalog price is available, so the estimate uses configured conservative bounds.',
    };
  }
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}
