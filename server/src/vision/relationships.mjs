// ─────────────────────────────────────────────────────────────────────────────
// relationships.mjs — the two measures that read records, not pixels.
//
// Both are deterministic and free: no model, no spend, and the same input always
// gives the same score. They carry the part of novelty that a frame cannot show
// — a different configuration, or different source — and they feed the archive
// report and the self-written direction.
// ─────────────────────────────────────────────────────────────────────────────

/** Flatten any configuration value into comparable scalar leaves. */
export function flattenConfiguration(value) {
  return flatten(value ?? {});
}

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
 * The distance between the configurations of two versions, in 0..1.
 * A high score means the two versions set their parameters differently.
 *
 * Wired by the same later slice as `sourceSimilarity`; the pure function and its
 * test are in place now.
 *
 * @returns {{score: number, evidence: object}}
 */
export function configDistance(a, b) {
  const left = flattenConfiguration(a?.configuration ?? {});
  const right = flattenConfiguration(b?.configuration ?? {});
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort();
  if (keys.length === 0) {
    return { score: 0, evidence: { comparedKeys: 0, changedCount: 0, changedKeys: [], note: 'Neither version holds a configuration value.' } };
  }
  const changedKeys = [];
  for (const key of keys) {
    if ((left.get(key) ?? '<absent>') !== (right.get(key) ?? '<absent>')) {
      changedKeys.push({ key, a: left.get(key) ?? null, b: right.get(key) ?? null });
    }
  }
  return {
    score: changedKeys.length / keys.length,
    evidence: { comparedKeys: keys.length, changedCount: changedKeys.length, changedKeys: changedKeys.slice(0, 40) },
  };
}

/** Identifier and literal shingles of one source text. */
function shingles(text, size = 5) {
  const tokens = String(text)
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

function shingleSet(sources) {
  const set = new Set();
  for (const [path, text] of sources?.files ?? []) {
    for (const shingle of shingles(text)) set.add(`${path}\u0000${shingle}`);
  }
  return set;
}

/**
 * The Jaccard similarity of the source packages of two versions, in 0..1.
 * A high score means the two versions wrote similar code.
 *
 * The run does not call this or `configDistance` yet: the gate measures frames,
 * and the archive report reads judged scores. The step loop wires these two in
 * when it picks explore parents from the archive.
 *
 * @param {{files: Map<string, string>}} aSources
 * @param {{files: Map<string, string>}} bSources
 * @returns {{score: number|null, evidence: object}}
 */
export function sourceSimilarity(aSources, bSources) {
  const left = shingleSet(aSources);
  const right = shingleSet(bSources);
  if (left.size === 0 && right.size === 0) {
    return { score: null, evidence: { note: 'Neither version holds readable source text.', sharedShingles: 0, unionShingles: 0 } };
  }
  let shared = 0;
  for (const shingle of left) if (right.has(shingle)) shared += 1;
  const union = left.size + right.size - shared;
  return {
    score: union === 0 ? 1 : shared / union,
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
