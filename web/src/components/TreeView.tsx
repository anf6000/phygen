// The version tree. Children are centered under their parent, and the layout is
// recomputed whenever the node list changes, so a new generation appears under
// the version it came from.
import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
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
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { TreeEdge, TreeNode } from '../types';

const NODE_WIDTH = 260;
const NODE_HEIGHT = 300;
const COLUMN_GAP = 32;
const ROW_GAP = 110;
const PITCH = NODE_WIDTH + COLUMN_GAP;
const ROW_PITCH = NODE_HEIGHT + ROW_GAP;

/** The stages a candidate passes through, in order. */
export const STAGES = ['queued', 'authoring', 'validating', 'capturing', 'judging'] as const;
const TERMINAL = ['promoted', 'rejected', 'failed', 'paused'];

interface NodeData extends Record<string, unknown> {
  node: TreeNode;
  active: boolean;
  activeKind: string | null;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onPlay: (id: string) => void;
}

/**
 * Lay out the tree: a parent sits centered over its children, and the next free
 * column is given to each leaf. Loop-free, because a version has one parent.
 */
export function layoutTree(nodes: TreeNode[]): Map<string, { x: number; y: number }> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const children = new Map<string, TreeNode[]>();
  const roots: TreeNode[] = [];

  for (const node of nodes) {
    if (node.parentId && byId.has(node.parentId)) {
      const list = children.get(node.parentId) ?? [];
      list.push(node);
      children.set(node.parentId, list);
    } else {
      roots.push(node);
    }
  }
  const byAge = (a: TreeNode, b: TreeNode) => a.createdAt.localeCompare(b.createdAt);
  for (const list of children.values()) list.sort(byAge);
  roots.sort(byAge);

  const positions = new Map<string, { x: number; y: number }>();
  let nextLeaf = 0;

  const place = (node: TreeNode, depth: number, seen: Set<string>): number => {
    if (seen.has(node.id)) return nextLeaf * PITCH;
    seen.add(node.id);
    const kids = children.get(node.id) ?? [];
    let x: number;
    if (kids.length === 0) {
      x = nextLeaf * PITCH;
      nextLeaf += 1;
    } else {
      const centers = kids.map((kid) => place(kid, depth + 1, seen));
      x = (centers[0] + centers[centers.length - 1]) / 2;
    }
    positions.set(node.id, { x, y: depth * ROW_PITCH });
    return x;
  };

  for (const root of roots) place(root, 0, new Set());
  return positions;
}

function stageProgress(status: TreeNode['status']): { index: number; working: boolean } {
  const index = STAGES.indexOf(status as (typeof STAGES)[number]);
  return { index, working: index >= 0 };
}

const VersionNode = memo(
  function VersionNode({ data, selected }: NodeProps) {
    const { node, active, activeKind, onSelect, onOpen, onPlay } = data as unknown as NodeData;
    const { index, working } = stageProgress(node.status);
    const pending = working;
    const hasImage = !pending && node.status !== 'failed';
    const done = TERMINAL.includes(node.status);

    return (
      <div
        className={`vnode status-${node.status} ${selected ? 'is-selected' : ''} ${active ? 'is-active' : ''} ${
          node.onLineage ? 'on-lineage' : ''
        }`}
        tabIndex={0}
        role="button"
        aria-label={`${node.title}, generation ${node.generation}, status ${node.status}${active ? ', working now' : ''}`}
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
              <span className="vnode-placeholder-text">{activeKind ? kindLabel(activeKind) : pending ? stageLabel(node.status) : 'stopped'}</span>
            </div>
          )}
        </div>

        {/* A five-step leader: one cell per stage of the pipeline. */}
        <div className="vnode-steps" role="img" aria-label={`stage ${Math.max(index + 1, 0)} of ${STAGES.length}: ${node.status}`}>
          {STAGES.map((stage, at) => (
            <span
              key={stage}
              className={`vnode-step ${done ? 'is-done' : ''} ${working && at < index ? 'is-passed' : ''} ${
                working && at === index ? 'is-current' : ''
              }`}
              title={stage}
            />
          ))}
        </div>

        <div className="vnode-body">
          <span className="vnode-title">{node.title}</span>
          <span className="vnode-meta">
            gen {node.generation} · {node.status}
            {node.round ? ` · r${node.round}` : ''}
          </span>
        </div>
        <div className="vnode-actions">
          {active ? <span className="active-chip">working now</span> : null}
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
    const beforeData = previous.data as unknown as NodeData;
    const afterData = next.data as unknown as NodeData;
    return (
      previous.selected === next.selected &&
      beforeData.active === afterData.active &&
      beforeData.activeKind === afterData.activeKind &&
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

function stageLabel(status: TreeNode['status']): string {
  if (status === 'queued') return 'queued';
  if (status === 'authoring') return 'writing code';
  if (status === 'validating') return 'checking the package';
  if (status === 'capturing') return 'rendering frames';
  return 'judging';
}

function kindLabel(kind: string): string {
  if (kind === 'author') return 'writing code';
  if (kind === 'publish') return 'publishing the snapshot';
  if (kind === 'capture') return 'rendering frames';
  if (kind === 'judge') return 'judging';
  return kind;
}

const nodeTypes = { version: VersionNode } as unknown as NodeTypes;

export function TreeView({
  nodes,
  edges,
  selected,
  activeVersionIds,
  activeKinds,
  follow,
  onSelect,
  onOpen,
  onPlay,
}: {
  nodes: TreeNode[];
  edges: TreeEdge[];
  selected: string | null;
  activeVersionIds: string[];
  activeKinds: Record<string, string>;
  follow: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onPlay: (id: string) => void;
}) {
  const flow = useRef<ReactFlowInstance | null>(null);
  const activeKey = activeVersionIds.join(',');

  const positions = useMemo(() => layoutTree(nodes), [nodes]);
  const activeSet = useMemo(() => new Set(activeVersionIds), [activeVersionIds]);

  const flowNodes = useMemo<Node[]>(
    () =>
      nodes.map((node) => ({
        id: node.id,
        type: 'version',
        position: positions.get(node.id) ?? { x: 0, y: 0 },
        data: {
          node,
          active: activeSet.has(node.id),
          activeKind: activeKinds[node.id] ?? null,
          onSelect,
          onOpen,
          onPlay,
        } as NodeData,
        selected: node.id === selected,
        style: { width: NODE_WIDTH },
      })),
    [nodes, positions, selected, activeSet, activeKinds, onSelect, onOpen, onPlay],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'smoothstep',
        // The selected lineage is blue and solid: two cues, not colour alone.
        style: edge.onLineage
          ? { stroke: '#0000ff', strokeWidth: 1 }
          : { stroke: '#000000', strokeWidth: 1, strokeDasharray: '4 4' },
        animated: false,
      })),
    [edges],
  );

  // Keep the node that is being worked on in view.
  useEffect(() => {
    if (!follow || activeVersionIds.length === 0) return;
    const instance = flow.current;
    if (!instance) return;
    const first = positions.get(activeVersionIds[0]);
    if (!first) return;
    instance.setCenter(first.x + NODE_WIDTH / 2, first.y + NODE_HEIGHT / 2, {
      zoom: instance.getZoom(),
      duration: 300,
    });
  }, [activeKey, follow, activeVersionIds, positions]);

  const handleSelect = useCallback((id: string) => onSelect(id), [onSelect]);

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      onInit={(instance) => {
        flow.current = instance;
      }}
      onNodeClick={(_, node) => handleSelect(node.id)}
      fitView
      fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      minZoom={0.1}
      maxZoom={2}
      proOptions={{ hideAttribution: true }}
      nodesDraggable={false}
      nodesConnectable={false}
      elementsSelectable
    >
      <Background color="#d0d0d0" gap={24} />
      <Controls showInteractive={false} />
    </ReactFlow>
  );
}
