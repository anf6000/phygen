// Types for the controller API. They follow docs/API.md exactly.

export type VersionStatus =
  | 'queued'
  | 'authoring'
  | 'validating'
  | 'capturing'
  | 'judging'
  | 'promoted'
  | 'rejected'
  | 'failed'
  | 'paused';

export type RunState = 'queued' | 'running' | 'paused' | 'stopping' | 'stopped' | 'completed' | 'failed';

export interface Artwork {
  id: string;
  packageId: string;
  title: string;
  contractVersion: string;
  packagePath: string;
  rootVersionId: string | null;
  createdAt: string;
  versionCount?: number;
}

export interface TreeNode {
  id: string;
  parentId: string | null;
  generation: number;
  /** The evolution level this version belongs to, from 1. */
  evolution: number | null;
  /** The position of this version inside its level, from 1. */
  variant: number | null;
  slot: string | null;
  title: string;
  status: VersionStatus;
  direction: string | null;
  /** The palette this version renders with. */
  palette: string | null;
  /** Null when this version holds no capture. The interface must not request it. */
  thumbnailUrl: string | null;
  /** The frame the capture wrote last, while the node is still working. */
  latestCaptureUrl: string | null;
  latestCaptureStage: string | null;
  latestCaptureStep: number | null;
  livePath: string;
  liveUrl: string;
  sourceHash: string;
  createdAt: string;
  onLineage: boolean;
  /** The run that made this version used the deterministic test double, so this
   *  is not real work and its verdicts are not evidence. */
  stub: boolean;
  usageUsd: number;
  error: { code: string; message: string } | null;
}

export interface TreeEdge {
  id: string;
  source: string;
  target: string;
  onLineage: boolean;
}

export interface Tree {
  artwork: Artwork;
  nodes: TreeNode[];
  edges: TreeEdge[];
  activeRunId: string | null;
  activeVersionIds: string[];
  activeKinds: Record<string, string>;
}

/** A way of measuring the relationship between two versions. */
export interface Measure {
  id: string;
  label: string;
  /** "deterministic" spends nothing; "model" needs a provider and a budget. */
  method: 'deterministic' | 'model';
  available: boolean;
  /** What a HIGH score means. The interface states this, never the reverse. */
  direction: string;
  description: string;
  unavailableReason?: string;
}

export interface MeasureList {
  measures: Measure[];
  defaultMeasure: string | null;
}

export interface AnalysisRun {
  id: string;
  artworkId: string;
  measure: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  revision: string | null;
  params: { limit?: number; groups?: Record<string, number>; considered?: number };
  progress: { total?: number; done?: number; reused?: number; failed?: number; cancelling?: boolean; elapsedMs?: number };
  errorCode: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
}

/** One measured pair. `score` is a distance: a HIGH score means less alike. */
export interface RelationshipPair {
  id: string;
  measure: string;
  a: string;
  b: string;
  pairKey: string;
  outcome: 'ok' | 'error';
  score: number | null;
  band: string | null;
  evidence: Record<string, unknown>;
  /** Why this pair was chosen: lineage, round, generation, slot, or sampled. */
  group: string | null;
  /** True when one version is the ancestor of the other, from the records. */
  ancestor: boolean;
  error: { code: string; message: string | null } | null;
}

export interface RelationshipsView {
  measure: Measure;
  run: AnalysisRun | null;
  pairs: RelationshipPair[];
  currentRevision: string;
  stale: boolean;
  reason: string | null;
  maximum: number;
}


export interface Capture {
  id: string;
  stage: string;
  step: number;
  seed: number;
  width: number;
  height: number;
  dpr: number;
  rendererBackend: string | null;
  sourceHash: string;
  configurationHash: string;
  timestep: number | null;
  url: string;
  createdAt: string;
}

export interface Comparison {
  id: string;
  kind: string;
  round: number;
  order: string[];
  labels: Record<string, string>;
  winnerVersionId: string | null;
  confidence: number | null;
  uncertainty: string | null;
  observations: { label: string; frame: string; detail: string }[];
  weaknesses: string[];
  notes: string;
  model: string | null;
  stub: boolean;
  judgeSession: string | null;
  createdAt: string;
}

export interface VersionDetail {
  version: TreeNode & { changes: Change[]; explanation: string | null };
  configuration: Record<string, number | string>;
  changes: Change[];
  explanation: string | null;
  snapshotPath: string;
  captures: Capture[];
  evaluations: Comparison[];
  usage: { id: string; kind: string; model: string; inputTokens: number; outputTokens: number; costUsd: number; createdAt: string }[];
  error: { code: string; message: string } | null;
}

export interface Change {
  path: string;
  status: 'added' | 'removed' | 'changed';
  summary: string;
  added: number;
  removed: number;
}

export interface Run {
  id: string;
  artworkId: string;
  rootVersionId: string;
  direction: string;
  evolutionsRequested: number;
  variantsPerEvolution?: number;
  protocol?: { variantsPerEvolution?: number; providerModel?: string; authorModel?: string };
  evolutionsDone: number;
  state: RunState;
  stopReason: string | null;
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  calls: number;
  tokens: number;
  unchangedRounds: number;
  costBoundUsd: number;
  createdAt: string;
  updatedAt: string;
  rounds: { round: number; parentVersionId: string; candidateIds: string[]; winnerVersionId: string | null; promoted: boolean; note: string | null }[];
}

export interface Job {
  id: string;
  versionId: string | null;
  round: number | null;
  slot: string | null;
  kind: string;
  state: string;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
}

export interface RunDetail {
  run: Run;
  jobs: Job[];
  usage: { id: string; kind: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }[];
  comparisons: Comparison[];
  active: boolean;
}

/** One row of the agent feed. */
export interface AgentRow {
  seq: number;
  versionId: string;
  kind: 'tool' | 'text' | 'turn';
  state?: 'start' | 'end';
  tool?: string | null;
  path?: string | null;
  added?: number;
  removed?: number;
  edits?: number;
  writes?: number;
  ok?: boolean;
  text?: string;
  tokens?: number;
  costUsd?: number;
}

/** A real file of the package, read from the workspace. */
export interface FileRow {
  seq: number;
  versionId: string;
  kind: 'inventory' | 'change';
  path: string;
  lines: number;
  bytes: number;
  widths?: number[];
  added?: number;
  removed?: number;
}

export type Decision = { versionId: string; outcome: 'winner' | 'yeeted'; reason?: string };

export interface RecordingStatus {
  active: boolean;
  runId?: string | null;
  folder?: string | null;
  name?: string | null;
  frames: number;
  video?: string | null;
  error?: string | null;
}

export interface ProgressEvent {
  seq: number;
  type: string;
  at: string;
  runId: string;
  payload: Record<string, unknown>;
}

export interface Health {
  ok: boolean;
  version: string;
  provider: { driver: string; model: string; ready: boolean; substituted: boolean; allowSpend: boolean; detail: string | null };
  capture: { backend: string; available: boolean; isolated: boolean; detail: string };
  isolation: { docker: boolean; image: string | null; detail: string };
  artworks: number;
}

export interface CostEstimate {
  evolutions: number;
  variants?: number;
  candidatesPerRound: number;
  authorCalls: number;
  judgeCalls: number;
  imagesPerJudgeCall?: number;
  tokens?: {
    authorInputPerCall: number;
    authorOutputPerCall: number;
    judgeInputPerCall: number;
    judgeOutputPerCall: number;
    totalInput: number;
    totalOutput: number;
  };
  estimateUsd: number | null;
  boundUsd: number;
  safetyFactor: number;
  pricingSource: 'catalog' | 'configured';
  authorModel?: { id: string; known: boolean; priceInUsdPerMTok: number | null; priceOutUsdPerMTok: number | null };
  judgeModel?: { id: string; known: boolean; priceInUsdPerMTok: number | null; priceOutUsdPerMTok: number | null };
  note: string;
}

export interface ModelInfo {
  id: string;
  name: string;
  acceptsImages: boolean;
  contextWindow: number | null;
  priceInUsdPerMTok: number;
  priceOutUsdPerMTok: number;
  free: boolean;
}

export interface ModelList {
  source: string;
  count: number;
  fetchedAt?: string | null;
  defaultModel: string;
  authorModel: string;
  models: ModelInfo[];
}

export interface ApiError {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}
