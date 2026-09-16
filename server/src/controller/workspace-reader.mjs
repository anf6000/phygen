// ─────────────────────────────────────────────────────────────────────────────
// workspace-reader.mjs — read the candidate workspace for real file data.
//
// The session edits files in a workspace directory, so the controller can read
// them instead of guessing from the tool arguments. That gives the true line
// count of every file, the true width of every line, and the true size of each
// change.
//
// Reading is safe: the code is never executed. Every path must resolve inside
// the workspace, and a file larger than the cap is reported by size only.
// ─────────────────────────────────────────────────────────────────────────────
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

const MAX_BYTES = 512 * 1024;
const MAX_LINES = 4000;
/** Longest line that counts as a full width bar. */
const FULL_WIDTH_CHARS = 110;

/** Files worth showing, in the order the column should prefer them. */
const INTERESTING = [/^src\/.*\.js$/, /^config\.json$/, /^index\.html$/, /^src\/.*\.mjs$/];
const IGNORED = /(^|\/)(node_modules|\.git|snapshots|dist|\.cache)\//;

export class WorkspaceReader {
  constructor(workspaceDir) {
    this.root = resolve(workspaceDir);
    /** path -> { lines, bytes, mtimeMs } */
    this.known = new Map();
  }

  /** True when `path` stays inside the workspace. */
  #inside(path) {
    if (typeof path !== 'string' || path.length === 0) return null;
    const target = isAbsolute(path) ? resolve(path) : resolve(this.root, path);
    const rel = relative(this.root, target);
    if (rel.length === 0 || rel.startsWith('..') || isAbsolute(rel)) return null;
    return { target, rel: rel.replace(/\\/g, '/') };
  }

  /** Read one file and describe it. Never throws. */
  async #describe(candidate) {
    try {
      const info = await stat(candidate.target);
      if (!info.isFile()) return null;
      if (info.size > MAX_BYTES) {
        return { path: candidate.rel, lines: 0, bytes: info.size, widths: [], truncated: true, mtimeMs: info.mtimeMs };
      }
      const text = await readFile(candidate.target, 'utf8');
      const raw = text.split('\n');
      const clipped = raw.slice(0, MAX_LINES);
      const widths = clipped.map((line) => Math.min(1, line.replace(/\t/g, '    ').length / FULL_WIDTH_CHARS));
      return { path: candidate.rel, lines: raw.length, bytes: info.size, widths, truncated: raw.length > MAX_LINES, mtimeMs: info.mtimeMs };
    } catch {
      return null;
    }
  }

  /**
   * The starting state of the package: every interesting text file with its real
   * line count and shape. Emitted once per session.
   */
  async inventory(files, { limit = 6 } = {}) {
    const pathOf = (file) => String(file?.rel ?? file?.path ?? '');
    const ranked = files
      .filter((file) => {
        const path = pathOf(file);
        return path.length > 0 && !IGNORED.test(path) && INTERESTING.some((pattern) => pattern.test(path));
      })
      .sort((a, b) => {
        const rank = (path) => (path.startsWith('src/') ? 0 : 1);
        return rank(pathOf(a)) - rank(pathOf(b)) || pathOf(a).localeCompare(pathOf(b));
      })
      .slice(0, limit);

    const described = [];
    for (const file of ranked) {
      const candidate = this.#inside(pathOf(file));
      if (!candidate) continue;
      const description = await this.#describe(candidate);
      if (!description) continue;
      this.known.set(description.path, { lines: description.lines, bytes: description.bytes, mtimeMs: description.mtimeMs });
      described.push(description);
    }
    return described;
  }

  /**
   * Re-read one path and report the real change against what we knew.
   * @returns {Promise<{path: string, lines: number, bytes: number, added: number, removed: number, widths: number[]}|null>}
   */
  async touched(path, { withWidths = false } = {}) {
    const candidate = this.#inside(path);
    if (!candidate) return null;
    const description = await this.#describe(candidate);
    if (!description) return null;

    const before = this.known.get(description.path);
    const added = before ? Math.max(0, description.lines - before.lines) : description.lines;
    const removed = before ? Math.max(0, before.lines - description.lines) : 0;
    this.known.set(description.path, { lines: description.lines, bytes: description.bytes, mtimeMs: description.mtimeMs });

    return {
      path: description.path,
      lines: description.lines,
      bytes: description.bytes,
      added,
      removed,
      widths: withWidths || !before ? description.widths.slice(0, MAX_LINES) : [],
    };
  }

  /** The line count we last saw for a path, if any. */
  lines(path) {
    const candidate = this.#inside(path);
    return candidate ? this.known.get(candidate.rel)?.lines ?? null : null;
  }
}
