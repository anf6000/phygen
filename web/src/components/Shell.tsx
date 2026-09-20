import { useEffect, useRef } from 'react';

import type { AgentRow } from '../types';

export interface ShellProps {
  rows: AgentRow[];
  /** What the shell is showing: one step, or the working step. */
  label: string;
  active: boolean;
}

function toolLine(row: AgentRow): string {
  const parts: string[] = [];
  if (row.state === 'start') {
    parts.push(row.tool ?? 'tool');
    if (row.path) parts.push(row.path);
    if (row.added || row.removed) parts.push(`+${row.added ?? 0} -${row.removed ?? 0}`);
    if (row.writes) parts.push(`${row.writes} write(s)`);
    if (row.edits) parts.push(`${row.edits} edit(s)`);
    return parts.join('  ');
  }
  return `${row.tool ?? 'tool'} ${row.ok === false ? 'FAILED' : 'ok'}`;
}

/**
 * The read-only log of one step: the agent reasoning, the agent text, and the
 * tool lines, newest at the bottom.
 */
export function Shell({ rows, label, active }: ShellProps) {
  const endRef = useRef<HTMLDivElement>(null);
  const count = rows.length;

  // Follow the work while a step writes.
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [count]);

  return (
    <section className="shell" aria-label="Agent log">
      <header className="shell-head">
        <span className="shell-label">{label}</span>
        <span className="shell-note muted">{active ? 'live' : 'stored'} · {count} row(s)</span>
      </header>
      <div className="shell-body">
        {count === 0 ? <p className="muted">No agent rows yet. Select a card to read its log.</p> : null}
        {rows.map((row, index) => (
          <p key={`${row.seq}-${index}`} className={`shell-row shell-${row.kind}`}>
            {row.kind === 'reason' ? (
              <>
                <span className="shell-tag">reasoning</span>
                <span className="shell-text">{row.text}</span>
              </>
            ) : row.kind === 'text' ? (
              <>
                <span className="shell-tag">agent</span>
                <span className="shell-text">{row.text}</span>
              </>
            ) : row.kind === 'tool' ? (
              <>
                <span className="shell-tag">tool</span>
                <span className="shell-tool-line">{toolLine(row)}</span>
              </>
            ) : (
              <>
                <span className="shell-tag">turn</span>
                <span className="shell-tool-line">
                  {row.tokens ? `${row.tokens.toLocaleString()} tokens` : 'turn ended'}
                  {row.costUsd ? ` · ${row.costUsd.toFixed(4)} USD` : ''}
                </span>
              </>
            )}
          </p>
        ))}
        <div ref={endRef} />
      </div>
    </section>
  );
}
