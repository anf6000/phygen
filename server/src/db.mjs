// ─────────────────────────────────────────────────────────────────────────────
// db.mjs — storage for records. node:sqlite, no native dependency.
//
// Immutable artifacts (source snapshots, captures) live on disk. This module
// stores the records that point at them, plus the event log that drives
// progress and recovery.
// ─────────────────────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { newId, nowIso } from './util.mjs';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artworks (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL,
  title TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  package_path TEXT NOT NULL,
  root_version_id TEXT,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY,
  artwork_id TEXT NOT NULL,
  parent_id TEXT,
  run_id TEXT,
  generation INTEGER NOT NULL DEFAULT 0,
  round INTEGER,
  slot TEXT,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  direction TEXT,
  source_hash TEXT NOT NULL,
  snapshot_path TEXT NOT NULL,
  workspace_path TEXT,
  configuration_json TEXT NOT NULL,
  changes_json TEXT NOT NULL DEFAULT '[]',
  explanation TEXT,
  on_lineage INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  artwork_id TEXT NOT NULL,
  root_version_id TEXT NOT NULL,
  direction TEXT NOT NULL,
  evolutions_requested INTEGER NOT NULL,
  evolutions_done INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  stop_reason TEXT,
  limit_usd REAL NOT NULL,
  spent_usd REAL NOT NULL DEFAULT 0,
  reserved_usd REAL NOT NULL DEFAULT 0,
  calls INTEGER NOT NULL DEFAULT 0,
  tokens INTEGER NOT NULL DEFAULT 0,
  unchanged_rounds INTEGER NOT NULL DEFAULT 0,
  protocol_json TEXT NOT NULL,
  cost_bound_usd REAL NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS rounds (
  run_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  parent_version_id TEXT NOT NULL,
  candidate_ids_json TEXT NOT NULL,
  winner_version_id TEXT,
  promoted INTEGER NOT NULL DEFAULT 0,
  note TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (run_id, round)
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  version_id TEXT,
  round INTEGER,
  slot TEXT,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS captures (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL,
  run_id TEXT,
  stage TEXT NOT NULL,
  seed INTEGER NOT NULL,
  step INTEGER NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  dpr REAL NOT NULL,
  renderer_backend TEXT,
  source_hash TEXT NOT NULL,
  configuration_hash TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  meta_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS comparisons (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  kind TEXT NOT NULL,
  order_json TEXT NOT NULL,
  labels_json TEXT NOT NULL,
  verdict_json TEXT NOT NULL,
  winner_version_id TEXT,
  confidence REAL,
  uncertainty TEXT,
  judge_session TEXT,
  source_hash TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  round INTEGER NOT NULL,
  version_id TEXT NOT NULL,
  comparison_id TEXT,
  outcome TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage (
  id TEXT PRIMARY KEY,
  run_id TEXT,
  job_id TEXT,
  version_id TEXT,
  kind TEXT NOT NULL,
  model TEXT NOT NULL,
  session_id TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  PRIMARY KEY (run_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_versions_artwork ON versions (artwork_id);
CREATE INDEX IF NOT EXISTS idx_versions_parent ON versions (parent_id);
CREATE INDEX IF NOT EXISTS idx_jobs_run ON jobs (run_id);
CREATE INDEX IF NOT EXISTS idx_captures_version ON captures (version_id);
CREATE INDEX IF NOT EXISTS idx_usage_run ON usage (run_id);
`;

function json(value) {
  return JSON.stringify(value ?? null);
}

function parseJson(text, fallback) {
  if (text === null || text === undefined) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function bool(value) {
  return value ? 1 : 0;
}

export class Store {
  constructor(path) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
  }

  close() {
    this.db.close();
  }

  // ── artworks ──────────────────────────────────────────────────────────────
  createArtwork({ packageId, title, contractVersion, packagePath, rootVersionId }) {
    const artwork = {
      id: newId('art'),
      packageId,
      title,
      contractVersion,
      packagePath,
      rootVersionId: rootVersionId ?? null,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO artworks (id, package_id, title, contract_version, package_path, root_version_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(artwork.id, artwork.packageId, artwork.title, artwork.contractVersion, artwork.packagePath, artwork.rootVersionId, artwork.createdAt);
    return artwork;
  }

  getArtwork(id) {
    const row = this.db.prepare('SELECT * FROM artworks WHERE id = ?').get(id);
    return row ? artworkFromRow(row) : null;
  }

  findArtworkByPackagePath(packagePath) {
    const row = this.db.prepare('SELECT * FROM artworks WHERE package_path = ? ORDER BY created_at LIMIT 1').get(packagePath);
    return row ? artworkFromRow(row) : null;
  }

  listArtworks() {
    return this.db
      .prepare(
        `SELECT a.*, (SELECT COUNT(*) FROM versions v WHERE v.artwork_id = a.id) AS version_count
         FROM artworks a ORDER BY a.created_at`,
      )
      .all()
      .map((row) => ({ ...artworkFromRow(row), versionCount: row.version_count }));
  }

  setArtworkRoot(artworkId, versionId) {
    this.db.prepare('UPDATE artworks SET root_version_id = ? WHERE id = ?').run(versionId, artworkId);
  }

  // ── versions ──────────────────────────────────────────────────────────────
  createVersion(version) {
    const now = nowIso();
    const record = {
      id: version.id ?? newId('ver'),
      artworkId: version.artworkId,
      parentId: version.parentId ?? null,
      runId: version.runId ?? null,
      generation: version.generation ?? 0,
      round: version.round ?? null,
      slot: version.slot ?? null,
      title: version.title,
      status: version.status,
      direction: version.direction ?? null,
      sourceHash: version.sourceHash,
      snapshotPath: version.snapshotPath,
      workspacePath: version.workspacePath ?? null,
      configuration: version.configuration ?? {},
      changes: version.changes ?? [],
      explanation: version.explanation ?? null,
      onLineage: bool(version.onLineage),
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO versions (id, artwork_id, parent_id, run_id, generation, round, slot, title, status, direction,
           source_hash, snapshot_path, workspace_path, configuration_json, changes_json, explanation, on_lineage, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.artworkId,
        record.parentId,
        record.runId,
        record.generation,
        record.round,
        record.slot,
        record.title,
        record.status,
        record.direction,
        record.sourceHash,
        record.snapshotPath,
        record.workspacePath,
        json(record.configuration),
        json(record.changes),
        record.explanation,
        record.onLineage,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  updateVersion(id, patch) {
    const current = this.getVersion(id);
    if (!current) return null;
    const next = {
      ...current,
      ...patch,
      configuration: patch.configuration ?? current.configuration,
      changes: patch.changes ?? current.changes,
      updatedAt: nowIso(),
    };
    this.db
      .prepare(
        `UPDATE versions SET status = ?, title = ?, configuration_json = ?, changes_json = ?, explanation = ?,
           on_lineage = ?, error_code = ?, error_message = ?, source_hash = ?, snapshot_path = ?, workspace_path = ?,
           generation = ?, round = ?, slot = ?, parent_id = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        next.status,
        next.title,
        json(next.configuration),
        json(next.changes),
        next.explanation,
        bool(next.onLineage),
        patch.errorCode ?? null,
        patch.errorMessage ?? null,
        next.sourceHash,
        next.snapshotPath,
        next.workspacePath,
        next.generation,
        next.round ?? null,
        next.slot ?? null,
        next.parentId ?? null,
        next.updatedAt,
        id,
      );
    return this.getVersion(id);
  }

  getVersion(id) {
    const row = this.db.prepare('SELECT * FROM versions WHERE id = ?').get(id);
    return row ? versionFromRow(row) : null;
  }

  listVersions(artworkId) {
    return this.db
      .prepare('SELECT * FROM versions WHERE artwork_id = ? ORDER BY generation, created_at')
      .all(artworkId)
      .map(versionFromRow);
  }

  /** Walk from a version back to the root. */
  lineage(versionId) {
    const chain = [];
    let current = this.getVersion(versionId);
    const seen = new Set();
    while (current && !seen.has(current.id)) {
      seen.add(current.id);
      chain.push(current);
      current = current.parentId ? this.getVersion(current.parentId) : null;
    }
    return chain.reverse();
  }

  // ── runs ──────────────────────────────────────────────────────────────────
  createRun(run) {
    const record = {
      id: run.id ?? newId('run'),
      artworkId: run.artworkId,
      rootVersionId: run.rootVersionId,
      direction: run.direction,
      evolutionsRequested: run.evolutionsRequested,
      evolutionsDone: 0,
      state: run.state ?? 'queued',
      stopReason: null,
      limitUsd: run.limitUsd,
      spentUsd: 0,
      reservedUsd: 0,
      calls: 0,
      tokens: 0,
      unchangedRounds: 0,
      protocol: run.protocol,
      costBoundUsd: run.costBoundUsd,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      startedAt: null,
      finishedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO runs (id, artwork_id, root_version_id, direction, evolutions_requested, evolutions_done, state,
           limit_usd, spent_usd, reserved_usd, calls, tokens, unchanged_rounds, protocol_json, cost_bound_usd,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0, 0, 0, 0, 0, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.artworkId,
        record.rootVersionId,
        record.direction,
        record.evolutionsRequested,
        record.state,
        record.limitUsd,
        record.protocol ? json(record.protocol) : '{}',
        record.costBoundUsd,
        record.createdAt,
        record.updatedAt,
      );
    return this.getRun(record.id);
  }

  updateRun(id, patch) {
    const current = this.getRun(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE runs SET state = ?, stop_reason = ?, evolutions_done = ?, spent_usd = ?, reserved_usd = ?,
           calls = ?, tokens = ?, unchanged_rounds = ?, updated_at = ?, started_at = ?, finished_at = ?
         WHERE id = ?`,
      )
      .run(
        next.state,
        next.stopReason ?? null,
        next.evolutionsDone,
        next.spentUsd,
        next.reservedUsd,
        next.calls,
        next.tokens,
        next.unchangedRounds,
        next.updatedAt,
        next.startedAt ?? null,
        next.finishedAt ?? null,
        id,
      );
    return this.getRun(id);
  }

  getRun(id) {
    const row = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return row ? runFromRow(row) : null;
  }

  listRuns(limit = 20) {
    return this.db.prepare('SELECT * FROM runs ORDER BY created_at DESC LIMIT ?').all(limit).map(runFromRow);
  }

  /** Runs that a restart must recover: not terminal. */
  listActiveRuns() {
    return this.db
      .prepare("SELECT * FROM runs WHERE state IN ('queued','running','paused','stopping') ORDER BY created_at")
      .all()
      .map(runFromRow);
  }

  listRounds(runId) {
    return this.db
      .prepare('SELECT * FROM rounds WHERE run_id = ? ORDER BY round')
      .all(runId)
      .map((row) => ({
        round: row.round,
        parentVersionId: row.parent_version_id,
        candidateIds: parseJson(row.candidate_ids_json, []),
        winnerVersionId: row.winner_version_id,
        promoted: row.promoted === 1,
        note: row.note,
        createdAt: row.created_at,
      }));
  }

  upsertRound(round) {
    this.db
      .prepare(
        `INSERT INTO rounds (run_id, round, parent_version_id, candidate_ids_json, winner_version_id, promoted, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (run_id, round) DO UPDATE SET
           candidate_ids_json = excluded.candidate_ids_json,
           winner_version_id = excluded.winner_version_id,
           promoted = excluded.promoted,
           note = excluded.note`,
      )
      .run(
        round.runId,
        round.round,
        round.parentVersionId,
        json(round.candidateIds ?? []),
        round.winnerVersionId ?? null,
        bool(round.promoted),
        round.note ?? null,
        nowIso(),
      );
    return this.listRounds(round.runId);
  }

  // ── jobs ──────────────────────────────────────────────────────────────────
  createJob(job) {
    const record = {
      id: job.id ?? newId('job'),
      runId: job.runId,
      versionId: job.versionId ?? null,
      round: job.round ?? null,
      slot: job.slot ?? null,
      kind: job.kind,
      state: job.state ?? 'queued',
      attempts: job.attempts ?? 0,
      payload: job.payload ?? {},
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO jobs (id, run_id, version_id, round, slot, kind, state, attempts, payload_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.versionId,
        record.round,
        record.slot,
        record.kind,
        record.state,
        record.attempts,
        json(record.payload),
        record.createdAt,
        record.updatedAt,
      );
    return this.getJob(record.id);
  }

  updateJob(id, patch) {
    const current = this.getJob(id);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: nowIso() };
    this.db
      .prepare(
        `UPDATE jobs SET state = ?, attempts = ?, lease_owner = ?, lease_expires_at = ?, result_json = ?,
           error_code = ?, error_message = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.state,
        next.attempts,
        patch.leaseOwner ?? null,
        patch.leaseExpiresAt ?? null,
        patch.result ? json(patch.result) : null,
        patch.errorCode ?? null,
        patch.errorMessage ?? null,
        next.updatedAt,
        id,
      );
    return this.getJob(id);
  }

  getJob(id) {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
    return row ? jobFromRow(row) : null;
  }

  listJobs(runId) {
    return this.db.prepare('SELECT * FROM jobs WHERE run_id = ? ORDER BY created_at').all(runId).map(jobFromRow);
  }

  // ── captures ──────────────────────────────────────────────────────────────
  createCapture(capture) {
    const record = {
      id: capture.id ?? newId('cap'),
      versionId: capture.versionId,
      runId: capture.runId ?? null,
      stage: capture.stage,
      seed: capture.seed,
      step: capture.step,
      width: capture.width,
      height: capture.height,
      dpr: capture.dpr,
      rendererBackend: capture.rendererBackend ?? null,
      sourceHash: capture.sourceHash,
      configurationHash: capture.configurationHash,
      path: capture.path,
      bytes: capture.bytes,
      meta: capture.meta ?? {},
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO captures (id, version_id, run_id, stage, seed, step, width, height, dpr, renderer_backend,
           source_hash, configuration_hash, path, bytes, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.versionId,
        record.runId,
        record.stage,
        record.seed,
        record.step,
        record.width,
        record.height,
        record.dpr,
        record.rendererBackend,
        record.sourceHash,
        record.configurationHash,
        record.path,
        record.bytes,
        json(record.meta),
        record.createdAt,
      );
    return record;
  }

  listCaptures(versionId) {
    return this.db
      .prepare('SELECT * FROM captures WHERE version_id = ? ORDER BY stage, seed, step')
      .all(versionId)
      .map(captureFromRow);
  }

  getCapture(id) {
    const row = this.db.prepare('SELECT * FROM captures WHERE id = ?').get(id);
    return row ? captureFromRow(row) : null;
  }

  /** The newest capture of every version of an artwork. One query. */
  latestCaptureByArtwork(artworkId) {
    const rows = this.db
      .prepare(
        `SELECT c.id, c.version_id, c.stage, c.step, c.seed, c.created_at
         FROM captures c
         JOIN versions v ON v.id = c.version_id
         WHERE v.artwork_id = ?
         ORDER BY c.created_at`,
      )
      .all(artworkId);
    const newest = new Map();
    for (const row of rows) newest.set(row.version_id, row);
    return newest;
  }

  // ── comparisons and evaluations ───────────────────────────────────────────
  createComparison(comparison) {
    const record = {
      id: comparison.id ?? newId('cmp'),
      runId: comparison.runId,
      round: comparison.round,
      kind: comparison.kind,
      order: comparison.order,
      labels: comparison.labels,
      verdict: comparison.verdict,
      winnerVersionId: comparison.winnerVersionId ?? null,
      confidence: comparison.confidence ?? null,
      uncertainty: comparison.uncertainty ?? null,
      judgeSession: comparison.judgeSession ?? null,
      sourceHash: comparison.sourceHash ?? null,
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO comparisons (id, run_id, round, kind, order_json, labels_json, verdict_json, winner_version_id,
           confidence, uncertainty, judge_session, source_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.round,
        record.kind,
        json(record.order),
        json(record.labels),
        json(record.verdict),
        record.winnerVersionId,
        record.confidence,
        record.uncertainty,
        record.judgeSession,
        record.sourceHash,
        record.createdAt,
      );
    return { ...record, createdAt: record.createdAt };
  }

  listComparisons(runId) {
    return this.db
      .prepare('SELECT * FROM comparisons WHERE run_id = ? ORDER BY created_at')
      .all(runId)
      .map((row) => ({
        id: row.id,
        runId: row.run_id,
        round: row.round,
        kind: row.kind,
        order: parseJson(row.order_json, []),
        labels: parseJson(row.labels_json, {}),
        verdict: parseJson(row.verdict_json, {}),
        winnerVersionId: row.winner_version_id,
        confidence: row.confidence,
        uncertainty: row.uncertainty,
        judgeSession: row.judge_session,
        sourceHash: row.source_hash,
        createdAt: row.created_at,
      }));
  }

  createEvaluation(evaluation) {
    const record = { id: evaluation.id ?? newId('ev'), createdAt: nowIso(), ...evaluation };
    this.db
      .prepare(
        `INSERT INTO evaluations (id, run_id, round, version_id, comparison_id, outcome, note, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.round,
        record.versionId,
        record.comparisonId ?? null,
        record.outcome,
        record.note ?? null,
        record.createdAt,
      );
    return record;
  }

  // ── usage ─────────────────────────────────────────────────────────────────
  createUsage(entry) {
    const record = {
      id: entry.id ?? newId('usg'),
      runId: entry.runId ?? null,
      jobId: entry.jobId ?? null,
      versionId: entry.versionId ?? null,
      kind: entry.kind,
      model: entry.model,
      sessionId: entry.sessionId ?? null,
      inputTokens: entry.inputTokens ?? 0,
      outputTokens: entry.outputTokens ?? 0,
      costUsd: entry.costUsd ?? 0,
      raw: entry.raw ?? {},
      createdAt: nowIso(),
    };
    this.db
      .prepare(
        `INSERT INTO usage (id, run_id, job_id, version_id, kind, model, session_id, input_tokens, output_tokens,
           cost_usd, raw_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.runId,
        record.jobId,
        record.versionId,
        record.kind,
        record.model,
        record.sessionId,
        record.inputTokens,
        record.outputTokens,
        record.costUsd,
        json(record.raw),
        record.createdAt,
      );
    return record;
  }

  listUsage(runId) {
    return this.db.prepare('SELECT * FROM usage WHERE run_id = ? ORDER BY created_at').all(runId).map(usageFromRow);
  }

  listUsageForVersion(versionId) {
    return this.db.prepare('SELECT * FROM usage WHERE version_id = ? ORDER BY created_at').all(versionId).map(usageFromRow);
  }

  /** One query for the cost of every version of an artwork. */
  usageCostByArtwork(artworkId) {
    const rows = this.db
      .prepare(
        `SELECT u.version_id AS version_id, SUM(u.cost_usd) AS cost
         FROM usage u
         JOIN versions v ON v.id = u.version_id
         WHERE v.artwork_id = ?
         GROUP BY u.version_id`,
      )
      .all(artworkId);
    const costs = new Map();
    for (const row of rows) costs.set(row.version_id, row.cost ?? 0);
    return costs;
  }

  // ── events ────────────────────────────────────────────────────────────────
  appendEvent(runId, type, payload) {
    const row = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE run_id = ?').get(runId);
    const seq = row.seq + 1;
    const at = nowIso();
    this.db
      .prepare('INSERT INTO events (run_id, seq, type, at, payload_json) VALUES (?, ?, ?, ?, ?)')
      .run(runId, seq, type, at, json(payload));
    return { seq, type, at, runId, payload };
  }

  /** Stored events of one type, oldest first. */
  listEventsByType(runId, type, limit = 2000) {
    return this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND type = ? ORDER BY seq LIMIT ?')
      .all(runId, type, limit)
      .map((row) => ({
        seq: row.seq,
        type: row.type,
        at: row.at,
        runId: row.run_id,
        payload: parseJson(row.payload_json, {}),
      }));
  }

  listEvents(runId, sinceSeq = 0, limit = 500) {
    return this.db
      .prepare('SELECT * FROM events WHERE run_id = ? AND seq > ? ORDER BY seq LIMIT ?')
      .all(runId, sinceSeq, limit)
      .map((row) => ({
        seq: row.seq,
        type: row.type,
        at: row.at,
        runId: row.run_id,
        payload: parseJson(row.payload_json, {}),
      }));
  }
}

function artworkFromRow(row) {
  return {
    id: row.id,
    packageId: row.package_id,
    title: row.title,
    contractVersion: row.contract_version,
    packagePath: row.package_path,
    rootVersionId: row.root_version_id,
    meta: parseJson(row.meta_json, {}),
    createdAt: row.created_at,
  };
}

function versionFromRow(row) {
  return {
    id: row.id,
    artworkId: row.artwork_id,
    parentId: row.parent_id,
    runId: row.run_id,
    generation: row.generation,
    round: row.round,
    slot: row.slot,
    title: row.title,
    status: row.status,
    direction: row.direction,
    sourceHash: row.source_hash,
    snapshotPath: row.snapshot_path,
    workspacePath: row.workspace_path,
    configuration: parseJson(row.configuration_json, {}),
    changes: parseJson(row.changes_json, []),
    explanation: row.explanation,
    onLineage: row.on_lineage === 1,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runFromRow(row) {
  return {
    id: row.id,
    artworkId: row.artwork_id,
    rootVersionId: row.root_version_id,
    direction: row.direction,
    evolutionsRequested: row.evolutions_requested,
    evolutionsDone: row.evolutions_done,
    state: row.state,
    stopReason: row.stop_reason,
    limitUsd: row.limit_usd,
    spentUsd: row.spent_usd,
    reservedUsd: row.reserved_usd,
    calls: row.calls,
    tokens: row.tokens,
    unchangedRounds: row.unchanged_rounds,
    protocol: parseJson(row.protocol_json, {}),
    costBoundUsd: row.cost_bound_usd,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function jobFromRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    versionId: row.version_id,
    round: row.round,
    slot: row.slot,
    kind: row.kind,
    state: row.state,
    attempts: row.attempts,
    leaseOwner: row.lease_owner,
    leaseExpiresAt: row.lease_expires_at,
    payload: parseJson(row.payload_json, {}),
    result: parseJson(row.result_json, null),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function captureFromRow(row) {
  return {
    id: row.id,
    versionId: row.version_id,
    runId: row.run_id,
    stage: row.stage,
    seed: row.seed,
    step: row.step,
    width: row.width,
    height: row.height,
    dpr: row.dpr,
    rendererBackend: row.renderer_backend,
    sourceHash: row.source_hash,
    configurationHash: row.configuration_hash,
    path: row.path,
    bytes: row.bytes,
    meta: parseJson(row.meta_json, {}),
    createdAt: row.created_at,
  };
}

function usageFromRow(row) {
  return {
    id: row.id,
    runId: row.run_id,
    jobId: row.job_id,
    versionId: row.version_id,
    kind: row.kind,
    model: row.model,
    sessionId: row.session_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    raw: parseJson(row.raw_json, {}),
    createdAt: row.created_at,
  };
}
