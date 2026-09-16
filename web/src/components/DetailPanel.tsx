import { useEffect, useState } from 'react';

import { RequestError, api } from '../api';
import type { TreeNode, VersionDetail } from '../types';

export function DetailPanel({
  version,
  onOpenViewer,
  onPlay,
  isParent,
  active,
}: {
  version: TreeNode | null;
  onOpenViewer: (id: string) => void;
  onPlay: (id: string) => void;
  isParent: boolean;
  active: boolean;
}) {
  const [detail, setDetail] = useState<VersionDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

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
