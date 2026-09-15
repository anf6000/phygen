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
  round: number | null;
  slot: string | null;
  title: string;
  status: VersionStatus;
  direction: string | null;
  thumbnailUrl: string;
  livePath: string;
  liveUrl: string;
  sourceHash: string;
  createdAt: string;
  onLineage: boolean;
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
