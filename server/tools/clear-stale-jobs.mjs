// Close records that a killed tool or an older stop path left in flight.
//
//   node tools/clear-stale-jobs.mjs
//
// 1. A job in `running` or `queued` whose tool was killed becomes failed.
// 2. A version in a running stage whose RUN is already terminal becomes failed.
//    The older stop path marked the run stopped and left the interrupted step
//    open, so its card showed "the agent writes code" forever.
// A version of an ACTIVE run is never touched.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync('S:/PROJECTS/phygen/data-evolve/phygen.db');
const now = new Date().toISOString();

// A job of an ACTIVE run belongs to a session that is still working. Never
// touch it. Only a job whose run is terminal, or that has no run at all, is
// stale.
const staleJobs = db
  .prepare(
    `SELECT j.id, j.kind, j.version_id, j.run_id
     FROM jobs j
     LEFT JOIN runs r ON r.id = j.run_id
     WHERE j.state IN ('running','queued')
       AND (j.run_id IS NULL OR r.state IN ('stopped','completed','failed'))`,
  )
  .all();
for (const job of staleJobs) {
  db.prepare(
    "UPDATE jobs SET state = 'failed', error_code = 'interrupted_by_operator', error_message = 'The tool that owned this job was stopped.', updated_at = ? WHERE id = ?",
  ).run(now, job.id);
  console.log(`job ${job.id} (${job.kind}) -> failed`);
}

const staleVersions = db
  .prepare(
    `SELECT v.id, v.run_id, v.generation, v.status
     FROM versions v
     JOIN runs r ON r.id = v.run_id
     WHERE v.status IN ('queued','authoring','validating','capturing')
       AND r.state IN ('stopped','completed','failed')`,
  )
  .all();
for (const version of staleVersions) {
  db.prepare(
    "UPDATE versions SET status = 'failed', error_code = 'run_ended', error_message = 'The run ended during this stage.', updated_at = ? WHERE id = ?",
  ).run(now, version.id);
  console.log(`version ${version.id} (generation ${version.generation}, was ${version.status}) -> failed`);
}

if (staleJobs.length === 0 && staleVersions.length === 0) console.log('nothing was left in flight');
db.close();
