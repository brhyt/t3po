import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t3po_task_revisions (
    task_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (task_id, revision))`;
  yield* sql`INSERT INTO t3po_task_revisions SELECT id, 1, data, json_extract(data, '$.createdAt') FROM t3po_tasks`;
  yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.briefRevision', 1)`;
  yield* sql`CREATE TABLE t3po_task_executions (
    run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, revision INTEGER NOT NULL,
    result_json TEXT, report_thread_id TEXT, delivered_at TEXT)`;
});
