// ─────────────────────────────────────────────────────────────────────────────
// schema.js — a small JSON Schema validator, for the schema keywords this
// project uses. No dependencies, so the browser and Node share one
// implementation.
//
// Supported keywords: type, const, enum, minimum, maximum, exclusiveMinimum,
// exclusiveMaximum, multipleOf, minLength, maxLength, pattern, minItems,
// maxItems, uniqueItems, minProperties, maxProperties, required, properties,
// additionalProperties, items. Unknown keywords are ignored.
// Unsupported: $ref, allOf, anyOf, oneOf, not, if/then/else, format.
// ─────────────────────────────────────────────────────────────────────────────
import { isPlainObject } from './contract.js';

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  if (typeof value === 'number' && Number.isFinite(value)) return 'number';
  return typeof value;
}

function matchesType(value, type) {
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'object') return isPlainObject(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'null') return value === null;
  return typeof value === type;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => deepEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => deepEqual(a[k], b[k]));
  }
  return false;
}

function join(path, key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(String(key)) ? `${path}.${key}` : `${path}[${JSON.stringify(key)}]`;
}

/**
 * Collect every schema violation in `value`.
 * @returns {{path: string, keyword: string, message: string, params?: object}[]}
 */
export function collectSchemaErrors(value, schema, path = '$', errors = []) {
  if (!isPlainObject(schema)) return errors;
  const fail = (keyword, message, params) => errors.push({ path, keyword, message, ...(params ? { params } : {}) });

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      fail('type', `${path} must be ${types.join(' or ')}, got ${typeOf(value)}`, { expected: types, actual: typeOf(value) });
      return errors; // further keyword checks are meaningless
    }
  }

  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    fail('const', `${path} must equal ${JSON.stringify(schema.const)}`, { expected: schema.const });
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((option) => deepEqual(value, option))) {
    fail('enum', `${path} must be one of ${schema.enum.map((v) => JSON.stringify(v)).join(', ')}`, { allowed: schema.enum, actual: value });
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    if (typeof schema.minimum === 'number' && value < schema.minimum) fail('minimum', `${path} must be >= ${schema.minimum}`, { limit: schema.minimum, actual: value });
    if (typeof schema.maximum === 'number' && value > schema.maximum) fail('maximum', `${path} must be <= ${schema.maximum}`, { limit: schema.maximum, actual: value });
    if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) fail('exclusiveMinimum', `${path} must be > ${schema.exclusiveMinimum}`, { limit: schema.exclusiveMinimum, actual: value });
    if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) fail('exclusiveMaximum', `${path} must be < ${schema.exclusiveMaximum}`, { limit: schema.exclusiveMaximum, actual: value });
    if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
      const ratio = value / schema.multipleOf;
      if (Math.abs(ratio - Math.round(ratio)) > 1e-9) fail('multipleOf', `${path} must be a multiple of ${schema.multipleOf}`, { multipleOf: schema.multipleOf, actual: value });
    }
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) fail('minLength', `${path} must have at least ${schema.minLength} characters`, { limit: schema.minLength, actual: value.length });
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) fail('maxLength', `${path} must have at most ${schema.maxLength} characters`, { limit: schema.maxLength, actual: value.length });
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) fail('pattern', `${path} must match ${schema.pattern}`, { pattern: schema.pattern, actual: value });
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail('minItems', `${path} must have at least ${schema.minItems} items`, { limit: schema.minItems, actual: value.length });
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) fail('maxItems', `${path} must have at most ${schema.maxItems} items`, { limit: schema.maxItems, actual: value.length });
    if (schema.uniqueItems === true) {
      for (let i = 0; i < value.length; i++) {
        for (let j = i + 1; j < value.length; j++) {
          if (deepEqual(value[i], value[j])) fail('uniqueItems', `${path}[${j}] duplicates ${path}[${i}]`, { index: j, duplicateOf: i });
        }
      }
    }
    if (isPlainObject(schema.items)) {
      value.forEach((item, index) => collectSchemaErrors(item, schema.items, `${path}[${index}]`, errors));
    }
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (typeof schema.minProperties === 'number' && keys.length < schema.minProperties) fail('minProperties', `${path} must have at least ${schema.minProperties} properties`, { limit: schema.minProperties, actual: keys.length });
    if (typeof schema.maxProperties === 'number' && keys.length > schema.maxProperties) fail('maxProperties', `${path} must have at most ${schema.maxProperties} properties`, { limit: schema.maxProperties, actual: keys.length });
    if (Array.isArray(schema.required)) {
      for (const key of schema.required) {
        if (value[key] === undefined) fail('required', `${path} requires the property ${key}`, { property: key });
      }
    }
    const properties = isPlainObject(schema.properties) ? schema.properties : {};
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        collectSchemaErrors(value[key], properties[key], join(path, key), errors);
      } else if (schema.additionalProperties === false) {
        fail('additionalProperties', `${path} does not allow the property ${key}`, { property: key });
      } else if (isPlainObject(schema.additionalProperties)) {
        collectSchemaErrors(value[key], schema.additionalProperties, join(path, key), errors);
      }
    }
  }

  return errors;
}

/** @returns {{valid: boolean, errors: object[]}} */
export function validateAgainstSchema(value, schema) {
  const errors = collectSchemaErrors(value, schema);
  return { valid: errors.length === 0, errors };
}
