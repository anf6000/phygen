// ─────────────────────────────────────────────────────────────────────────────
// CodeStream.tsx — the whole file as an abstraction, one stroke per line.
//
// The canvas draws every line of the file as a single thin stroke, so the shape
// of the file is visible at a glance instead of a window of it. The session
// reads down the column: at the head, new lines arrive green and settle, and
// deleted lines turn red and collapse. The input is the tool rows of one
// version: an edit row carries the added and removed line counts of that call.
//
// The file size is an abstraction. It starts at BASELINE_LINES and follows the
// edits, which is what the record gives us.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef } from 'react';

import type { AgentRow, FileRow } from '../types';

const BASELINE_LINES = 260;
/** Widths of the lines the session adds, until the next real read. */
const DEFAULT_WIDTH = 0.55;
const EAT_MS = 300;
const SETTLE_MS = 560;
const HEAD_SPEED = 0.00030;

interface LineState {
  /** 0 is fresh green, 1 is settled. */
  age: number;
  /** Set when the head has taken the line. */
  eatenAt: number | null;
}

/** A stable width factor per line index, so the shape of the code is steady. */
function widthFactor(index: number): number {
  const mixed = Math.sin(index * 12.9898 + 4.1414) * 43758.5453;
  return 0.22 + (mixed - Math.floor(mixed)) * 0.72;
}

export function CodeStream({ rows, files, active }: { rows: AgentRow[]; files: FileRow[]; active: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const linesRef = useRef<LineState[]>(
    Array.from({ length: BASELINE_LINES }, () => ({ age: 1, eatenAt: null })),
  );
  /** The real width of every line of the file the session works on. */
  const widthsRef = useRef<number[] | null>(null);
  const fileRef = useRef<string | null>(null);
  const headRef = useRef(0.2);
  const handledRef = useRef(0);

  const edits = useMemo(
    () =>
      rows
        .filter((row) => row.kind === 'tool' && row.state === 'start' && ((row.added ?? 0) > 0 || (row.removed ?? 0) > 0))
        .map((row) => ({ seq: row.seq, added: row.added ?? 0, removed: row.removed ?? 0 })),
    [rows],
  );

  // The real files of this version: an inventory names the file, a change
  // reports its true line count after an edit.
  const inventory = useMemo(() => files.filter((file) => file.kind === 'inventory' && (file.widths?.length ?? 0) > 0), [files]);
  const changes = useMemo(() => files.filter((file) => file.kind === 'change'), [files]);
  const target = useMemo(() => {
    if (inventory.length === 0) return null;
    const counts = new Map<string, number>();
    for (const change of changes) counts.set(change.path, (counts.get(change.path) ?? 0) + 1);
    // The file the session works on. With no change yet, prefer the artwork
    // sources over the protected runtime files.
    const preferred = (path: string) => (/physarum|renderer/.test(path) ? 0 : path.startsWith('src/') ? 1 : 2);
    return [...inventory].sort(
      (a, b) =>
        (counts.get(b.path) ?? 0) - (counts.get(a.path) ?? 0) ||
        preferred(a.path) - preferred(b.path) ||
        b.lines - a.lines,
    )[0];
  }, [inventory, changes]);

  // Start from the real file: its real line count and the real width of each line.
  useEffect(() => {
    handledRef.current = 0;
    headRef.current = 0.2;
    fileRef.current = target?.path ?? null;
    widthsRef.current = target?.widths ? [...target.widths] : null;
    const count = target ? target.lines : BASELINE_LINES;
    linesRef.current = Array.from({ length: Math.max(1, count) }, () => ({ age: 1, eatenAt: null }));
  }, [target]);

  // A real change: the file grew or shrank by the counts the reader measured.
  useEffect(() => {
    const latest = changes.slice(-1)[0];
    if (!latest || latest.path !== fileRef.current) return;
    const state = linesRef.current;
    const want = Math.max(1, latest.lines);
    if (want === state.length) return;
    if (want > state.length) {
      const added = want - state.length;
      const grown = [...state];
      const widths = widthsRef.current ?? [];
      for (let count = 0; count < added; count++) {
        grown.push({ age: 0, eatenAt: null });
        widths.push(DEFAULT_WIDTH);
      }
      widthsRef.current = widths;
      linesRef.current = grown;
      return;
    }
    const removed = state.length - want;
    const kept = state.slice(0, want);
    const now = performance.now();
    for (let count = 0; count < removed && count < state.length; count++) {
      const index = state.length - 1 - count;
      if (index >= want) state[index] = { ...state[index], eatenAt: now };
    }
    linesRef.current = [...kept, ...state.slice(want)];
    if (widthsRef.current) widthsRef.current = widthsRef.current.slice(0, want);
  }, [changes]);

  // Apply each new edit at the head: new lines appear, the last ones are eaten.
  useEffect(() => {
    const pending = edits.filter((edit) => edit.seq > handledRef.current);
    if (pending.length === 0) return;
    handledRef.current = pending[pending.length - 1].seq;

    for (const edit of pending) {
      const lines = linesRef.current;
      const at = Math.min(lines.length, Math.max(1, Math.round(headRef.current * lines.length)));
      const grown = lines.slice(0, at);
      for (let count = 0; count < edit.added; count++) grown.push({ age: 0, eatenAt: null });
      const tail = lines.slice(at);
      for (let count = 0; count < edit.removed && tail.length > 0; count++) {
        const index = tail.length - 1 - count;
        if (index >= 0) tail[index] = { ...tail[index], eatenAt: performance.now() };
      }
      linesRef.current = [...grown, ...tail];
    }
  }, [edits]);

  // Draw loop: the whole file, the changes, and the travelling head.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext('2d');
    if (!context) return undefined;

    let frame = 0;
    let last = performance.now();

    const draw = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      if (active) headRef.current = (headRef.current + dt * HEAD_SPEED) % 1;

      const ratio = Math.min(2, window.devicePixelRatio || 1);
      const width = canvas.clientWidth;
      const height = canvas.clientHeight;
      if (width === 0 || height === 0) {
        frame = requestAnimationFrame(draw);
        return;
      }
      if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      // Mutate state while drawing: aging and eating are cheap here.
      const lines = linesRef.current
        .map((line): LineState | null => {
          if (line.eatenAt !== null) return now - line.eatenAt > EAT_MS ? null : line;
          return line.age < 1 ? { ...line, age: Math.min(1, line.age + dt / SETTLE_MS) } : line;
        })
        .filter((line): line is LineState => line !== null);
      linesRef.current = lines;

      const count = Math.max(1, lines.length);
      const step = height / count;
      const thickness = Math.max(1, Math.min(3, step * 0.72));

      const widths = widthsRef.current;
      for (let index = 0; index < lines.length; index++) {
        void widths;
        const line = lines[index];
        const y = index * step;
        const real = widthsRef.current?.[index];
        const factor = real === undefined ? widthFactor(index) : real;
        const lineWidth = Math.max(4, width * 0.06 + width * 0.9 * factor);

        if (line.eatenAt !== null) context.fillStyle = '#d00000';
        else if (line.age < 1) context.fillStyle = '#00a000';
        else context.fillStyle = '#111111';

        context.globalAlpha = line.eatenAt !== null ? 0.85 : 0.35 + 0.65 * line.age;
        context.fillRect(4, y, lineWidth - 4, thickness);
      }
      context.globalAlpha = 1;

      // The read head: a line across the file with a cursor at its left end.
      const headY = Math.round(headRef.current * height);
      context.fillStyle = '#0000ff';
      context.fillRect(0, headY, width, 2);
      context.fillRect(0, headY - 3, 6, 8);

      frame = requestAnimationFrame(draw);
    };

    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return (
    <div className={`code-stream ${active ? 'is-active' : ''}`} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
