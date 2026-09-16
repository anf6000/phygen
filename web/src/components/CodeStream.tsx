// ─────────────────────────────────────────────────────────────────────────────
// CodeStream.tsx — the code as a column of literal lines, with the session
// reading through it.
//
// One line element per line of code and no text. A new line arrives green and
// settles to black. A line the session deletes turns red and disappears. A
// travelling head marks where the session is now. The input is the tool rows of
// one version: an `edit` row carries the added and removed line counts.
// ─────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useRef, useState } from 'react';

import type { AgentRow } from '../types';

const MAX_LINES = 46;
const MIN_WIDTH = 18;
const MAX_WIDTH = 92;
/** How long a deleted line stays visible before it goes. */
const EAT_MS = 280;
/** How long a new line takes to settle from green to black. */
const SETTLE_MS = 520;

interface CodeLine {
  id: number;
  /** 0 is fresh green, 1 is settled black. */
  age: number;
  width: number;
  /** Set when the head has taken the line. */
  eatenAt: number | null;
}

/** A stable width per line, so a line keeps its shape while it lives. */
function widthFor(id: number): number {
  const mixed = Math.sin(id * 12.9898) * 43758.5453;
  const unit = mixed - Math.floor(mixed);
  return MIN_WIDTH + Math.round(unit * (MAX_WIDTH - MIN_WIDTH));
}

export function CodeStream({ rows, active }: { rows: AgentRow[]; active: boolean }) {
  const edits = useMemo(
    () =>
      rows
        .filter((row) => row.kind === 'tool' && row.state === 'start' && ((row.added ?? 0) > 0 || (row.removed ?? 0) > 0))
        .map((row) => ({ seq: row.seq, added: row.added ?? 0, removed: row.removed ?? 0 })),
    [rows],
  );

  const [lines, setLines] = useState<CodeLine[]>([]);
  const [head, setHead] = useState(0);
  const handled = useRef(0);
  const nextId = useRef(1);

  // Each new edit becomes work for the column.
  useEffect(() => {
    const pending = edits.filter((edit) => edit.seq > handled.current);
    if (pending.length === 0) return;
    handled.current = pending[pending.length - 1].seq;
    setLines((current) => {
      const next = [...current];
      for (const edit of pending) {
        for (let count = 0; count < edit.added; count++) {
          const id = nextId.current++;
          next.push({ id, age: 0, width: widthFor(id), eatenAt: null });
        }
        for (let count = 0; count < edit.removed && count < next.length; count++) {
          const index = next.length - 1 - count;
          next[index] = { ...next[index], eatenAt: Date.now() };
        }
      }
      return next.slice(-MAX_LINES);
    });
  }, [edits]);

  // The loop: age the new lines, remove the eaten ones, move the head.
  useEffect(() => {
    if (!active && lines.length === 0) return undefined;
    let frame = 0;
    let last = performance.now();
    const step = 0.00032;

    const tick = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      setHead((current) => (current + dt * step) % 1);
      setLines((current) =>
        current
          .map((line) => {
            if (line.eatenAt !== null) return now - line.eatenAt > EAT_MS ? null : line;
            return line.age < 1 ? { ...line, age: Math.min(1, line.age + dt / SETTLE_MS) } : line;
          })
          .filter((line): line is CodeLine => line !== null),
      );
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [active, lines.length]);

  const slots = Math.max(lines.length + 2, 22);

  return (
    <div className={`code-stream ${active ? 'is-active' : ''}`} aria-hidden="true">
      <div className="code-lines">
        {lines.map((line, index) => (
          <span
            key={line.id}
            className={`code-line ${line.eatenAt !== null ? 'is-eaten' : line.age < 1 ? 'is-new' : ''}`}
            style={{
              width: `${line.width}%`,
              top: `${(index / slots) * 100}%`,
              height: `${Math.max(2, Math.round(76 / slots))}px`,
            }}
          />
        ))}
      </div>
      {/* The read head: a bar across the column with a cursor at its left end. */}
      <span className="code-head" style={{ top: `${head * 100}%` }}>
        <span className="code-cursor" />
      </span>
    </div>
  );
}
