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
  getSmoothStepPath,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import type { AgentRow, Decision, FileRow, TreeEdge, TreeNode } from '../types';
import { CodeStream } from './CodeStream';

const NODE_WIDTH = 260;
const NODE_HEIGHT = 300;
const COLUMN_GAP = 32;
const ROW_GAP = 110;
const PITCH = NODE_WIDTH + COLUMN_GAP;
/** Never show the tree smaller than this: below it a node is a speck. */
const MIN_READABLE_ZOOM = 0.35;
/** The greatest zoom the canvas allows. Documentation mode holds this. */
const MAX_ZOOM = 2;
const ROW_PITCH = NODE_HEIGHT + ROW_GAP;

/** The stages a candidate passes through, in order. */
export const STAGES = ['queued', 'authoring', 'validating', 'capturing', 'judging'] as const;
const TERMINAL = ['promoted', 'rejected', 'failed', 'paused'];

interface NodeData extends Record<string, unknown> {
  node: TreeNode;
  active: boolean;
  activeKind: string | null;
  liveFrame: { url: string; stage: string; step: number } | null;
  decision: Decision | null;
  rows: AgentRow[];
  files: FileRow[];
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
    const { node, active, activeKind, liveFrame, decision, rows, files, onSelect, onOpen, onPlay } = data as unknown as NodeData;
    const { index, working } = stageProgress(node.status);
    const pending = working;
    const hasImage = !pending && node.status !== 'failed';
    const done = TERMINAL.includes(node.status);
    // While a capture runs, the newest frame stands in for the thumbnail.
    // While the node works, the newest frame stands in for the thumbnail. A
    // finished node keeps its stored thumbnail.
    const liveUrl = liveFrame?.url ?? (pending ? node.latestCaptureUrl : null);
    const imageUrl = liveUrl ?? (hasImage ? node.thumbnailUrl : null);
    const frame = imageUrl
      ? {
          url: imageUrl,
          stage: liveFrame?.stage ?? node.latestCaptureStage ?? '',
          step: liveFrame?.step ?? node.latestCaptureStep ?? 0,
          live: liveUrl !== null,
        }
      : null;

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
        {active ? (
          <svg className="node-runner" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <rect x="1" y="1" width="98" height="98" pathLength={1} vectorEffect="non-scaling-stroke" />
          </svg>
        ) : null}
        <div className="vnode-media">
          {frame ? (
            <>
              <img src={frame.url} alt={`${node.title}, frame ${frame.stage} at step ${frame.step}`} loading="lazy" />
              <span className="live-chip">
                {frame.live ? `live · ${frame.stage} ${frame.step}` : `${frame.stage}${frame.step ? ` ${frame.step}` : ''}`}
              </span>
            </>
          ) : (
            <div
              className={`vnode-placeholder ${pending ? 'is-pending' : 'is-failed'}`}
              role="img"
              aria-label={`${node.title}: ${placeholderLabel(node, activeKind)}`}
              title={node.error?.message ?? placeholderLabel(node, activeKind)}
            >
              <CodeStream rows={rows} files={files} active={pending} />
              <span className="vnode-placeholder-text">{placeholderLabel(node, activeKind)}</span>
            </div>
          )}
          {node.status === 'judging' && frame ? <span className="judge-scan" /> : null}
          {decision ? (
            <div className={`decision decision-${decision.outcome}`} role="status" title={decision.reason ?? ''}>
              {decision.outcome === 'winner' ? 'WINNER!' : 'YEETED!'}
            </div>
          ) : null}
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
            gen {node.generation}
            {node.variant ? ` · v${node.variant}` : ''} · {node.status}
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
      before.evolution === after.evolution &&
      before.variant === after.variant &&
      beforeData.rows.length === afterData.rows.length &&
      beforeData.files.length === afterData.files.length
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

/**
 * What a tile without an image says. A failed version must name the failure,
 * because "stopped" hides the reason.
 */
function placeholderLabel(node: TreeNode, activeKind: string | null): string {
  if (activeKind) return kindLabel(activeKind);
  if (node.status === 'failed') return node.error?.code ? `failed · ${node.error.code}` : 'failed';
  if (node.status === 'paused') return 'paused';
  if (node.status === 'rejected') return 'rejected, no frame';
  if (node.status === 'promoted') return 'no frame captured';
  return stageLabel(node.status);
}

function kindLabel(kind: string): string {
  if (kind === 'author') return 'writing code';
  if (kind === 'publish') return 'publishing the snapshot';
  if (kind === 'capture') return 'rendering frames';
  if (kind === 'judge') return 'judging';
  return kind;
}

/** An edge that draws itself in: pathLength makes one dash value fit any path. */
function GrowEdge({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, data }: EdgeProps) {
  const [path] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition });
  const className = (data as { className?: string } | undefined)?.className ?? '';
  return <path d={path} pathLength={1} className={className} style={style} fill="none" />;
}

const nodeTypes = { version: VersionNode } as unknown as NodeTypes;
const edgeTypes = { grow: GrowEdge } as unknown as EdgeTypes;

export function TreeView({
  nodes,
  edges,
  selected,
  activeVersionIds,
  activeKinds,
  liveFrames,
  decisions,
  agentRows,
  fileRows,
  follow,
  docMode,
  onSelect,
  onOpen,
  onPlay,
}: {
  nodes: TreeNode[];
  edges: TreeEdge[];
  selected: string | null;
  activeVersionIds: string[];
  activeKinds: Record<string, string>;
  liveFrames: Record<string, { url: string; stage: string; step: number }>;
  decisions: Record<string, Decision>;
  agentRows: AgentRow[];
  fileRows: FileRow[];
  follow: boolean;
  /** Documentation mode: ride on the working version at the greatest zoom. */
  docMode: boolean;
  onSelect: (id: string) => void;
  onOpen: (id: string) => void;
  onPlay: (id: string) => void;
}) {
  const flow = useRef<ReactFlowInstance | null>(null);
  const activeKey = activeVersionIds.join(',');

  const positions = useMemo(() => layoutTree(nodes), [nodes]);
  // A stable object: a new one on every render makes React Flow re-fit and
  // fight the follow logic.
  const fitOptions = useMemo(() => ({ padding: 0.15, maxZoom: 1, minZoom: MIN_READABLE_ZOOM }), []);
  const activeSet = useMemo(() => new Set(activeVersionIds), [activeVersionIds]);
  const rowsByVersion = useMemo(() => {
    const grouped: Record<string, AgentRow[]> = {};
    for (const row of agentRows) {
      grouped[row.versionId] = grouped[row.versionId] ?? [];
      grouped[row.versionId].push(row);
    }
    return grouped;
  }, [agentRows]);
  const rowsOf = useCallback((id: string) => rowsByVersion[id] ?? [], [rowsByVersion]);
  const filesByVersion = useMemo(() => {
    const grouped: Record<string, FileRow[]> = {};
    for (const row of fileRows) {
      grouped[row.versionId] = grouped[row.versionId] ?? [];
      grouped[row.versionId].push(row);
    }
    return grouped;
  }, [fileRows]);
  const filesOf = useCallback((id: string) => filesByVersion[id] ?? [], [filesByVersion]);

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
          liveFrame: liveFrames[node.id] ?? null,
          decision: decisions[node.id] ?? null,
          rows: rowsOf(node.id),
          files: filesOf(node.id),
          onSelect,
          onOpen,
          onPlay,
        } as NodeData,
        selected: node.id === selected,
        style: { width: NODE_WIDTH },
      })),
    [nodes, positions, selected, activeSet, activeKinds, liveFrames, decisions, rowsOf, filesOf, onSelect, onOpen, onPlay],
  );

  const flowEdges = useMemo<Edge[]>(
    () =>
      edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        type: 'grow',
        // The selected lineage is blue and solid: two cues, not colour alone.
        // pathLength normalises the path, so one dash value draws any edge.
        data: { className: edge.onLineage ? 'edge-lineage' : 'edge-dashed' },
        style: edge.onLineage
          ? { stroke: '#000000', strokeWidth: 3, strokeDasharray: '1 0', strokeDashoffset: 1 }
          : { stroke: '#000000', strokeWidth: 1, strokeDasharray: '0.012 0.012', strokeDashoffset: 1 },
        animated: false,
      })),
    [edges],
  );

  /** The active version with its parent, its siblings, and its children. */
  const family = useMemo(() => {
    const target = activeVersionIds[0] ?? null;
    if (!target) return [];
    const node = nodes.find((entry) => entry.id === target);
    const ids = new Set<string>([target]);
    if (node?.parentId) ids.add(node.parentId);
    for (const other of nodes) {
      if (other.parentId === target) ids.add(other.id);
      if (node?.parentId && other.parentId === node.parentId) ids.add(other.id);
    }
    return [...ids];
  }, [nodes, activeVersionIds]);

  // Keep the version that is being worked on in view, together with the versions
  // around it, so following never hides the tree. Documentation mode instead
  // holds the greatest zoom, because the recording wants the work close up.
  const familyKey = useMemo(() => [...family].sort().join('|'), [family]);
  useEffect(() => {
    if (!follow) return;
    const instance = flow.current;
    if (!instance) return;
    const target = activeVersionIds[0] ?? (docMode ? selected : null);
    if (!target) return;

    if (!docMode) {
      const ids = family.length > 0 ? family : [target];
      instance.fitView({
        nodes: ids.map((id) => ({ id })),
        padding: 0.25,
        duration: 300,
        minZoom: 0.2,
        maxZoom: 1.1,
      });
      return;
    }

    const measured = instance.getNode(target) as
      | (ReturnType<ReactFlowInstance['getNode']> & { positionAbsolute?: { x: number; y: number }; width?: number; height?: number })
      | undefined;
    const absolute = measured?.positionAbsolute;
    if (!absolute) return;
    const x = absolute.x + (measured?.width ?? NODE_WIDTH) / 2;
    const y = absolute.y + (measured?.height ?? NODE_HEIGHT) / 2;
    instance.setCenter(x, y, { zoom: MAX_ZOOM, duration: 180 });
    // The keys, not the arrays: a poll that returns the same versions must not
    // move the view, or the tree and a person's own zoom fight each other.
  }, [activeKey, familyKey, follow, docMode, selected, activeVersionIds, family]);

  const handleSelect = useCallback((id: string) => onSelect(id), [onSelect]);

  return (
    <ReactFlow
      nodes={flowNodes}
      edges={flowEdges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      onInit={(instance) => {
        flow.current = instance;
      }}
      onNodeClick={(_, node) => handleSelect(node.id)}
      fitView
      fitViewOptions={fitOptions}
      minZoom={0.1}
      maxZoom={MAX_ZOOM}
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
