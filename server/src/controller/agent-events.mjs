// ─────────────────────────────────────────────────────────────────────────────
// agent-events.mjs — turn Pi session events into a small feed for the interface.
//
// Pi emits, in JSON mode:
//   tool_execution_start  the tool name and its arguments
//   tool_execution_end    the result and whether it failed
//   message_update        the assistant text and reasoning as they arrive
//   message_end           the final message of one model answer
//   turn_start, turn_end  one model turn
//
// The feed keeps one row per tool call, with the file and the line change, the
// reasoning rows, and the assistant text. Reasoning stays separate from the
// answer, and each row holds a cap, so one row cannot flood the stream.
// Nothing here reads the file system: the arguments hold the difference.
// ─────────────────────────────────────────────────────────────────────────────

const TEXT_LIMIT = 4000;

/** Lines added and removed by one edit pair. */
function lineDelta(before, after) {
  const oldLines = String(before ?? '').split('\n');
  const newLines = String(after ?? '').split('\n');
  return { added: newLines.length, removed: oldLines.length };
}

/**
 * A short path for the feed. A workspace path keeps its package-relative part:
 * the version folder that holds it is noise.
 */
export function shortPath(value) {
  const text = String(value ?? '').replace(/\\/g, '/');
  const parts = text.split('/').filter(Boolean);
  if (parts.length === 0) return text;
  const tail = parts.slice(-2);
  if (tail.length === 2 && tail[0].startsWith('ver_')) return tail[1];
  return tail.join('/');
}

/**
 * The smallest edit pair that turns `before` into `after`: the lines that
 * differ, with the shared start and end removed.
 */
export function minimalEdit(before, after) {
  const oldLines = String(before ?? '').split('\n');
  const newLines = String(after ?? '').split('\n');
  let head = 0;
  while (head < oldLines.length && head < newLines.length && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (
    tail < oldLines.length - head &&
    tail < newLines.length - head &&
    oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]
  ) {
    tail++;
  }
  return {
    oldText: oldLines.slice(head, oldLines.length - tail).join('\n'),
    newText: newLines.slice(head, newLines.length - tail).join('\n'),
  };
}

/**
 * Describe one tool call.
 * @returns {{tool: string, path: string|null, added: number, removed: number, writes: number, edits: number}}
 */
export function describeTool({ toolName, args }) {
  const path = typeof args?.path === 'string' ? shortPath(args.path) : null;
  const describe = { tool: toolName, path, added: 0, removed: 0, writes: 0, edits: 0 };

  if (toolName === 'edit' && Array.isArray(args?.edits)) {
    for (const edit of args.edits) {
      const delta = lineDelta(edit?.oldText, edit?.newText);
      describe.added += delta.added;
      describe.removed += delta.removed;
      describe.edits += 1;
    }
    return describe;
  }
  if (toolName === 'write' && typeof args?.content === 'string') {
    const lines = args.content.split('\n');
    describe.added = lines.length;
    describe.writes = 1;
    return describe;
  }
  return describe;
}

const REASONING_TYPES = new Set(['reasoning', 'thinking', 'redacted_thinking']);

/**
 * Readable text for the shell. The provider marks attached frames with
 * `<file name="…">` tags, which are noise and hold a local path.
 */
export function cleanText(value) {
  return String(value ?? '')
    .replace(/<file\b[^>]*>/gi, '')
    .replace(/<\/file>/gi, '')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
}

/** The reasoning content blocks of one message, joined. */
export function reasoningFromMessage(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && REASONING_TYPES.has(block.type))
    .map((block) => block.text ?? block.thinking ?? '')
    .join('')
    .trim();
}

/** The assistant text a `message_update` carries, if any. */
export function textFromUpdate(event) {
  const candidates = [
    typeof event?.delta === 'string' ? event.delta : null,
    typeof event?.text === 'string' ? event.text : null,
    event?.message?.content,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) return candidate.trim();
    if (Array.isArray(candidate)) {
      const text = candidate
        .filter((block) => block && (block.type === 'text' || block.type === 'output_text'))
        .map((block) => block.text ?? '')
        .join('')
        .trim();
      if (text.length > 0) return text;
    }
  }
  return '';
}

/**
 * Map one Pi event to zero or more feed rows.
 * @param {object} event
 * @param {string} versionId
 * @returns {object[]} feed rows for the `agent` event type
 */
export function feedRows(event, versionId) {
  if (!event || typeof event.type !== 'string') return [];

  if (event.type === 'tool_execution_start') {
    return [{ versionId, kind: 'tool', state: 'start', ...describeTool(event) }];
  }
  if (event.type === 'tool_execution_end') {
    return [
      {
        versionId,
        kind: 'tool',
        state: 'end',
        tool: event.toolName ?? null,
        path: null,
        ok: event.isError !== true,
      },
    ];
  }
  if (event.type === 'message_update') {
    const reasoning = reasoningFromMessage(event.message);
    if (reasoning.length > 0) return [{ versionId, kind: 'reason', text: reasoning.slice(-TEXT_LIMIT) }];
    const text = textFromUpdate(event);
    if (text.length === 0) return [];
    const readable = cleanText(text);
    if (readable.length === 0) return [];
    return [{ versionId, kind: 'text', text: readable.slice(-TEXT_LIMIT) }];
  }
  if (event.type === 'message_end') {
    // The final message holds the answer, and may also hold reasoning. Report
    // both, so the answer is visible even when the provider streams no deltas.
    const rows = [];
    const reasoning = reasoningFromMessage(event.message);
    if (reasoning.length > 0) rows.push({ versionId, kind: 'reason', text: reasoning.slice(-TEXT_LIMIT) });
    const content = event.message?.content;
    const text = Array.isArray(content)
      ? content
          .filter((block) => block && (block.type === 'text' || block.type === 'output_text'))
          .map((block) => block.text ?? '')
          .join('')
          .trim()
      : typeof content === 'string'
        ? content.trim()
        : '';
    if (text.length > 0) rows.push({ versionId, kind: 'text', text: cleanText(text).slice(-TEXT_LIMIT) });
    return rows;
  }
  if (event.type === 'turn_end') {
    const usage = event.message?.usage ?? event.usage ?? null;
    return [
      {
        versionId,
        kind: 'turn',
        tokens: Number(usage?.totalTokens ?? 0) || 0,
        costUsd: Number(usage?.cost?.total ?? 0) || 0,
      },
    ];
  }
  return [];
}
