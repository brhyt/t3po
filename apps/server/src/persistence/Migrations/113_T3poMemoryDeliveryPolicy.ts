import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE t3po_memory_events ADD COLUMN delivery_held INTEGER NOT NULL DEFAULT 0`;
  // Legacy records do not say whether capture happened while exchange was disabled.
  yield* sql`UPDATE t3po_memory_events SET delivery_held = 1 WHERE synced_at IS NULL AND superseded_by IS NULL AND kind != 'local_correction'`;
  // Old senders must fail closed: they cannot enforce delivery holds or project policy.
  yield* sql`ALTER TABLE t3po_memory_events RENAME TO t3po_memory_events_v2`;
  yield* sql`CREATE TABLE t3po_memory_delivery_policy (project_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1, revision INTEGER NOT NULL DEFAULT 0)`;
});
