import type { TreeNode } from '../types';

/** The compact list the plan asks for on a narrow screen. */
export function GenerationList({
  nodes,
  selected,
  onSelect,
}: {
  nodes: TreeNode[];
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const ordered = [...nodes].sort((a, b) => b.generation - a.generation || a.createdAt.localeCompare(b.createdAt));
  return (
    <ol className="genlist">
      {ordered.map((node) => (
        <li key={node.id}>
          <button type="button" className={node.id === selected ? 'is-selected' : ''} onClick={() => onSelect(node.id)}>
            <img src={node.thumbnailUrl} alt={`${node.title}, first captured frame`} loading="lazy" />
            <span>
              <strong>{node.title}</strong>
              <span className="muted">
                gen {node.generation} · {node.status}
                {node.onLineage ? ' · lineage' : ''}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}
