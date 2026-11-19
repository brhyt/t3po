import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t3po_budgets (project_id TEXT PRIMARY KEY, max_runs INTEGER NOT NULL CHECK(max_runs >= 0), max_concurrent INTEGER NOT NULL CHECK(max_concurrent >= 0))`;
  yield* sql`CREATE TABLE t3po_admissions (run_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, active INTEGER NOT NULL)`;
  yield* sql`CREATE INDEX t3po_admissions_project ON t3po_admissions(project_id, active)`;
  yield* sql`WITH RECURSIVE owned(thread_id, project_id, charge) AS (
    SELECT json_extract(data, '$.threadId'), project_id, 1 FROM t3po_tasks
    UNION SELECT json_extract(data, '$.threadId'), project_id, 0 FROM t3po_leads
    UNION SELECT t.thread_id, o.project_id, 1 FROM orchestration_v2_projection_threads t JOIN owned o ON json_extract(t.payload_json, '$.lineage.parentThreadId') = o.thread_id
  ) INSERT OR IGNORE INTO t3po_admissions (run_id, project_id, active)
    SELECT r.run_id, o.project_id, CASE WHEN r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting') THEN 1 ELSE 0 END
    FROM orchestration_v2_projection_runs r JOIN owned o ON r.thread_id = o.thread_id WHERE o.charge = 1`;
});
