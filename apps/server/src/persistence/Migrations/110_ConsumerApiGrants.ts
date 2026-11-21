import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE consumer_api_grants (
    run_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    model TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    max_request_bytes INTEGER NOT NULL,
    max_output_tokens INTEGER NOT NULL,
    status TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    usage_json TEXT,
    service_tier TEXT,
    context_truncated INTEGER NOT NULL DEFAULT 0,
    consumed_at INTEGER
  )`;
});
