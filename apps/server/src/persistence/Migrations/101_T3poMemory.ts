import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t3po_memory_events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, occurred_at TEXT NOT NULL, synced_at TEXT)`;
  yield* sql`CREATE INDEX t3po_memory_pending ON t3po_memory_events(project_id, synced_at, sequence)`;
  yield* sql`CREATE TABLE t3po_memory_status (project_id TEXT PRIMARY KEY, last_sync_at TEXT, available INTEGER NOT NULL DEFAULT 0)`;
  yield* sql`INSERT INTO t3po_memory_events (event_id, project_id, kind, text, occurred_at) SELECT lower(hex(randomblob(16))), project_id, 'project_brief', json_extract(data, '$.brief'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM t3po_leads`;
});
