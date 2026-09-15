// ─────────────────────────────────────────────────────────────────────────────
// util.mjs — small shared helpers. No dependencies.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash, randomBytes } from 'node:crypto';

/** A short, sortable identifier with a type prefix. */
export function newId(prefix) {
  const stamp = Date.now().toString(36);
  const random = randomBytes(4).toString('hex');
  return `${prefix}_${stamp}${random}`;
}

export function nowIso() {
  return new Date().toISOString();
}

export function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Key order does not change the hash. */
export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/** Run tasks with a fixed concurrency limit, keeping the result order. */
export async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function truncate(text, limit = 4000) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}… (${value.length - limit} more characters)`;
}

export function unique(values) {
  return [...new Set(values)];
}
