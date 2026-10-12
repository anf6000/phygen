import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { ConfigurationError } from '../../runtime/contract.js';
import { loadConfiguration, mergeConfiguration, parseOverrides, validateConfiguration } from '../../runtime/config.js';

const BASE = 'http://artwork.test/';
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['num', 'palette'],
  properties: {
    num: { type: 'integer', minimum: 1, maximum: 100 },
    palette: { type: 'string', enum: ['white', 'ice'] },
    gain: { type: 'number', minimum: 0 },
    paused: { type: 'boolean' },
  },
};

const BASELINE = { num: 10, palette: 'white', gain: 1 };

/** A fetch stub over an in-memory file map. `null` means HTTP 404. */
function fakeFetch(files) {
  return async (url) => {
    const name = url.slice(BASE.length);
    if (!(name in files) || files[name] === null) return { ok: false, status: 404 };
    const value = files[name];
    if (typeof value === 'string') {
      return { ok: true, status: 200, json: async () => JSON.parse(value) };
    }
    return { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(value)) };
  };
}

test('the baseline, a variant and overrides merge in order', async () => {
  const fetchImpl = fakeFetch({
    'config.json': BASELINE,
    'config.schema.json': SCHEMA,
    'variants/01.json': { palette: 'ice' },
  });
  const loaded = await loadConfiguration({
    baseUrl: BASE,
    variantUrl: 'variants/01.json',
    overrides: { num: 25 },
    fetchImpl,
  });
  assert.deepEqual(loaded.configuration, { num: 25, palette: 'ice', gain: 1 });
  assert.deepEqual(loaded.sources, ['config.json', 'variants/01.json']);
});

test('a missing baseline fails instead of falling back', async () => {
  const fetchImpl = fakeFetch({ 'config.schema.json': SCHEMA });
  await assert.rejects(
    loadConfiguration({ baseUrl: BASE, fetchImpl }),
    (error) => error instanceof ConfigurationError && error.code === 'configuration_load_failed',
  );
});

test('a missing requested variant fails even when the baseline is valid', async () => {
  const fetchImpl = fakeFetch({ 'config.json': BASELINE, 'config.schema.json': SCHEMA });
  await assert.rejects(
    loadConfiguration({ baseUrl: BASE, variantUrl: 'variants/gone.json', fetchImpl }),
    (error) => error instanceof ConfigurationError && error.code === 'variant_load_failed',
  );
});

test('a missing schema fails', async () => {
  const fetchImpl = fakeFetch({ 'config.json': BASELINE });
  await assert.rejects(
    loadConfiguration({ baseUrl: BASE, fetchImpl }),
    (error) => error.code === 'schema_load_failed',
  );
});

test('a baseline that is not JSON fails', async () => {
  const fetchImpl = fakeFetch({ 'config.json': '{oops', 'config.schema.json': SCHEMA });
  await assert.rejects(
    loadConfiguration({ baseUrl: BASE, fetchImpl }),
    (error) => error.code === 'configuration_load_failed',
  );
});

test('a configuration outside the schema fails and names the field', async () => {
  const fetchImpl = fakeFetch({ 'config.json': { ...BASELINE, num: 5000 }, 'config.schema.json': SCHEMA });
  await assert.rejects(
    loadConfiguration({ baseUrl: BASE, fetchImpl }),
    (error) =>
      error instanceof ConfigurationError &&
      error.code === 'configuration_invalid' &&
      error.details.errors[0].path === '$.num',
  );
});

test('an undeclared configuration key fails', () => {
  assert.throws(
    () => validateConfiguration({ num: 1, palette: 'white', extra: 1 }, SCHEMA),
    (error) => error.code === 'configuration_invalid' && /extra/.test(error.message),
  );
});

test('an out-of-enum value fails', () => {
  assert.throws(
    () => validateConfiguration({ num: 1, palette: 'gold' }, SCHEMA),
    (error) => error.details.errors.some((detail) => detail.keyword === 'enum'),
  );
});

test('comment keys never enter a configuration', () => {
  const merged = mergeConfiguration({ num: 1 }, { _note: 'ignored', palette: 'ice' });
  assert.deepEqual(merged, { num: 1, palette: 'ice' });
});

test('merge does not change its inputs', () => {
  const base = { num: 1, nested: { a: 1 } };
  const extra = { nested: { b: 2 } };
  const merged = mergeConfiguration(base, extra);
  assert.deepEqual(base, { num: 1, nested: { a: 1 } });
  assert.deepEqual(extra, { nested: { b: 2 } });
  assert.deepEqual(merged, { num: 1, nested: { a: 1, b: 2 } });
});

test('search parameters override only declared keys', () => {
  const params = new URLSearchParams('num=42&paused=1&steps=900&config=variants/x.json');
  const overrides = parseOverrides(params, SCHEMA);
  assert.deepEqual(overrides, { num: 42, paused: true });
  assert.equal(typeof overrides.num, 'number');
  assert.equal(overrides.paused, true);
});

test('a search parameter that is not a number fails', () => {
  const params = new URLSearchParams('num=lots');
  assert.throws(() => parseOverrides(params, SCHEMA), (error) => error.code === 'override_invalid');
});

test('loadConfiguration accepts search parameters directly', async () => {
  const fetchImpl = fakeFetch({ 'config.json': BASELINE, 'config.schema.json': SCHEMA });
  const loaded = await loadConfiguration({
    baseUrl: BASE,
    overrides: new URLSearchParams('num=7&steps=100'),
    fetchImpl,
  });
  assert.equal(loaded.configuration.num, 7);
});

test('the package baseline matches the package schema', async () => {
  const url = new URL('../config.json', import.meta.url);
  const schemaUrl = new URL('../config.schema.json', import.meta.url);
  const baseline = JSON.parse(readFileSync(url, 'utf8'));
  const schema = JSON.parse(readFileSync(schemaUrl, 'utf8'));
  validateConfiguration(baseline, schema);
});
