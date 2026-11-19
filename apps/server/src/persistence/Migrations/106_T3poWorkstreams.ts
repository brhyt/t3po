import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t3po_workstreams (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, channel_id TEXT, data TEXT NOT NULL)`;
  yield* sql`CREATE INDEX t3po_workstream_scope ON t3po_workstreams(project_id, channel_id)`;
  yield* sql`CREATE TABLE t3po_work_routes (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, caller_thread_id TEXT NOT NULL, job_id TEXT NOT NULL, workstream_id TEXT NOT NULL, input TEXT NOT NULL, launch TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'queued', reason TEXT NOT NULL DEFAULT '', next_attempt INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`CREATE INDEX t3po_work_route_pending ON t3po_work_routes(state, next_attempt, sequence)`;
});
