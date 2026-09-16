import { useEffect, useState } from 'react';

import { RequestError, api } from '../api';
import type { AgentRow, TreeNode, VersionDetail } from '../types';

export function DetailPanel({
  version,
  onOpenViewer,
  onPlay,
  isParent,
  agentRows,
  agentFor,
  agentActive,
  active,
}: {
  version: TreeNode | null;
  onOpenViewer: (id: string) => void;
  onPlay: (id: string) => void;
  isParent: boolean;
  agentRows: AgentRow[];
  /** The version the feed belongs to, when it is not the selected one. */
  agentFor: string | null;
  agentActive: boolean;
  active: boolean;
}) {
  const [detail, setDetail] = useState<VersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<AgentRow[]>([]);

  // The stored feed of the selected version, so an older version still shows
  // how it was made.
  useEffect(() => {
    if (!version) {
      setHistory([]);
      return undefined;
    }
    let cancelled = false;
    api
      .agentFeed(version.id)
      .then((result) => {
        if (!cancelled) setHistory(result.rows);
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [version]);

  useEffect(() => {
    if (!version) {
      setDetail(null);
      return undefined;
    }
    let cancelled = false;
    const load = () => {
      api
        .version(version.id)
        .then((next) => {
          if (!cancelled) {
            setDetail(next);
            setError(null);
          }
        })
        .catch((cause) => {
          if (!cancelled) setError(cause instanceof RequestError ? `${cause.code}: ${cause.message}` : String(cause));
        });
    };
    load();
    const timer = window.setInterval(load, active ? 4000 : 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [version, active]);

  if (!version) return <p className="muted">Select a version in the tree.</p>;

  // The stored rows and the live rows together: the newest sequence wins.
  const feed = (() => {
    const bySeq = new Map<number, AgentRow>();
    for (const row of history) bySeq.set(row.seq, row);
    for (const row of agentRows) bySeq.set(row.seq, row);
    return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
  })();

  // The feed: one row per tool call, and a running total of the change.
  const toolRows = feed.filter((row) => row.kind === 'tool' && row.state === 'start');
  const turns = feed.filter((row) => row.kind === 'turn');
  const totals = toolRows.reduce(
    (sum, row) => ({
      added: sum.added + (row.added ?? 0),
      removed: sum.removed + (row.removed ?? 0),
      edits: sum.edits + (row.edits ?? 0),
      writes: sum.writes + (row.writes ?? 0),
    }),
    { added: 0, removed: 0, edits: 0, writes: 0 },
  );
  const tokens = turns.reduce((sum, row) => sum + (row.tokens ?? 0), 0);
  const lastText = feed.filter((row) => row.kind === 'text').slice(-1)[0]?.text ?? '';
  const peak = Math.max(1, ...toolRows.slice(-24).map((row) => (row.added ?? 0) + (row.removed ?? 0)));

  return (
    <div className="detail">
      <header>
        <h2>{version.title}</h2>
        <p className="muted">
          generation {version.generation} · {version.status}
          {version.evolution ? ` · evolution ${version.evolution}` : ''}
          {version.variant ? ` · variant ${version.variant}` : ''}
          {version.slot ? ` · ${version.slot}` : ''}
        </p>
        <p className="hash" title={version.sourceHash}>
          source {version.sourceHash.slice(0, 16)}…
        </p>
        <div className="row">
          {isParent ? <span className="parent-chip">variants spawn here</span> : null}
          <button type="button" onClick={() => onOpenViewer(version.id)}>
            Open frames
          </button>
          <button type="button" onClick={() => onPlay(version.id)}>
            Play live
          </button>
        </div>
        {version.status === 'failed' && version.error ? (
          <div className="alert" role="alert">
            <strong>{version.error.code}</strong> {version.error.message}
          </div>
        ) : null}
      </header>

      {error ? <p className="alert">{error}</p> : null}
      {!detail ? <p className="muted">Loading the record…</p> : null}

      {detail ? (
        <>
          {detail.explanation ? (
            <section>
              <h3>Author explanation</h3>
              <p className="explanation">{detail.explanation}</p>
            </section>
          ) : null}

          <section className="agent">
            <h3>
              Agent at work
              {agentActive ? <span className="active-chip">live session</span> : null}
            </h3>
            {agentFor ? <p className="muted">working on: {agentFor}</p> : null}
            {toolRows.length === 0 && turns.length === 0 ? (
              <p className="muted">No session activity yet for this version.</p>
            ) : (
              <>
                <p className="agent-totals">
                  <span className="diff-add">+{totals.added}</span> <span className="diff-del">−{totals.removed}</span>
                  <span className="muted">
                    {' '}
                    · {totals.edits} edit(s) · {totals.writes} write(s) · {turns.length} turn(s)
                    {tokens > 0 ? ` · ${tokens} tokens` : ''}
                  </span>
                </p>
                {/* One bar per tool call: the size of the change it made. */}
                <div className="agent-bars" aria-hidden="true">
                  {toolRows.slice(-24).map((row) => (
                    <span
                      key={`bar-${row.seq}`}
                      className={`agent-bar ${row.tool === 'write' ? 'is-write' : ''}`}
                      style={{ height: `${Math.max(6, Math.round((((row.added ?? 0) + (row.removed ?? 0)) / peak) * 48))}px` }}
                    />
                  ))}
                </div>
                <ol className="agent-feed">
                  {toolRows
                    .slice(-40)
                    .reverse()
                    .map((row) => (
                      <li key={`row-${row.seq}`}>
                        <code>{row.tool}</code> <span className="agent-path">{row.path ?? ''}</span>
                        {(row.added ?? 0) > 0 || (row.removed ?? 0) > 0 ? (
                          <span className="agent-delta">
                            <span className="diff-add">+{row.added ?? 0}</span> <span className="diff-del">−{row.removed ?? 0}</span>
                          </span>
                        ) : null}
                      </li>
                    ))}
                </ol>
                {lastText ? <p className="agent-text">{lastText}</p> : null}
              </>
            )}
          </section>

          <section>
            <h3>Source changes</h3>
            {detail.changes.length === 0 ? (
              <p className="muted">This version changed no file.</p>
            ) : (
              <ul className="changes">
                {detail.changes.map((change) => (
                  <li key={change.path}>
                    <code>{change.path}</code> <span className="muted">{change.status}</span>
                    <span className="diff">
                      +{change.added} −{change.removed}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section>
            <h3>Configuration</h3>
            <dl className="config">
              {Object.entries(detail.configuration).map(([key, value]) => (
                <div key={key}>
                  <dt>{key}</dt>
                  <dd>{typeof value === 'number' ? compact(value) : String(value)}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section>
            <h3>Visual evidence ({detail.captures.length})</h3>
            {detail.captures.length === 0 ? (
              <p className="muted">No frame was captured for this version.</p>
            ) : (
              <ul className="shots">
                {detail.captures.map((capture) => (
                  <li key={capture.id}>
                    <img src={capture.url} alt={`${capture.stage} frame at step ${capture.step}, seed ${capture.seed}`} loading="lazy" />
                    <span className="muted">
                      {capture.stage} · step {capture.step} · seed {capture.seed}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {detail.captures[0] ? (
              <p className="muted">
                renderer {detail.captures[0].rendererBackend ?? 'unknown'} · timestep {detail.captures[0].timestep ?? '—'} steps per frame
              </p>
            ) : null}
          </section>

          <section>
            <h3>Judgments</h3>
            {detail.evaluations.length === 0 ? (
              <p className="muted">This version has no comparison yet.</p>
            ) : (
              detail.evaluations.map((comparison) => (
                <article key={comparison.id} className="comparison">
                  <p>
                    <strong>{comparison.kind}</strong> · evolution {comparison.round} · {comparison.model ?? 'unknown model'}
                    {comparison.stub ? ' (test double — not a judgment)' : ''}
                  </p>
                  <p className="muted">
                    winner {comparison.winnerVersionId === version.id ? 'this version' : comparison.winnerVersionId ?? 'none'} ·{' '}
                    confidence {comparison.confidence?.toFixed(2) ?? '—'} · uncertainty {comparison.uncertainty ?? '—'}
                  </p>
                  <ul className="observations">
                    {comparison.observations.slice(0, 6).map((observation, index) => (
                      <li key={`${comparison.id}-${index}`}>
                        <strong>{observation.label}</strong> <span className="muted">{observation.frame}</span> {observation.detail}
                      </li>
                    ))}
                  </ul>
                  {comparison.weaknesses.length > 0 ? (
                    <p className="muted">Weaknesses: {comparison.weaknesses.join('; ')}</p>
                  ) : null}
                </article>
              ))
            )}
          </section>

          <section>
            <h3>Usage</h3>
            {detail.usage.length === 0 ? (
              <p className="muted">No provider request was recorded for this version.</p>
            ) : (
              <ul className="usage">
                {detail.usage.map((entry) => (
                  <li key={entry.id}>
                    {entry.kind} · {entry.model} · {entry.inputTokens}+{entry.outputTokens} tokens · {entry.costUsd.toFixed(4)} USD
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}

function compact(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}
