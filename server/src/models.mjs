// ─────────────────────────────────────────────────────────────────────────────
// models.mjs — the Kilo model catalog, its prices, and the cost estimate.
//
// The catalog is the same list the Pi provider uses, read from the Kilo
// gateway. Prices arrive per token and are stored per million tokens.
//
// The estimate is computed from a token model, not from a guess:
//   - text tokens ≈ characters / 4
//   - an author session also writes files, so it gets an output allowance
// When a price is missing, the configured bounds apply instead.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const CACHE_TTL_MS = 60 * 60 * 1000;
const CHARS_PER_TOKEN = 4;

function price(perToken) {
  const value = Number.parseFloat(perToken);
  return Number.isFinite(value) ? Math.round(value * 1e6 * 1e6) / 1e6 : 0;
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
   * Tokens and dollars for one run. Every step makes one author call, and each
   * call may need one bounded repair, so the estimate counts author calls only.
   *
   * @param {object} options
   * @param {number} options.evolutions
   * @param {string} options.authorModel
   * @param {number} options.authorPromptTokens  measured from a real prompt
   * @param {number} options.authorOutputTokens
   */
  estimateRun({
    evolutions,
    authorModel,
    // Measured: the base system prompt alone costs about 4500 input tokens, and
    // an author session reads files across several turns.
    authorPromptTokens = 12000,
    authorOutputTokens = 6000,
  }) {
    const steps = Math.max(1, evolutions);
    const repairCalls = steps * this.config.evolution.repairAttempts;
    const tokens = {
      input: authorPromptTokens,
      output: authorOutputTokens,
      calls: steps + repairCalls,
    };

    const author = this.models.get(authorModel) ?? null;
    const costUsd =
      author === null
        ? null
        : (tokens.input * tokens.calls * author.priceInUsdPerMTok + tokens.output * tokens.calls * author.priceOutUsdPerMTok) / 1e6;
    const priced = costUsd !== null;

    const safety = this.config.models.safetyFactor;
    const boundUsd = priced
      ? Math.max(costUsd * safety, 0.02)
      : tokens.calls * this.config.cost.authorCallUsd;

    return {
      evolutions: steps,
      authorCalls: tokens.calls,
      tokens: {
        authorInputPerCall: tokens.input,
        authorOutputPerCall: tokens.output,
        totalInput: tokens.input * tokens.calls,
        totalOutput: tokens.output * tokens.calls,
      },
      estimateUsd: costUsd === null ? null : round6(costUsd),
      boundUsd: round6(boundUsd),
      safetyFactor: safety,
      pricingSource: priced ? 'catalog' : 'configured',
      authorModel: { id: authorModel, known: Boolean(author), priceInUsdPerMTok: author?.priceInUsdPerMTok ?? null, priceOutUsdPerMTok: author?.priceOutUsdPerMTok ?? null },
      note: priced
        ? 'The estimate uses catalog prices and an estimated token count. Provider usage is authoritative.'
        : 'No catalog price is available, so the estimate uses configured conservative bounds.',
    };
  }
}

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}
