// Types for the controller API. They follow docs/API.md exactly.

export type VersionStatus = 'queued' | 'authoring' | 'validating' | 'capturing' | 'promoted' | 'parked' | 'failed';

export type Verdict = 'kept' | 'parked' | 'pending';

export type GateBranch = 'quality' | 'novelty' | 'both' | 'none';

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

export interface Change {
  path: string;
  status: 'added' | 'removed' | 'changed';
  added: number;
  removed: number;
}

/** One version in the forward chain. */
export interface TreeNode {
  id: string;
  parentId: string | null;
  generation: number;
  /** The evolution step this version belongs to, from 1. The root holds null. */
  step: number | null;
  title: string;
  status: VersionStatus;
  /** The palette this version renders with. */
  palette: string | null;
  /** The still frame of this version: the capture, or null before the capture. */
  stillUrl: string | null;
  stillStage: string | null;
  stillStep: number | null;
  livePath: string;
  liveUrl: string;
  sourceHash: string;
  createdAt: string;
  onLineage: boolean;
  /** The files this step changed, against its parent. */
  changes: Change[];
  explanation: string | null;
  /** The run that made this version used the deterministic test double. */
  stub: boolean;
  usageUsd: number;
  tokens: number;
  error: { code: string; message: string } | null;
  /** The perceptual gate verdict of this version, or null before the gate ran. */
  verdict: Verdict | null;
  /** True when a park verdict actually stopped the step (park mode, not warn). */
  verdictEnforced: boolean;
  /** True when the verdict comes from a step that was repaired after a park. */
  repaired: boolean;
}

export interface JudgmentTest {
  name: string;
  tripped: boolean;
  value: unknown;
  floor: unknown;
  note: string;
  available: boolean;
}

export interface JudgeScore {
  criterion: string;
  score: number;
  frames: string[];
}

export interface JudgeObservation {
  label: string;
  frame: string | null;
  detail: string;
}

export interface JudgmentNovelty {
  novelty?: number;
  nearest?: { id: string; role: string | null; distance: number } | null;
  distances?: { id: string; role: string | null; distance: number }[];
  coherence?: number;
  terms?: Record<string, number>;
  parentQuality?: number | null;
  quality?: number | null;
}

export interface JudgmentJudge {
  observations?: JudgeObservation[];
  weaknesses?: string[];
  mean?: number | null;
  confidence?: number;
  uncertainty?: string;
  error?: { code: string; message: string } | null;
}

export interface JudgmentFrame {
  stage: string;
  step: number;
  seed?: number;
  captureId?: string;
  url?: string;
}

/** One gate judgment: the metrics, the hard tests, the judge answer, and the verdict. */
export interface Judgment {
  versionId: string;
  runId: string | null;
  status: Verdict;
  enforced: boolean;
  repaired: boolean;
  branch: GateBranch | null;
  reason: string | null;
  direction: string | null;
  features: Record<string, unknown>;
  tests: JudgmentTest[];
  scores: JudgeScore[];
  novelty: JudgmentNovelty;
  judge: JudgmentJudge | null;
  judgeCostUsd: number;
  frames: JudgmentFrame[];
  createdAt: string;
}

export interface ArchiveEntry {
  versionId: string;
  generation: number;
  quality: number;
  novelty: number;
  addedBy?: string;
}

export interface ArchiveReport {
  members: ArchiveEntry[];
  refused: { versionId: string; reason: string; quality: number; novelty: number }[];
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

export interface Run {
  id: string;
  artworkId: string;
  rootVersionId: string;
  evolutionsRequested: number;
  evolutionsDone: number;
  state: RunState;
  stopReason: string | null;
  limitUsd: number;
  spentUsd: number;
  reservedUsd: number;
  calls: number;
  tokens: number;
  protocol?: { providerModel?: string; authorModel?: string; providerDriver?: string };
  costBoundUsd: number;
  createdAt: string;
  updatedAt: string;
  rounds: { round: number; parentVersionId: string; candidateIds: string[]; winnerVersionId: string | null; promoted: boolean; note: string | null }[];
}

export interface Job {
  id: string;
  versionId: string | null;
  round: number | null;
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
  active: boolean;
}

/** One row of the agent feed. `reason` rows hold the agent reasoning. */
export interface AgentRow {
  seq: number;
  versionId: string;
  kind: 'tool' | 'text' | 'turn' | 'reason';
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
  models: ModelInfo[];
}

export interface ApiError {
  code: string;
  message: string;
  detail?: Record<string, unknown>;
}
