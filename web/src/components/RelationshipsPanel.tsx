// The relationship panel: what two versions were measured to be, and why.
//
// This is a SECOND layer. It never changes a parent link, and it never draws a
// ring. Every statement here names the measure, the reason the pair was chosen,
// and how old the record is.
import { Fragment, useMemo, useState } from 'react';

import type { Measure, RelationshipsView, TreeNode } from '../types';
import { VersionThumb } from './VersionThumb';

/** The evidence keys worth a label. Anything else stays in the raw record. */
const EVIDENCE_LABELS: Record<string, string> = {
  changedCount: 'fields that differ',
  comparedKeys: 'fields compared',
  sharedShingles: 'shared shingles',
  unionShingles: 'shingles in either',
  aShingles: 'shingles in the first',
  bShingles: 'shingles in the second',
  aBytes: 'bytes in the first',
  bBytes: 'bytes in the second',
  group: 'chosen because',
  reused: 'reused from an earlier measurement',
  note: 'note',
};

const GROUP_LABELS: Record<string, string> = {
  lineage: 'one is the ancestor of the other',
  round: 'they competed in the same round',
  generation: 'they are one generation apart',
  slot: 'they hold the same role',
  sampled: 'a bounded sample of the rest',
};

function scoreText(score: number | null): string {
  return typeof score === 'number' ? score.toFixed(3) : '—';
}

function shortHash(value: string | null | undefined): string {
  return value ? value.slice(0, 12) : '—';
}

/** One evidence value, rendered as text. Never render an object as a child. */
function evidenceText(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(3);
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.length === 0 ? 'none' : `${value.length} item(s), see the raw record`;
  return 'see the raw record';
}

export function RelationshipsPanel({
  measures,
  measureId,
  onMeasure,
  view,
  loading,
  error,
  onRebuild,
  onCancel,
  threshold,
  onThreshold,
  hideAncestorPairs,
  onHideAncestorPairs,
  showLines,
  onShowLines,
  selectedPairKey,
  onSelectPair,
  nodes,
  onSelectVersion,
  onOpenVersion,
}: {
  measures: Measure[];
  measureId: string;
  onMeasure: (id: string) => void;
  view: RelationshipsView | null;
  loading: boolean;
  error: string | null;
  onRebuild: () => void;
  onCancel: () => void;
  threshold: number;
  onThreshold: (value: number) => void;
  hideAncestorPairs: boolean;
  onHideAncestorPairs: (value: boolean) => void;
  showLines: boolean;
  onShowLines: (value: boolean) => void;
  selectedPairKey: string | null;
  onSelectPair: (pairKey: string) => void;
  nodes: TreeNode[];
  onSelectVersion: (id: string) => void;
  onOpenVersion: (id: string) => void;
}) {
  const measure = measures.find((entry) => entry.id === measureId) ?? null;
  const [sort, setSort] = useState<'score-desc' | 'score-asc' | 'pair'>('score-desc');
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);

  const rows = useMemo(() => {
    const pairs = view?.pairs ?? [];
    const kept = pairs.filter((pair) => {
      if (hideAncestorPairs && pair.ancestor) return false;
      if (pair.outcome !== 'ok') return true;
      return (pair.score ?? 0) >= threshold;
    });
    const sorted = [...kept];
    if (sort === 'score-desc') sorted.sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
    if (sort === 'score-asc') sorted.sort((a, b) => (a.score ?? 2) - (b.score ?? 2));
    if (sort === 'pair') sorted.sort((a, b) => a.pairKey.localeCompare(b.pairKey));
    return sorted;
  }, [view, threshold, hideAncestorPairs, sort]);

  const selected = useMemo(() => (view?.pairs ?? []).find((pair) => pair.pairKey === selectedPairKey) ?? null, [view, selectedPairKey]);
  const running = view?.run ? ['queued', 'running'].includes(view.run.state) : false;

  const titleOf = (id: string) => byId.get(id)?.title ?? id;
  const thumbOf = (id: string) => byId.get(id)?.thumbnailUrl ?? null;
  const statusOf = (id: string) => byId.get(id)?.status ?? 'unknown';

  return (
    <div className="relationships">
      <section aria-label="Measure">
        <label className="rel-field">
          <span>Measure</span>
          <select value={measureId} onChange={(event) => onMeasure(event.target.value)} aria-label="Measure">
            {measures.map((entry) => (
              <option key={entry.id} value={entry.id} disabled={!entry.available}>
                {entry.label}
                {entry.available ? '' : ' (not enabled)'}
              </option>
            ))}
          </select>
        </label>
        {measure ? (
          <>
            <p className="muted">{measure.description}</p>
            <p className="rel-direction">{measure.direction}</p>
            <p className="muted">
              Method: {measure.method === 'deterministic' ? 'no model, no spend, repeatable' : 'a model call, which spends money'}
            </p>
            {!measure.available ? (
              <p className="alert" role="status">
                {measure.unavailableReason}
              </p>
            ) : null}
          </>
        ) : null}
      </section>

      <section aria-label="Measurement state">
        <div className="row">
          <button type="button" onClick={onRebuild} disabled={loading || running || !measure?.available}>
            {view?.run ? 'Measure again' : 'Measure'}
          </button>
          {running ? (
            <button type="button" onClick={onCancel}>
              Cancel
            </button>
          ) : null}
          <label className="rel-check">
            <input type="checkbox" checked={showLines} onChange={(event) => onShowLines(event.target.checked)} />
            Draw the relationship lines
          </label>
        </div>
        {error ? <p className="alert">{error}</p> : null}
        {view?.run ? (
          <dl className="rel-facts">
            <dt>State</dt>
            <dd>{view.run.state}</dd>
            <dt>Pairs</dt>
            <dd>
              {view.run.progress.done ?? 0} of {view.run.progress.total ?? 0} measured
              {typeof view.run.progress.reused === 'number' ? `, ${view.run.progress.reused} reused` : ''}
              {view.run.progress.failed ? `, ${view.run.progress.failed} failed` : ''}
            </dd>
            <dt>Record</dt>
            <dd title={view.currentRevision}>
              revision {shortHash(view.run.revision)} · started {view.run.startedAt ?? '—'}
            </dd>
            <dt>Freshness</dt>
            <dd>{view.stale ? (view.reason ?? 'Out of date.') : 'Up to date with the versions that exist now.'}</dd>
            {view.run.errorCode ? (
              <>
                <dt>Error</dt>
                <dd>
                  {view.run.errorCode}: {view.run.errorMessage}
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="muted">{view?.stale ? view.reason : 'This artwork has not been measured with this measure.'}</p>
        )}
        <p className="muted">
          {view?.run ? `${view.run.params.considered ?? 0} pair(s) exist in total. ` : ''}
          An individual-type comparison is not available: this layer measures pairs only.
        </p>
      </section>

      <section aria-label="Relationship filters">
        <label className="rel-field">
          <span>Only pairs at or above {threshold.toFixed(2)}</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={threshold}
            onChange={(event) => onThreshold(Number(event.target.value))}
            aria-label="Smallest score to show"
          />
        </label>
        <label className="rel-check">
          <input type="checkbox" checked={hideAncestorPairs} onChange={(event) => onHideAncestorPairs(event.target.checked)} />
          Hide the pairs where one is the ancestor of the other
        </label>
        <p className="muted">
          {rows.length} of {view?.pairs.length ?? 0} record(s) shown. The canvas draws the strongest 150 of them, and only
          where a card reads.
        </p>
        <p className="rel-legend">
          <span className="rel-key rel-key-ancestry" aria-hidden="true" /> ancestry: solid black, wider
          <span className="rel-key rel-key-measure" aria-hidden="true" /> a measured relationship: solid purple, thinner
        </p>
      </section>

      <section aria-label="Pairs">
        <table className="rel-table">
          <caption className="muted">Measured pairs, highest score first unless you sort otherwise</caption>
          <thead>
            <tr>
              <th scope="col">Pair</th>
              <th scope="col">
                <button type="button" onClick={() => setSort(sort === 'score-desc' ? 'score-asc' : 'score-desc')}>
                  Score {sort === 'score-desc' ? '▼' : sort === 'score-asc' ? '▲' : ''}
                </button>
              </th>
              <th scope="col">Band</th>
              <th scope="col">Chosen because</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 60).map((pair) => (
              <tr key={pair.id} className={pair.pairKey === selectedPairKey ? 'is-selected' : ''}>
                <td>
                  <button
                    type="button"
                    className="rel-pair-button"
                    onClick={() => onSelectPair(pair.pairKey)}
                    aria-pressed={pair.pairKey === selectedPairKey}
                  >
                    <VersionThumb url={thumbOf(pair.a)} alt={`${titleOf(pair.a)} thumbnail`} className="rel-thumb" />
                    <VersionThumb url={thumbOf(pair.b)} alt={`${titleOf(pair.b)} thumbnail`} className="rel-thumb" />                    <span>
                      {titleOf(pair.a)} ↔ {titleOf(pair.b)}
                      {pair.ancestor ? ' (ancestry)' : ''}
                    </span>
                  </button>
                </td>
                <td>{pair.outcome === 'ok' ? scoreText(pair.score) : 'error'}</td>
                <td>{pair.band ?? '—'}</td>
                <td>{GROUP_LABELS[pair.group ?? ''] ?? pair.group ?? '—'}</td>
              </tr>
            ))}
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="muted">
                  No pair passes the filter.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {rows.length > 60 ? <p className="muted">Showing the first 60 rows.</p> : null}
      </section>

      {selected ? (
        <section aria-label="Pair detail" className="rel-inspector">
          <h3>Pair</h3>
          <div className="rel-compare">
            {[selected.a, selected.b].map((id) => (
              <figure key={id}>
                <VersionThumb url={thumbOf(id)} alt={`${titleOf(id)}, newest frame`} className="rel-thumb-large" />
                <figcaption>
                  {titleOf(id)} · {statusOf(id)}
                  <br />
                  <button type="button" onClick={() => onSelectVersion(id)}>
                    Select in the tree
                  </button>{' '}
                  <button type="button" onClick={() => onOpenVersion(id)}>
                    Frames
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
          <dl className="rel-facts">
            <dt>Score</dt>
            <dd>
              {scoreText(selected.score)} ({selected.band ?? 'unknown'})
            </dd>
            <dt>Measured with</dt>
            <dd>{view?.measure.label ?? selected.measure}</dd>
            <dt>Chosen because</dt>
            <dd>{GROUP_LABELS[selected.group ?? ''] ?? selected.group ?? '—'}</dd>
            <dt>Ancestry</dt>
            <dd>{selected.ancestor ? 'One version is the ancestor of the other.' : 'Neither version is the ancestor of the other.'}</dd>
            {Object.entries(selected.evidence)
              .filter(([key]) => key !== 'group')
              .slice(0, 8)
              .map(([key, value]) => (
                <Fragment key={key}>
                  <dt>{EVIDENCE_LABELS[key] ?? key}</dt>
                  <dd>{evidenceText(value)}</dd>
                </Fragment>
              ))}
          </dl>
          {selected.error ? (
            <p className="alert">
              {selected.error.code}: {selected.error.message}
            </p>
          ) : null}
          <details>
            <summary>Raw record</summary>
            <pre>{JSON.stringify(selected, null, 2)}</pre>
          </details>
        </section>
      ) : (
        <p className="muted">Select a pair to see the two versions, the score, and the evidence.</p>
      )}
    </div>
  );
}
