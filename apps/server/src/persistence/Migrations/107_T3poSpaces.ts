import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t3po_spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL)`;
  yield* sql`INSERT INTO t3po_spaces (id, name) VALUES ('personal', 'Personal'), ('business', 'Business')`;
  yield* sql`CREATE TABLE t3po_project_spaces (project_id TEXT PRIMARY KEY, space_id TEXT NOT NULL REFERENCES t3po_spaces(id))`;
  yield* sql`CREATE INDEX t3po_project_space ON t3po_project_spaces(space_id)`;
  yield* sql`CREATE TABLE t3po_conversations (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, channel_id TEXT NOT NULL REFERENCES t3po_channels(id))`;
  yield* sql`CREATE INDEX t3po_conversation_channel ON t3po_conversations(project_id, channel_id)`;
});
