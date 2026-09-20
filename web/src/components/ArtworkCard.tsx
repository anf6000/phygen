import type { TreeNode } from '../types';
import { LoadingArt } from './LoadingArt';

const STAGE_LABEL: Record<string, string> = {
  queued: 'queued',
  authoring: 'the agent writes code',
  validating: 'checking the package',
  capturing: 'rendering the frame',
  promoted: 'kept',
  failed: 'failed',
};

function changeLine(node: TreeNode): string {
  if (node.changes.length === 0) return 'no file change recorded';
  const names = node.changes.map((change) => change.path);
  const shown = names.slice(0, 3).join(', ');
  const more = names.length > 3 ? ` +${names.length - 3} more` : '';
  const lines = node.changes.reduce((totals, change) => ({ added: totals.added + change.added, removed: totals.removed + change.removed }), { added: 0, removed: 0 });
  return `${shown}${more}  +${lines.added} -${lines.removed}`;
}

export interface ArtworkCardProps {
  node: TreeNode;
  /** The card name, from the chain position. */
  label: string;
  /** The stage of the running job, when this version is being worked on. */
  stage: string | null;
  /** True for the single version that plays live. */
  playing: boolean;
  /** True while the large live view is open: the card must not play too. */
  livePaused: boolean;
  selected: boolean;
  onSelect: (versionId: string) => void;
  onOpen: (versionId: string) => void;
}

export function ArtworkCard({ node, label, stage, playing, livePaused, selected, onSelect, onOpen }: ArtworkCardProps) {
  const classes = ['card'];
  if (selected) classes.push('is-selected');
  if (playing) classes.push('is-playing');
  if (node.status === 'failed') classes.push('is-failed');

  // Two live players at once halve the frame rate of both. While the large view
  // is open, this card shows its still frame instead of a second live player.
  const live = playing && !livePaused;

  // A fallback title is just the step name, so do not show it twice.
  const title = /^Step \d+$/.test(node.title) ? null : node.title;

  return (
    <article
      className={classes.join(' ')}
      data-version={node.id}
      onClick={() => onSelect(node.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onSelect(node.id);
        }
      }}
      tabIndex={0}
      role="button"
      aria-label={`${label} ${node.title}`}    >
      <header className="card-head">
        <span className="card-step">{label}</span>
        {title ? <span className="card-title">{title}</span> : null}
        <span className={`card-status status-${node.status}`}>{STAGE_LABEL[node.status] ?? node.status}</span>
        {playing ? <span className="card-live-chip">{livePaused ? 'paused' : 'live'}</span> : null}
        {node.stub ? <span className="stub-chip">test double</span> : null}
      </header>

      <div className="card-media">
        {node.status === 'promoted' && live ? (
          <iframe src={node.liveUrl} title={`Live artwork ${node.title}`} sandbox="allow-scripts" referrerPolicy="no-referrer" />
        ) : node.stillUrl ? (
          /* A long chain holds many frames. Load a frame only when it comes
             near the viewport, so a chain of a hundred cards stays light. */
          <img src={node.stillUrl} alt={`${label} still frame`} loading="lazy" decoding="async" />
        ) : node.status === 'failed' ? (
          <div className="card-placeholder is-failed">
            <strong>{node.error?.code ?? 'failed'}</strong>
            <span>{node.error?.message ?? 'This step failed.'}</span>
          </div>
        ) : (
          <div className="card-placeholder is-pending">
            <LoadingArt label={STAGE_LABEL[stage ?? node.status] ?? stage ?? node.status} />
            <span className="card-stage-label">{STAGE_LABEL[stage ?? node.status] ?? stage ?? node.status}</span>
          </div>
        )}
      </div>

      <footer className="card-quiet">
        <span className="card-changes" title={changeLine(node)}>
          {changeLine(node)}
        </span>
        <span className="card-numbers">
          {node.tokens > 0 ? `${node.tokens.toLocaleString()} tokens` : 'no tokens yet'} · ${node.usageUsd.toFixed(4)} USD
        </span>
        {node.status === 'promoted' ? (
          <button
            type="button"
            className="card-open"
            onClick={(event) => {
              event.stopPropagation();
              onOpen(node.id);
            }}
          >
            Open live view
          </button>
        ) : null}
      </footer>
    </article>
  );
}
