import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // No source foreign keys: versions survive execution and workspace deletion.
  yield* sql`CREATE TABLE t3po_artifact_versions (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, task_id TEXT NOT NULL, data TEXT NOT NULL)`;
  yield* sql`CREATE INDEX t3po_artifact_pages ON t3po_artifact_versions(project_id, task_id, sequence)`;
  yield* sql`CREATE TABLE t3po_artifact_files (version_id TEXT NOT NULL REFERENCES t3po_artifact_versions(id), path TEXT NOT NULL, sha256 TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(version_id, path))`;
});
