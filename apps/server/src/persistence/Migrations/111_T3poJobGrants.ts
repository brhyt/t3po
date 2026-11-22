import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t3po_launch_revisions (
    message_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL)`;
  yield* sql`CREATE TABLE t3po_job_grants (
    task_id TEXT NOT NULL, version INTEGER NOT NULL, project_id TEXT NOT NULL,
    data TEXT NOT NULL, PRIMARY KEY (task_id, version))`;
  yield* sql`CREATE TABLE t3po_grant_admissions (
    run_id TEXT NOT NULL, task_id TEXT NOT NULL, version INTEGER NOT NULL, binding TEXT,
    PRIMARY KEY (run_id, task_id))`;
  yield* sql`CREATE INDEX t3po_grant_usage ON t3po_grant_admissions(task_id, version)`;
});
