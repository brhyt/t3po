import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t3po_push_subscriptions (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, label TEXT NOT NULL, titles TEXT NOT NULL, created_at TEXT NOT NULL)`;
  yield* sql`CREATE TABLE t3po_push_mutes (project_id TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '', PRIMARY KEY (project_id, channel_id))`;
  yield* sql`CREATE TABLE t3po_push_sent (key TEXT PRIMARY KEY, sent_at TEXT NOT NULL)`;
  // Events from before notifications existed are history, not news.
  yield* sql`INSERT INTO t3po_push_sent (key, sent_at) SELECT 'job:' || run_id, 'migration' FROM t3po_task_executions WHERE result_json IS NOT NULL`;
  yield* sql`INSERT INTO t3po_push_sent (key, sent_at) SELECT 'request:' || runtime_request_id, 'migration' FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending'`;
});
