import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t3po_space_connections (source_space_id TEXT NOT NULL REFERENCES t3po_spaces(id) ON DELETE CASCADE, target_space_id TEXT NOT NULL REFERENCES t3po_spaces(id) ON DELETE CASCADE, target_project_id TEXT NOT NULL, PRIMARY KEY(source_space_id, target_project_id), CHECK(source_space_id <> target_space_id))`;
  yield* sql`CREATE TABLE t3po_shared_resources (id TEXT PRIMARY KEY, owner_space_id TEXT NOT NULL REFERENCES t3po_spaces(id) ON DELETE CASCADE, target_space_id TEXT NOT NULL REFERENCES t3po_spaces(id) ON DELETE CASCADE, name TEXT NOT NULL, location TEXT NOT NULL, CHECK(owner_space_id <> target_space_id))`;
  yield* sql`CREATE TABLE t3po_space_handoffs (job_id TEXT PRIMARY KEY REFERENCES t3po_tasks(id), source_project_id TEXT NOT NULL, source_space_id TEXT NOT NULL, target_project_id TEXT NOT NULL, target_space_id TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0)`;
});
