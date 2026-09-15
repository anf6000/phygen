// The version tree. Generations run top to bottom. Positions come from the
// generation and the index inside that generation, so a progress update never
// moves a node that is already on screen.
import { memo, useCallback, useMemo } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge,
  type Node,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { TreeEdge, TreeNode } from '../types';

const NODE_WIDTH = 208;
const NODE_HEIGHT = 196;
const COLUMN_GAP = 28;
const ROW_GAP = 84;

/** Work that has not produced an image yet. */
const PENDING: TreeNode['status'][] = ['queued', 'authoring', 'validating', 'capturing', 'judging'];

interface NodeData extends Record<string, unknown> {
  node: TreeNode;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onPlay: (id: string) => void;
}

/** Re-render only when the fields the node shows actually change. */
const VersionNode = memo(
  function VersionNode({ data, selected }: NodeProps) {
    const { node, onSelect, onOpen, onPlay } = data as unknown as NodeData;
    const pending = PENDING.includes(node.status);
    const hasImage = !pending && node.status !== 'failed';

    return (
      <div
        className={`vnode status-${node.status} ${selected ? 'is-selected' : ''} ${node.onLineage ? 'on-lineage' : ''}`}
        tabIndex={0}
        role="button"
        aria-label={`${node.title}, generation ${node.generation}, status ${node.status}`}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            onSelect(node.id);
          }
        }}
        onClick={() => onSelect(node.id)}
      >
        <Handle type="target" position={Position.Top} />
        <div className="vnode-media">
          {hasImage ? (
            <img src={node.thumbnailUrl} alt={`${node.title}, first captured frame`} loading="lazy" />
          ) : (
            <div className={`vnode-placeholder ${pending ? 'is-pending' : 'is-failed'}`} role="img" aria-label={`${node.title}: ${node.status}`}>
              <span className="vnode-placeholder-mark" aria-hidden="true" />
              <span className="vnode-placeholder-text">{pending ? pendingLabel(node.status) : 'stopped'}</span>
            </div>
          )}
        </div>
        <div className="vnode-body">
          <span className="vnode-title">{node.title}</span>
          <span className="vnode-meta">
            gen {node.generation} · {node.status}
            {node.round ? ` · r${node.round}` : ''}
          </span>
        </div>
        <div className="vnode-actions">
          {node.onLineage ? <span className="lineage-chip">lineage</span> : null}
          {hasImage && (node.status === 'promoted' || node.status === 'rejected') ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onOpen(node.id);
              }}
            >
              Frames
            </button>
          ) : null}
          {hasImage ? (
            <button
              type="button"
              onClick={(event) => {
                event.stopPropagation();
                onPlay(node.id);
              }}
            >
              Play
            </button>
          ) : null}
        </div>
        <Handle type="source" position={Position.Bottom} />
      </div>
    );
  },
  (previous: NodeProps, next: NodeProps) => {
    const before = (previous.data as unknown as NodeData).node;
    const after = (next.data as unknown as NodeData).node;
    return (
      previous.selected === next.selected &&
      before.id === after.id &&
      before.title === after.title &&
      before.status === after.status &&
      before.thumbnailUrl === after.thumbnailUrl &&
      before.onLineage === after.onLineage &&
      before.generation === after.generation &&
      before.round === after.round
    );
  },
);

function pendingLabel(status: TreeNode['status']): string {
  if (status === 'queued') return 'queued';
  if (status === 'authoring') return 'writing code';
  if (status === 'validating') return 'checking the package';
  if (status === 'capturing') return 'rendering frames';
  return 'judging';
}

const nodeTypes = { version: VersionNode } as unknown as NodeTypes;

export function TreeView({
  nodes,
  edges,
  selected,
  onSelect,
  onOpen,
  onPlay,
}: {
  nodes: TreeNode[];
  edges: TreeEdge[];
  selected: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onPlay: (id: string) => void;
}) {
  const flowNodes = useMemo<Node[]>(() => {
    const perGeneration = new Map<number, number>();
    const ordered = [...nodes].sort((a, b) => a.generation - b.generation || a.createdAt.localeCompare(b.createdAt));
    return ordered.map((node) => {
      const index = perGeneration.get(node.generation) ?? 0;
      perGeneration.set(node.generation, index + 1);
      return {
        id: node.id,
        type: 'version',
        // top to bottom: the generation sets the row, the index sets the column
        position: { x: index * (NODE_WIDTH + COLUMN_GAP), y: node.generation * (NODE_HEIGHT + ROW_GAP) },
        data: { node, onSelect, onOpen, onPlay } as NodeData,
        selected: node.id === selected,
        style: { width: NODE_WIDTH },
      };
    });
  }, [nodes, selected, onSelect, onOpen, onPlay]);

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        // The selected lineage is thicker and solid: two cues, not colour alone.
        style: edge.onLineage
          ? { stroke: '#2f2a24', strokeWidth: 2.5 }
          : { stroke: '#c0b4a2', strokeWidth: 1, strokeDasharray: '5 4' },
        animated: false,
      })),
    [edges],
  );

  const handleSelect = useCallback((id: string) => onSelect(id), [onSelect]);

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onNodeClick={(_, node) => handleSelect(node.id)}
      fitView
      minZoom={0.15}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
    >
      <Background color="#e2d8c8" gap={24} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
