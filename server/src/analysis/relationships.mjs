// ─────────────────────────────────────────────────────────────────────────────
// relationships.mjs — bounded measurement of the RELATIONSHIP between versions.
//
// A measurement is NOT ancestry. Two versions can be measured whether or not one
// is the ancestor of the other, and a pair record never changes a parent link.
//
// Every measure declares three properties that the interface states:
//
//   id           the stable identifier stored with each record
//   method       "deterministic" (no model, no spend) or "model"
//   direction    what a HIGH score means, in one sentence
//
// A measure whose method is "model" needs a provider, a credential, and a
// budget. When it is not enabled the interface says so; it is never replaced by
// a silent approximation.
//
// Candidate generation is bounded and deterministic:
//   - every version is measured against its parent and against its same-round
//     siblings, because those are the comparisons the run itself used;
//   - the remaining budget is spread over the groups a viewer asks about
//     (same round, adjacent generations, same slot), filled with a seeded
//     shuffle so the same input gives the same sample.
// The plan never reads a canvas position, so a layout change cannot change it.
// ─────────────────────────────────────────────────────────────────────────────
import { createHash } from 'node:crypto';

/** A small, seeded, reproducible generator. Not cryptographic. */
function seededRandom(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x100000000;
  };
}

function seedFrom(text) {
  return parseInt(createHash('sha256').update(text).digest('hex').slice(0, 8), 16);
}

/** The canonical key of a pair: sorted, so the order of the two never matters. */
export function pairKey(a, b) {
  return a < b ? `${a}~${b}` : `${b}~${a}`;
}

/** A stable band for a score, so a filter means the same thing in every view. */
export function bandFor(score) {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'unknown';
  if (score >= 0.75) return 'far';
  if (score >= 0.4) return 'distinct';
  if (score >= 0.12) return 'close';
  return 'near';
}

export const MEASURES = [
  {
    id: 'configuration',
    label: 'Configuration distance',
    method: 'deterministic',
    available: true,
    direction: 'A high score means the two versions set their parameters differently.',
    description: 'Compares every configuration field of the two versions. No model, no spend, and the same input always gives the same score.',
  },
  {
    id: 'source',
    label: 'Source similarity',
    method: 'deterministic',
    available: true,
    direction: 'A high score means the two versions wrote different code.',
    description: 'Compares overlapping token sequences of the package source files. No model, no spend, and the same input always gives the same score.',
  },
  {
    id: 'appearance',
    label: 'Appearance similarity',
    method: 'model',
    available: false,
    unavailableReason: 'No appearance measure is configured. Enable one to compare the captured frames of two versions.',
    direction: 'A high score would mean the two versions look different.',
    description: 'Would compare the captured frames with a model that can read images. It spends money per pair, so it stays off until it is enabled on purpose.',
  },
];

export function measureById(id) {
  return MEASURES.find((measure) => measure.id === id) ?? null;
}

/** The number of pairs a complete measurement of n versions would hold. */
export function fullPairCount(n) {
  return n < 2 ? 0 : (n * (n - 1)) / 2;
}

export function revisionOf({ measure, versions, hashes }) {
  const parts = versions.map((version) => `${version.id}:${hashes.get(version.id) ?? ''}`).sort();
  return createHash('sha256').update(`${measure}\n${parts.join('\n')}`).digest('hex');
}

/**
 * The pairs to measure, bounded and deterministic.
 *
 * @param {object} options
 * @param {object[]} options.versions   the versions of one artwork
 * @param {string} options.measure
 * @param {number} [options.limit]      the greatest number of pairs
 * @returns {{pairs: {a: string, b: string, group: string}[], groups: object, considered: number}}
 */
export function planPairs({ versions, measure, limit = 400 }) {
  const ordered = [...versions].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1));
  const byId = new Map(ordered.map((version) => [version.id, version]));
  const chosen = new Map();
  const groups = { lineage: 0, round: 0, generation: 0, slot: 0, sampled: 0, skipped: 0 };

  const add = (a, b, group) => {
    if (!a || !b || a === b) return;
    if (!byId.has(a) || !byId.has(b)) return;
    const key = pairKey(a, b);
    const existing = chosen.get(key);
    // The first reason wins: lineage is kept above a sampled pair.
    if (existing) {
      if (existing.group === 'sampled' && group !== 'sampled') chosen.set(key, { a, b, group });
      return;
    }
    if (chosen.size >= limit) {
      groups.skipped += 1;
      return;
    }
    chosen.set(key, { a, b, group });
    groups[group] += 1;
  };

  // 1. The comparisons the run itself used.
  for (const version of ordered) {
    if (version.parentId) add(version.parentId, version.id, 'lineage');
  }
  // 2. Same round, same generation: the variants that competed.
  const byRound = new Map();
  for (const version of ordered) {
    if (version.round === null || version.round === undefined) continue;
    const list = byRound.get(version.round) ?? [];
    list.push(version.id);
    byRound.set(version.round, list);
  }
  for (const ids of byRound.values()) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) add(ids[i], ids[j], 'round');
  }
  // 3. Adjacent generations.
  const byGeneration = new Map();
  for (const version of ordered) {
    const list = byGeneration.get(version.generation) ?? [];
    list.push(version.id);
    byGeneration.set(version.generation, list);
  }
  for (const generation of byGeneration.keys()) {
    const lower = byGeneration.get(generation - 1) ?? [];
    const here = byGeneration.get(generation) ?? [];
    for (const a of lower) for (const b of here) add(a, b, 'generation');
  }
  // 4. Same slot across generations.
  const bySlot = new Map();
  for (const version of ordered) {
    if (!version.slot) continue;
    const list = bySlot.get(version.slot) ?? [];
    list.push(version.id);
    bySlot.set(version.slot, list);
  }
  for (const ids of bySlot.values()) {
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) add(ids[i], ids[j], 'slot');
  }

  // 5. Fill the remaining budget with a seeded shuffle of the rest.
  const rest = [];
  for (let i = 0; i < ordered.length; i++) {
    for (let j = i + 1; j < ordered.length; j++) {
      const key = pairKey(ordered[i].id, ordered[j].id);
      if (!chosen.has(key)) rest.push({ a: ordered[i].id, b: ordered[j].id });
    }
  }
  const random = seededRandom(seedFrom(`${measure}:${ordered.map((version) => version.id).join(',')}`));
  for (let index = rest.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    [rest[index], rest[swap]] = [rest[swap], rest[index]];
  }
  for (const pair of rest) add(pair.a, pair.b, 'sampled');

  const pairs = [...chosen.values()];
  return { pairs, groups, considered: fullPairCount(ordered.length) };
}

// ── deterministic measures ───────────────────────────────────────────────────

/** Flatten any configuration value into comparable scalar leaves. */
export function flattenConfiguration(value) {
  return flatten(value ?? {});
}

/** Flatten any configuration value into comparable scalar leaves. */
function flatten(value, prefix = '', out = new Map()) {
  if (value === null || value === undefined) {
    out.set(prefix, 'null');
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => flatten(entry, `${prefix}[${index}]`, out));
    return out;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value).sort()) flatten(value[key], prefix ? `${prefix}.${key}` : key, out);
    return out;
  }
  out.set(prefix, String(value));
  return out;
}

/**
 * The distance between the configurations of two versions.
 * @returns {{score: number, evidence: object}}
 */
export function measureConfiguration(a, b) {
  const left = flatten(a.configuration ?? {});
  const right = flatten(b.configuration ?? {});
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  if (keys.length === 0) {
    return { score: 0, evidence: { comparedKeys: 0, changedKeys: [], note: 'Neither version holds a configuration value.' } };
  }
  const changedKeys = [];
  for (const key of keys) {
    if ((left.get(key) ?? '<absent>') !== (right.get(key) ?? '<absent>')) changedKeys.push({ key, a: left.get(key) ?? null, b: right.get(key) ?? null });
  }
  return {
    score: changedKeys.length / keys.length,
    evidence: {
      comparedKeys: keys.length,
      changedKeys: changedKeys.slice(0, 40),
      changedCount: changedKeys.length,
    },
  };
}

/** Identifier and literal shingles of one source text. */
function shingles(text, size = 5) {
  const tokens = text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .split(/[^A-Za-z0-9_$]+/)
    .filter((token) => token.length > 0);
  const set = new Set();
  if (tokens.length < size) {
    if (tokens.length > 0) set.add(tokens.join(' '));
    return set;
  }
  for (let index = 0; index + size <= tokens.length; index++) set.add(tokens.slice(index, index + size).join(' '));
  return set;
}

/**
 * The distance between the source packages of two versions.
 *
 * @param {{files: Map<string, string>}[]} sources the source text of each version
 * @returns {{score: number, evidence: object}}
 */
export function measureSource(aSources, bSources) {
  const collect = (sources) => {
    const set = new Set();
    for (const [path, text] of sources?.files ?? []) {
      for (const shingle of shingles(text)) set.add(`${path}\u0000${shingle}`);
    }
    return set;
  };
  const left = collect(aSources);
  const right = collect(bSources);
  if (left.size === 0 && right.size === 0) {
    return { score: null, evidence: { note: 'Neither version holds readable source text.', sharedShingles: 0, totalShingles: 0 } };
  }
  let shared = 0;
  for (const shingle of left) if (right.has(shingle)) shared += 1;
  const union = left.size + right.size - shared;
  return {
    score: union === 0 ? 0 : 1 - shared / union,
    evidence: {
      sharedShingles: shared,
      unionShingles: union,
      aShingles: left.size,
      bShingles: right.size,
      aBytes: [...(aSources?.files?.values() ?? [])].reduce((total, text) => total + text.length, 0),
      bBytes: [...(bSources?.files?.values() ?? [])].reduce((total, text) => total + text.length, 0),
    },
  };
}

/**
 * Measure one pair with one measure.
 *
 * @param {object} options
 * @param {string} options.measure
 * @param {object} options.a      a version record
 * @param {object} options.b      a version record
 * @param {object} [options.aSources] `{files: Map<string, string>}` for the source measure
 * @param {object} [options.bSources]
 * @returns {{score: number|null, band: string, evidence: object}}
 */
export function measurePair({ measure, a, b, aSources, bSources }) {
  let result;
  if (measure === 'configuration') result = measureConfiguration(a, b);
  else if (measure === 'source') result = measureSource(aSources ?? { files: new Map() }, bSources ?? { files: new Map() });
  else {
    const declared = measureById(measure);
    if (declared && declared.method === 'model') {
      const error = new Error(`The ${declared.label} measure is not enabled.`);
      error.code = 'measure_not_enabled';
      throw error;
    }
    const error = new Error(`No measure is named ${measure}.`);
    error.code = 'measure_unknown';
    throw error;
  }
  return { score: result.score, band: bandFor(result.score), evidence: result.evidence };
}