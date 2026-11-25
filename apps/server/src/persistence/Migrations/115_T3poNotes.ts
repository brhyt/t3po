import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Keyed by the conversation's thread: t3po-lead:<projectId> or t3po-channel:<channelId>.
  yield* sql`CREATE TABLE t3po_notes (thread_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, channel_id TEXT, text TEXT NOT NULL, revision INTEGER NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL, memory_event_id TEXT)`;
  yield* sql`CREATE INDEX t3po_notes_project ON t3po_notes(project_id, channel_id)`;
});
