import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE t3po_memory_events ADD COLUMN revision INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE t3po_memory_events ADD COLUMN superseded_by TEXT`;
  yield* sql`ALTER TABLE t3po_memory_events ADD COLUMN target_id TEXT`;
  yield* sql`ALTER TABLE t3po_memory_events ADD COLUMN source TEXT NOT NULL DEFAULT 'local_journal'`;
  yield* sql`ALTER TABLE t3po_memory_events ADD COLUMN correction_revision INTEGER`;
  yield* sql`CREATE INDEX t3po_memory_active ON t3po_memory_events(project_id, superseded_by, sequence)`;
});
