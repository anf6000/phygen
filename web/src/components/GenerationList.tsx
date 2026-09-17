import type { TreeNode } from '../types';
import { VersionThumb } from './VersionThumb';

/** The compact list the plan asks for on a narrow screen. */
export function GenerationList({
  nodes,
  selected,
  activeVersionIds,
  onSelect,
}: {
  nodes: TreeNode[];
  selected: string | null;
  activeVersionIds: string[];
  onSelect: (id: string) => void;
}) {
  const active = new Set(activeVersionIds);
  const ordered = [...nodes].sort((a, b) => b.generation - a.generation || a.createdAt.localeCompare(b.createdAt));
  return (
    <ol className="genlist">
      {ordered.map((node) => (
        <li key={node.id}>
          <button type="button" className={node.id === selected ? 'is-selected' : ''} onClick={() => onSelect(node.id)}>
            <VersionThumb url={node.thumbnailUrl} alt={`${node.title}, first captured frame`} />
            <span>
              <strong>{node.title}</strong>
              <span className="muted">
                gen {node.generation} · {node.status}
                {node.onLineage ? ' · lineage' : ''}
              </span>
              {active.has(node.id) ? <span className="active-chip">working now</span> : null}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
