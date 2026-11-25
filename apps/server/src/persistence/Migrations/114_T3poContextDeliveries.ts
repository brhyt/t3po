import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t3po_context_deliveries (thread_id TEXT PRIMARY KEY, context TEXT NOT NULL, provider_thread_id TEXT NOT NULL, run_id TEXT NOT NULL, compactions INTEGER NOT NULL)`;
  // Every lead and channel turn counts its thread's compactions.
  yield* sql`CREATE INDEX t3po_turn_items_compaction_idx ON orchestration_v2_projection_turn_items(thread_id) WHERE type = 'compaction'`;
});
