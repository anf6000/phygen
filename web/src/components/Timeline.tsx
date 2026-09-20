import { chainOrder, stepLabels } from '../chain';
import type { TreeNode } from '../types';
import { ArtworkCard } from './ArtworkCard';

export interface TimelineProps {
  nodes: TreeNode[];
  activeVersionIds: string[];
  activeKinds: Record<string, string>;
  playingId: string | null;
  /** True while the large live view is open, so no second live player runs. */
  livePaused: boolean;
  selected: string | null;
  onSelect: (versionId: string) => void;
  onOpen: (versionId: string) => void;
}

/**
 * The forward chain: one vertical column, newest at the top. Exactly one card
 * plays live; the others show their still frame.
 *
 * A failed step is NOT shown. The chain is the record of the work that was
 * kept, and a refusal is not a step of the artwork. The records stay, and
 * `tools/failed-steps.mjs` reports them.
 */
export function Timeline({ nodes, activeVersionIds, activeKinds, playingId, livePaused, selected, onSelect, onOpen }: TimelineProps) {
  const ordered = chainOrder(nodes).filter((node) => node.status !== 'failed');
  const active = new Set(activeVersionIds);
  const labels = stepLabels(ordered);

  return (
    <div className="timeline" aria-label="Evolution chain">
      {ordered.length === 0 ? <p className="timeline-empty">The chain is empty. Press Evolve to make the first step.</p> : null}
      {ordered.map((node) => (
        <ArtworkCard
          key={node.id}
          node={node}
          label={labels[node.id] ?? `Step ${node.generation}`}
          stage={active.has(node.id) ? activeKinds[node.id] ?? null : null}
          playing={node.id === playingId}
          livePaused={livePaused}
          selected={node.id === selected}
          onSelect={onSelect}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}
