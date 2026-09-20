// ─────────────────────────────────────────────────────────────────────────────
// failed-steps.mjs — why the failed steps failed. Read-only.
//
//   node tools/failed-steps.mjs [--run <runId>]
//
// For every version with status `failed`, print its reason, its jobs, and the
// error and log events of its run that name it. This is the evidence for a
// post-mortem; nothing here writes.
// ─────────────────────────────────────────────────────────────────────────────
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../src/config.mjs';
import { join } from 'node:path';

const config = loadConfig();
const db = new DatabaseSync(join(config.dataDir, 'phygen.db'));

const runFilter = process.argv.includes('--run') ? process.argv[process.argv.indexOf('--run') + 1] : null;
const codeFilter = process.argv.includes('--code') ? process.argv[process.argv.indexOf('--code') + 1] : null;
// --ids prints one version id per line, for a script that repairs them.
const idsOnly = process.argv.includes('--ids');

const failed = db
  .prepare(
    `SELECT id, run_id, parent_id, generation, round, title, status, error_code, error_message, created_at,
            configured_at, changed
     FROM (
       SELECT v.id, v.run_id, v.parent_id, v.generation, v.round, v.title, v.status, v.error_code, v.error_message,
              v.created_at, v.created_at AS configured_at,
              (SELECT group_concat(json_extract(c.value, '$.path'), ', ') FROM json_each(v.changes_json) c) AS changed
       FROM versions v
     )
     WHERE status = 'failed'
       ${runFilter ? 'AND run_id = ?' : ''}
       ${codeFilter ? 'AND error_code = ?' : ''}
     ORDER BY created_at`,
).all(...[runFilter, codeFilter].filter(Boolean));

if (idsOnly) {
  for (const version of failed) console.log(version.id);
  db.close();
  process.exit(0);
}

console.log(`failed versions: ${failed.length}${runFilter ? ` in run ${runFilter}` : ''}\n`);

for (const version of failed) {
  console.log(`${'='.repeat(78)}`);
  console.log(`step ${version.generation} · round ${version.round ?? '-'} · ${version.id}`);
  console.log(`  title:  ${(version.title ?? '').slice(0, 70)}`);
  console.log(`  reason: ${version.error_code ?? 'no code'} :: ${(version.error_message ?? '').slice(0, 220)}`);
  console.log(`  run:    ${version.run_id ?? 'no run'}`);
  console.log(`  at:     ${version.created_at}`);
  console.log(`  files:  ${version.changed ?? 'none recorded'}`);

  const jobs = db
    .prepare("SELECT kind, state, error_code, error_message, created_at FROM jobs WHERE version_id = ? ORDER BY created_at")
    .all(version.id);
  for (const job of jobs) {
    console.log(`  job ${job.kind.padEnd(7)} ${job.state.padEnd(9)} ${job.error_code ?? ''} ${(job.error_message ?? '').slice(0, 120)}`);
  }

  if (version.run_id) {
    const events = db
      .prepare(
        `SELECT type, at, payload_json FROM events
         WHERE run_id = ? AND type IN ('error','log','version.state')
           AND (payload_json LIKE ? OR payload_json LIKE ? OR payload_json LIKE ?)
         ORDER BY seq`,
      )
      .all(version.run_id, `%${version.id}%`, `%${version.generation}%`, `%${(version.error_code ?? '@@').slice(0, 30)}%`);
    for (const event of events.slice(-8)) {
      let payload = {};
      try {
        payload = JSON.parse(event.payload_json);
      } catch {
        payload = { raw: event.payload_json };
      }
      const text = payload.message ?? payload.detail ?? JSON.stringify(payload).slice(0, 200);
      console.log(`  ${event.type.padEnd(14)} ${String(text).slice(0, 260)}`);
    }
  }
  console.log('');
}

const openJobs = db
  .prepare(
    `SELECT j.id, j.kind, j.state, j.version_id, j.round, j.run_id, j.created_at, j.updated_at, r.state AS run_state, r.evolutions_done, r.evolutions_requested
     FROM jobs j LEFT JOIN runs r ON r.id = j.run_id
     WHERE j.state IN ('running','queued') ORDER BY j.created_at`,
  )
  .all();
console.log(`${'='.repeat(78)}`);
console.log(`jobs in flight: ${openJobs.length}`);
for (const job of openJobs) {
  console.log(`  ${job.id} ${job.kind} on ${job.version_id ?? 'no version'} (run ${job.run_id} ${job.run_state} ${job.evolutions_done}/${job.evolutions_requested}) since ${job.created_at} updated ${job.updated_at}`);
}

const runs = db.prepare('SELECT id, state, evolutions_done, evolutions_requested, spent_usd, stop_reason FROM runs ORDER BY created_at DESC LIMIT 4').all();
console.log('\nrecent runs:');
for (const run of runs) {
  console.log(`  ${run.id} ${run.state} ${run.evolutions_done}/${run.evolutions_requested} $${run.spent_usd.toFixed(4)} ${run.stop_reason ?? ''}`);
}
db.close();
