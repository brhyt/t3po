import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t3po_external_bindings (
    project_id TEXT PRIMARY KEY, version INTEGER NOT NULL, account_id TEXT NOT NULL,
    host TEXT NOT NULL, repository TEXT NOT NULL, enabled INTEGER NOT NULL, space_id TEXT)`;
  yield* sql`CREATE TABLE t3po_external_operations (
    id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
    request_key TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, digest TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','approved','declined','executing','succeeded','uncertain','blocked')),
    data TEXT NOT NULL, updated_at TEXT NOT NULL,
    UNIQUE(thread_id, run_id, request_key))`;
});
