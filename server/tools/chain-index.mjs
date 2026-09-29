// ─────────────────────────────────────────────────────────────────────────────
// chain-index.mjs — write the chain record as reviewable text.
//
//   node tools/chain-index.mjs [--out ../docs/chain.json]
//
// The chain itself lives in the record database, which is runtime state and not
// in version control. The snapshot directories under snapshots/ ARE in version
// control, so each evolved artwork's code is kept, but a snapshot directory
// alone does not say which version came from which parent.
//
// This tool writes that structure as one JSON file: every version with its
// generation, parent, status, lineage flag, title, configuration, changed
// files, and snapshot hash. Commit the file after a run so the history stays
// readable in version control.
// ─────────────────────────────────────────────────────────────────────────────
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadConfig } from '../src/config.mjs';

const config = loadConfig();

const outIndex = process.argv.indexOf('--out');
const outPath = outIndex >= 0 ? process.argv[outIndex + 1] : join(config.repoRoot ?? '..', 'docs', 'chain.json');

const db = new DatabaseSync(join(config.dataDir, 'phygen.db'));
const versions = db
  .prepare(
    `SELECT v.id, v.artwork_id, a.title AS artwork_title, v.parent_id, v.generation, v.round,
            v.title, v.status, v.on_lineage, v.snapshot_path, v.configuration_json, v.changes_json,
            v.created_at
       FROM versions v
       LEFT JOIN artworks a ON a.id = v.artwork_id
      ORDER BY v.generation ASC, v.created_at ASC`,
  )
  .all();

const parse = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};
const snapshotHash = (path) => (path ? String(path).replace(/[\\/]+$/, '').split(/[\\/]/).pop() : null);

const record = {
  note: 'Chain structure for the committed snapshots. The record database stays local; this file is its text mirror for the chain. Regenerate with server/tools/chain-index.mjs after a run.',
  generatedAt: new Date().toISOString(),
  versionCount: versions.length,
  versions: versions.map((version) => ({
    id: version.id,
    artworkId: version.artwork_id,
    generation: version.generation,
    round: version.round,
    parentId: version.parent_id,
    status: version.status,
    onLineage: Boolean(version.on_lineage),
    title: version.title,
    snapshot: snapshotHash(version.snapshot_path),
    createdAt: version.created_at,
    configuration: parse(version.configuration_json, null),
    changedFiles: parse(version.changes_json, []).map((change) => ({
      path: change.path,
      status: change.status,
      added: change.added,
      removed: change.removed,
    })),
  })),
};

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');

const promoted = record.versions.filter((version) => version.status === 'promoted').length;
const onLineage = record.versions.filter((version) => version.onLineage).length;
console.log(`chain index written to ${outPath}`);
console.log(`versions ${record.versionCount}, promoted ${promoted}, on the lineage ${onLineage}`);
db.close();
