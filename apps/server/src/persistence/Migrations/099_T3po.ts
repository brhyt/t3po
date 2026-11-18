import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE t3po_leads (project_id TEXT PRIMARY KEY, data TEXT NOT NULL)`;
  yield* sql`CREATE TABLE t3po_channels (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL)`;
  yield* sql`CREATE TABLE t3po_tasks (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, data TEXT NOT NULL, launch TEXT)`;
  yield* sql`CREATE INDEX t3po_tasks_thread ON t3po_tasks(project_id, json_extract(data, '$.threadId'))`;
  yield* sql`CREATE INDEX t3po_tasks_project ON t3po_tasks(project_id)`;
  yield* sql`CREATE INDEX t3po_channels_project ON t3po_channels(project_id)`;
});
