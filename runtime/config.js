// ─────────────────────────────────────────────────────────────────────────────
// config.js — configuration merge, override parsing, and strict loading.
//
// Loading is strict on purpose. The plan requires that a requested
// configuration load failure fails the candidate. The runtime never shows the
// baseline when a requested configuration is missing or invalid.
//
// Resolution order (later entries win):
//   package baseline (config.json) → requested variant → caller overrides
// ─────────────────────────────────────────────────────────────────────────────
import { ConfigurationError, isPlainObject } from './contract.js';
import { validateAgainstSchema } from './schema.js';

/** Keys with this prefix are comments. They never enter a configuration. */
export const COMMENT_PREFIX = '_';

/**
 * Merge `extra` over `base` and return a new object. Nested plain objects merge
 * one level deep. Keys that start with `_` are skipped.
 */
export function mergeConfiguration(base, extra) {
  const out = isPlainObject(base) ? { ...base } : {};
  if (!isPlainObject(extra)) return out;
  for (const key of Object.keys(extra)) {
    if (key.startsWith(COMMENT_PREFIX)) continue;
    const value = extra[key];
    const bothObjects = isPlainObject(value) && isPlainObject(out[key]);
    out[key] = bothObjects ? { ...out[key], ...value } : value;
  }
  return out;
}

/**
 * Throw a ConfigurationError unless `configuration` matches `schema`.
 * @param {object} configuration
 * @param {object} schema JSON Schema (the schema.js subset)
 */
export function validateConfiguration(configuration, schema) {
  const { valid, errors } = validateAgainstSchema(configuration, schema);
  if (!valid) {
    throw new ConfigurationError(
      'configuration_invalid',
      `The configuration violates the declared schema (${errors.length} problem(s)); first: ${errors[0].message}`,
      { errors },
    );
  }
  return configuration;
}

/** Coerce one override value to the type the schema declares for that key. */
function coerceOverride(key, raw, propertySchema) {
  const declared = propertySchema?.type;
  const types = Array.isArray(declared) ? declared : declared ? [declared] : [];
  if (types.includes('integer') || types.includes('number')) {
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      throw new ConfigurationError('override_invalid', `The override ${key}=${raw} is not a number`, { key, value: raw });
    }
    return n;
  }
  if (types.includes('boolean')) return raw !== '0' && raw.toLowerCase() !== 'false';
  return raw;
}

/**
 * Read configuration overrides from a query string. Only keys that the schema
 * declares are read; other query keys (run controls, the variant path) belong
 * to the caller.
 */
export function parseOverrides(searchParams, schema) {
  const properties = isPlainObject(schema?.properties) ? schema.properties : null;
  const out = {};
  if (!searchParams) return out;
  for (const [key, raw] of searchParams.entries()) {
    if (key.startsWith(COMMENT_PREFIX)) continue;
    if (properties && !Object.prototype.hasOwnProperty.call(properties, key)) continue;
    out[key] = coerceOverride(key, raw, properties?.[key]);
  }
  return out;
}

async function fetchJson(fetchImpl, url, failureCode, label) {
  let response;
  try {
    response = await fetchImpl(url, { cache: 'no-cache' });
  } catch (cause) {
    throw new ConfigurationError(failureCode, `${label} could not be fetched from ${url}: ${cause.message}`, { url, cause: String(cause.message) });
  }
  if (!response || !response.ok) {
    throw new ConfigurationError(failureCode, `${label} is not available at ${url} (HTTP ${response?.status ?? 'no response'})`, { url, status: response?.status ?? null });
  }
  try {
    return await response.json();
  } catch (cause) {
    throw new ConfigurationError(failureCode, `${label} at ${url} is not valid JSON: ${cause.message}`, { url });
  }
}

/**
 * Load and validate one artwork configuration.
 *
 * Every step is mandatory. A missing or invalid schema, baseline, or requested
 * variant raises a ConfigurationError. Callers must fail the candidate; they
 * must not continue with a default.
 *
 * @param {object} options
 * @param {string} options.baseUrl       absolute base URL of the artwork package
 * @param {string} [options.baselineUrl] baseline file name, relative to baseUrl
 * @param {string} [options.schemaUrl]   schema file name, relative to baseUrl
 * @param {string|null} [options.variantUrl] requested variant, relative to baseUrl
 * @param {object|URLSearchParams|null} [options.overrides] caller overrides applied last.
 *        A URLSearchParams value is read through `parseOverrides` after the schema loads.
 * @param {object|null} [options.schema] schema object, if the caller already has it
 * @param {Function} [options.fetchImpl] fetch implementation, for tests
 * @returns {Promise<{configuration: object, schema: object, sources: string[]}>}
 */
export async function loadConfiguration({
  baseUrl,
  baselineUrl = 'config.json',
  schemaUrl = 'config.schema.json',
  variantUrl = null,
  overrides = null,
  schema = null,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new ConfigurationError('fetch_unavailable', 'No fetch implementation is available to load the configuration');
  }
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) {
    throw new ConfigurationError('base_url_missing', 'loadConfiguration needs the package baseUrl');
  }
  const base = new URL(baseUrl);
  const resolve = (relative) => new URL(relative, base).href;

  const loadedSchema = schema ?? (await fetchJson(fetchImpl, resolve(schemaUrl), 'schema_load_failed', 'The configuration schema'));
  if (!isPlainObject(loadedSchema) || !isPlainObject(loadedSchema.properties)) {
    throw new ConfigurationError('schema_invalid', `The configuration schema at ${resolve(schemaUrl)} has no properties object`);
  }

  const sources = [];
  const baseline = await fetchJson(fetchImpl, resolve(baselineUrl), 'configuration_load_failed', 'The baseline configuration');
  sources.push(baselineUrl);
  let configuration = mergeConfiguration({}, baseline);

  if (variantUrl) {
    const variant = await fetchJson(fetchImpl, resolve(variantUrl), 'variant_load_failed', `The requested variant ${variantUrl}`);
    sources.push(variantUrl);
    configuration = mergeConfiguration(configuration, variant);
  }

  const applied = overrides && !isPlainObject(overrides) ? parseOverrides(overrides, loadedSchema) : overrides ?? {};
  configuration = mergeConfiguration(configuration, applied);
  validateConfiguration(configuration, loadedSchema);
  return { configuration, schema: loadedSchema, sources };
}
