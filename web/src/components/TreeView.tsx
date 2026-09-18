// The version tree, drawn as generation rings.
//
// The original artwork root sits at the graph origin. Each generation is one
// ring further out, and a lineage that does not divide stays on one ray. The
// ring number is the calculated distance from the canonical root, so a stored
// generation field can never move a card.
//
// Rings are ancestry. They are NOT a measured relationship between two
// artworks; that is a separate layer with its own module and its own draws.
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  useInternalNode,
  type Edge,
  type EdgeProps,
  type EdgeTypes,
  type Node,
  type NodeProps,
  type NodeTypes,
  type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

import { boundaryPoint, layoutKey, layoutRings, type RadialNode } from '../layout/radial';
import type { AgentRow, Decision, FileRow, TreeEdge, TreeNode } from '../types';
import { CodeStream } from './CodeStream';
import { VersionThumb } from './VersionThumb';

const NODE_WIDTH = 260;
const NODE_HEIGHT = 300;
/** Free space between two cards that must not touch. The packing grows a ring or
 *  a block until every pair of cards clears this, so the number is a promise. */
const CARD_GAP = 12;
/** The greatest zoom the canvas allows. Documentation mode holds this. */
const MAX_ZOOM = 2;
/**
 * The smallest zoom the canvas allows, and the floor for Fit All.
 *
 * A card is 260 graph units wide, so this floor keeps it about 42 pixels wide:
 * a target a person can actually hit. Fit All fits as much of the artwork as
 * that floor allows and the rest is reached by panning. An overview where every
 * card is a 15-pixel speck is not a usable interface, however much of the
 * artwork it shows at once.
 */
const MIN_OVERVIEW_ZOOM = 0.16;
/** The smallest zoom that still reads as a card. Focus never goes below it. */
const MIN_READABLE_ZOOM = 0.35;
/** The greatest number of measured lines drawn at once. */
const MAX_RELATIONSHIP_DRAWS = 150;

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

interface DiagnosticData extends Record<string, unknown> {
  id: string;
  label: string;
  reason: string;
}

/** One measured pair to draw. A score is a distance: a high score is a wider draw. */
export interface RelationshipDraw {
  id: string;
  source: string;
  target: string;
  pairKey: string;
  score: number;
  band: string | null;
  group: string | null;
  ancestor: boolean;
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
    // While a node works, the newest frame stands in for the thumbnail. A
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
        {/* The edges attach to the card boundary, so the handles carry no mark. */}
        <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
        {active ? (
          <svg className="node-runner" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <rect x="1" y="1" width="98" height="98" pathLength={1} vectorEffect="non-scaling-stroke" />
          </svg>
        ) : null}
        <div className="vnode-media">
          {frame ? (
            <>
              <VersionThumb url={frame.url} alt={`${node.title}, frame ${frame.stage} at step ${frame.step}`} />
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
          {node.stub ? (
            <span className="stub-chip" title="The run that made this version used the deterministic test double. It is not real work and its verdicts are not evidence.">
              test double
            </span>
          ) : null}
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
        <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
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

/**
 * A record with no valid ancestry. It is never given a ring, an angle, or an
 * invented parent; the card states why it is here.
 */
const DiagnosticNode = memo(function DiagnosticNode({ data }: NodeProps) {
  const { label, reason } = data as unknown as DiagnosticData;
  return (
    <div className="vnode vnode-diagnostic" role="note" aria-label={`${label}: ${reason}`}>
      <Handle type="target" position={Position.Top} style={{ opacity: 0 }} />
      <div className="vnode-placeholder is-failed">
        <span className="vnode-placeholder-text">{reason}</span>
      </div>
      <div className="vnode-body">
        <span className="vnode-title">{label}</span>
        <span className="vnode-meta">not reachable from the root</span>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ opacity: 0 }} />
    </div>
  );
});

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

function centerOf(node: ReturnType<typeof useInternalNode>) {
  if (!node) return null;
  const position = (node as { internals?: { positionAbsolute?: { x: number; y: number } } }).internals?.positionAbsolute;
  if (!position) return null;
  const width = (node as { measured?: { width?: number } }).measured?.width ?? NODE_WIDTH;
  const height = (node as { measured?: { height?: number } }).measured?.height ?? NODE_HEIGHT;
  return { x: position.x + width / 2, y: position.y + height / 2, width, height };
}

/**
 * An ancestry edge. It leaves the source card where the line to the target card
 * crosses the card boundary, so the draw follows the ring instead of a fixed
 * top-to-bottom side that a radial layout does not have.
 */
function RadialEdge({ source, target, sourceX, sourceY, targetX, targetY, style, data }: EdgeProps) {
  const settings = (data ?? {}) as { className?: string; curve?: boolean };
  const className = settings.className ?? '';
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);
  const from = centerOf(sourceNode);
  const to = centerOf(targetNode);

  let start = { x: sourceX, y: sourceY };
  let end = { x: targetX, y: targetY };
  if (from && to) {
    start = boundaryPoint(from, to, from.width, from.height);
    end = boundaryPoint(to, from, to.width, to.height);
  }

  // An ancestry line is a straight spoke: it says "this card hangs from that
  // one", and a curve would blur that. A measured relationship joins two cards
  // that can sit anywhere, so it is drawn as a bow that bends away from the
  // middle of the artwork. The bow keeps crossing lines apart and reads as a
  // flowing mesh instead of a knot of chords.
  if (!settings.curve) {
    return <path d={`M ${start.x} ${start.y} L ${end.x} ${end.y}`} pathLength={1} className={className} style={style} fill="none" />;
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (length < 1e-6) {
    return <path d={`M ${start.x} ${start.y}`} pathLength={1} className={className} style={style} fill="none" />;
  }
  // The perpendicular, on the side that leads away from the graph origin.
  const normalX = -dy / length;
  const normalY = dx / length;
  const midX = (start.x + end.x) / 2;
  const midY = (start.y + end.y) / 2;
  const away = midX * normalX + midY * normalY >= 0 ? 1 : -1;
  const bow = length * 0.16 * away;
  const control1 = { x: start.x + dx * 0.25 + normalX * bow, y: start.y + dy * 0.25 + normalY * bow };
  const control2 = { x: start.x + dx * 0.75 + normalX * bow, y: start.y + dy * 0.75 + normalY * bow };
  const path = `M ${start.x} ${start.y} C ${control1.x} ${control1.y} ${control2.x} ${control2.y} ${end.x} ${end.y}`;
  return (
    // A stroke is measured in graph units, so it shrinks to a hairline as the
    // canvas zooms out. The measured layer keeps its width on SCREEN, which is
    // what makes it readable at the widest zoom.
    <path d={path} pathLength={1} className={className} style={style} fill="none" vectorEffect="non-scaling-stroke" />
  );
}

const nodeTypes = { version: VersionNode, diagnostic: DiagnosticNode } as unknown as NodeTypes;
const edgeTypes = { radial: RadialEdge } as unknown as EdgeTypes;

export function TreeView({
  nodes,
  allNodes,
  rootId,
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
  relationships,
  onSelect,
  onOpen,
  onPlay,
}: {
  /** The records the filter keeps: what is drawn. */
  nodes: TreeNode[];
  /** Every record of the artwork: what the rings are calculated from. */
  allNodes: TreeNode[];
  /** The canonical root of the artwork, from the artwork record. */
  rootId: string | null;
  edges: TreeEdge[];
  /** Measured relationships to draw on top of the ancestry. Never ancestry. */
  relationships?: RelationshipDraw[];
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
  // A person's own pan or zoom wins until they ask for Focus again.
  const userMoved = useRef(false);
  const [showDiagnostics, setShowDiagnostics] = useState(true);

  // The layout follows TOPOLOGY and card size only. A status change, a new
  // capture, or a selection never moves a card.
  const topology = useMemo<RadialNode[]>(
    () => allNodes.map((node) => ({ id: node.id, parentId: node.parentId, generation: node.generation, createdAt: node.createdAt })),
    [allNodes],
  );
  const key = layoutKey(topology, rootId, NODE_WIDTH, NODE_HEIGHT);
  const layout = useMemo(
    () => layoutRings(topology, { rootId, cardWidth: NODE_WIDTH, cardHeight: NODE_HEIGHT, cardGap: CARD_GAP }),
    // The key is the whole input: topology, root and card size.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  const fitOptions = useMemo(() => ({ padding: 0.15, maxZoom: 1 }), []);
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

  // Hidden records keep the position they had. A filter changes what is drawn,
  // never where the remaining cards are.
  const flowNodes = useMemo<Node[]>(() => {
    // A record the layout could not place, such as one whose parent is missing,
    // belongs to the diagnostic column. Drawing it a second time at the graph
    // origin would stack it on the root, where it hides behind the root card and
    // looks like it vanished.
    const diagnosticIds = new Set(layout.diagnostics.map((entry) => entry.id));
    // A record the layout could not place is put in a spare column of its own,
    // never at the graph origin: at the origin it would sit under the root card
    // and look like it had vanished.
    const columnX = Math.min(...[...layout.positions.values()].map((point) => point.x), ...[...layout.diagnosticPositions.values()].map((point) => point.x), 0) - NODE_WIDTH;
    const stackY = Math.min(...[...layout.diagnosticPositions.values()].map((point) => point.y), 0);
    let spare = 0;
    const drawn: Node[] = nodes
      .filter((node) => !diagnosticIds.has(node.id))
      .map((node) => {
        const position = layout.positions.get(node.id);
        const fallback = { x: columnX, y: stackY - NODE_HEIGHT * (spare + 1) };
        if (!position) spare += 1;
        return {
          id: node.id,
          type: 'version',
          position: position ?? fallback,
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
        };
      });
    if (showDiagnostics) {
      for (const diagnostic of layout.diagnostics) {
        const node = allNodes.find((entry) => entry.id === diagnostic.id);
        if (!node) continue;
        drawn.push({
          id: node.id,
          type: 'diagnostic',
          position: layout.diagnosticPositions.get(node.id) ?? { x: 0, y: 0 },
          data: { id: node.id, label: node.title, reason: diagnostic.reason } as DiagnosticData,
          selected: node.id === selected,
          style: { width: NODE_WIDTH },
        });
      }
    }
    return drawn;
  }, [nodes, allNodes, layout, selected, activeSet, activeKinds, liveFrames, decisions, rowsOf, filesOf, onSelect, onOpen, onPlay, showDiagnostics]);

  const visibleIds = useMemo(() => new Set(flowNodes.map((node) => node.id)), [flowNodes]);
  const flowEdges = useMemo<Edge[]>(
    () =>
      edges
        // A hidden card must not leave a dangling draw behind.
        .filter((edge) => visibleIds.has(edge.source) && visibleIds.has(edge.target))
        .map((edge) => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          type: 'radial',
          // Solid, and thicker on the selected lineage: two cues, not colour alone.
          data: { className: edge.onLineage ? 'edge-lineage' : 'edge-dashed' },
          style: edge.onLineage
            ? { stroke: '#000000', strokeWidth: 3, strokeDasharray: '1 0', strokeDashoffset: 1 }
            : { stroke: '#000000', strokeWidth: 1.4, strokeDasharray: '1 0', strokeDashoffset: 1 },
          animated: false,
        })),
    [edges, visibleIds],
  );

  /**
   * The secondary draw layer: measured relationships, not ancestry. They are
   * thinner and purple against the wider black ancestry, so the two layers are
   * never told apart by colour alone. The width follows the score.
   */
  const measuredEdges = useMemo<Edge[]>(
    () =>
      (relationships ?? [])
        .filter((draw) => visibleIds.has(draw.source) && visibleIds.has(draw.target))
        .slice()
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RELATIONSHIP_DRAWS)
        .map((draw) => ({
          id: draw.id,
          source: draw.source,
          target: draw.target,
          type: 'radial',
          selectable: true,
          // A bow, not a chord: this layer joins cards that can sit anywhere.
          data: { className: 'edge-measured', curve: true },
          style: {
            stroke: '#7a5cc6',
            strokeWidth: 1.1 + Math.min(1.3, Math.abs(draw.score)),
            strokeDasharray: '1 0',
            strokeDashoffset: 0,
            opacity: 0.9,
          },
          animated: false,
        })),
    [relationships, visibleIds],
  );

  // Every measured relationship is drawn at every zoom, the overview included.
  // The layer has its own toggle, so hiding it stays one click away.
  const drawnEdges = useMemo(() => [...flowEdges, ...measuredEdges], [flowEdges, measuredEdges]);
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

  const focus = useCallback(
    (ids: string[], { readable }: { readable: boolean }) => {
      const instance = flow.current;
      if (!instance || ids.length === 0) return;
      instance.fitView({
        nodes: ids.map((id) => ({ id })),
        padding: 0.25,
        duration: 300,
        minZoom: readable ? MIN_READABLE_ZOOM : MIN_OVERVIEW_ZOOM,
        maxZoom: 1.1,
      });
    },
    [],
  );

  /** Fit every ring, however far out it reaches. */
  const fitAll = useCallback(() => {
    userMoved.current = false;
    flow.current?.fitView({ padding: 0.15, duration: 300, minZoom: MIN_OVERVIEW_ZOOM, maxZoom: 1 });
  }, []);

  /** Focus the selected version at a zoom that reads. */
  const focusSelection = useCallback(() => {
    userMoved.current = false;
    focus([selected ?? rootId ?? ''].filter(Boolean), { readable: true });
  }, [focus, selected, rootId]);

  // Keep the version that is being worked on in view, together with the
  // versions around it. A pan or zoom that a person made wins until Focus.
  const familyKey = useMemo(() => [...family].sort().join('|'), [family]);
  useEffect(() => {
    if (!follow || docMode || userMoved.current) return;
    const instance = flow.current;
    if (!instance) return;
    const target = activeVersionIds[0] ?? null;
    if (!target) return;
    const ids = family.length > 0 ? family : [target];
    instance.fitView({ nodes: ids.map((id) => ({ id })), padding: 0.25, duration: 300, minZoom: MIN_OVERVIEW_ZOOM, maxZoom: 1.1 });
    // The keys, not the arrays: a poll that returns the same versions must not
    // move the view, or the tree and a person's own zoom fight each other.
  }, [activeKey, familyKey, follow, docMode, activeVersionIds, family]);

  useEffect(() => {
    if (!docMode) return;
    const instance = flow.current;
    if (!instance) return;
    const target = activeVersionIds[0] ?? selected;
    if (!target) return;
    // Documentation mode must show the work IN CONTEXT. Centring the one working
    // card at the greatest zoom loses the tree: a viewer of the recording sees a
    // single card and then an empty canvas as the camera moves, which reads as
    // the nodes disappearing. Frame the working version together with the
    // versions around it, at a zoom that keeps a card readable.
    const ids = family.length > 0 ? family : [target];
    instance.fitView({
      nodes: ids.map((id) => ({ id })),
      padding: 0.3,
      duration: 200,
      minZoom: MIN_READABLE_ZOOM,
      maxZoom: 1,
    });
  }, [activeKey, familyKey, docMode, selected, activeVersionIds, family]);

  const handleSelect = useCallback((id: string) => onSelect(id), [onSelect]);
  const mismatches = layout.generationMismatch.length;
  const diagnostics = layout.diagnostics.length;

  return (
    <div className="tree-wrap">
      <div className="tree-toolbar" role="toolbar" aria-label="Tree view controls">
        <button type="button" onClick={fitAll} title="Fit as much of the artwork as stays readable. Pan for the rest.">
          Fit all
        </button>
        <button type="button" onClick={focusSelection} disabled={!(selected ?? rootId)} title="Centre the selected version at a readable zoom.">
          Focus selection
        </button>
        {diagnostics > 0 ? (
          <label className="tree-toggle">
            <input type="checkbox" checked={showDiagnostics} onChange={(event) => setShowDiagnostics(event.target.checked)} />
            {diagnostics} record(s) without valid ancestry
          </label>
        ) : null}
        {mismatches > 0 ? (
          <span className="tree-note" title={layout.generationMismatch.map((entry) => `${entry.id}: stored gen ${entry.generation}, ring ${entry.depth}`).join('\n')}>
            {mismatches} stored generation(s) disagree with the rings
          </span>
        ) : null}
        <span className="tree-note">each ring holds one parent's children · rings are ancestry, not measured similarity</span>
        <span className="tree-note">cards stay clickable at this zoom · pan to reach the rest</span>
        {layout.repairs > 0 ? (
          <span className="tree-note" title={`The layout grew ${layout.repairs} ring(s) so that no card touches another.`}>
            {layout.repairs} ring(s) widened to keep the cards apart
          </span>
        ) : null}
        {layout.problems.length > 0 ? (
          <span className="tree-note tree-warning" title={layout.problems.join('\n')}>
            {layout.problems.length} card(s) could not be separated
          </span>
        ) : null}
        {relationships && relationships.length > 0 ? (
          <span className="tree-note">
            {relationships.length} measured pair(s), the strongest {Math.min(relationships.length, MAX_RELATIONSHIP_DRAWS)} drawn as curves
          </span>
        ) : null}
      </div>
      <ReactFlow
        nodes={flowNodes}
        edges={drawnEdges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onInit={(instance) => {
          flow.current = instance;
        }}
        onNodeClick={(_, node) => handleSelect(node.id)}
        onMoveStart={(event) => {
          const type = (event as { type?: string } | undefined)?.type;
          if (type === 'mousedown' || type === 'touchstart' || type === 'wheel') userMoved.current = true;
        }}
        fitView
        fitViewOptions={fitOptions}
        minZoom={MIN_OVERVIEW_ZOOM}
        maxZoom={MAX_ZOOM}
        proOptions={{ hideAttribution: true }}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable
      >
        <Background color="#d0d0d0" gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
