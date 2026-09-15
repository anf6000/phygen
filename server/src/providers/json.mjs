// ─────────────────────────────────────────────────────────────────────────────
// json.mjs — pull one JSON object out of a model response.
//
// A judge answer must be structured. A response without usable JSON is a
// failure, never a reason to fall back to prose.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Find the first balanced JSON object in a text block.
 * Handles a fenced code block and stray prose around the object.
 * @returns {object|null}
 */
export function extractJson(text) {
  if (typeof text !== 'string' || text.length === 0) return null;
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  candidates.push(text);

  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    if (start === -1) continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < candidate.length; index++) {
      const char = candidate[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === '{') depth++;
      else if (char === '}') {
        depth--;
        if (depth === 0) {
          try {
            const value = JSON.parse(candidate.slice(start, index + 1));
            if (value && typeof value === 'object' && !Array.isArray(value)) return value;
          } catch {
            // try the next candidate
          }
          break;
        }
      }
    }
  }
  return null;
}
