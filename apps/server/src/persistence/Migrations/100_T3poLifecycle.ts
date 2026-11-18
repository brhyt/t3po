import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.archived', json('false'), '$.workspace', json('{"type":"root"}'))`;
  yield* sql`UPDATE t3po_channels SET data = json_set(data, '$.archived', json('false'))`;
  yield* sql`UPDATE t3po_tasks SET launch = json_set(launch, '$.title', json_extract(data, '$.title'), '$.brief', json_extract(data, '$.brief'), '$.workspaceStrategy', json('{"type":"root"}')) WHERE launch IS NOT NULL`;
  yield* sql`CREATE INDEX t3po_tasks_board ON t3po_tasks(project_id, COALESCE(json_extract(data, '$.archived'), 0), json_extract(data, '$.completed'))`;
  yield* sql`CREATE INDEX t3po_tasks_channel ON t3po_tasks(project_id, json_extract(data, '$.channelId'), COALESCE(json_extract(data, '$.archived'), 0), json_extract(data, '$.completed'))`;
  yield* sql`CREATE INDEX t3po_tasks_global_board ON t3po_tasks(COALESCE(json_extract(data, '$.archived'), 0), json_extract(data, '$.completed'))`;
  yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.completed', json('false'), '$.reviewedRunId', NULL) WHERE json_extract(data, '$.completed') = 1 AND (SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = json_extract(t3po_tasks.data, '$.threadId') ORDER BY ordinal DESC LIMIT 1) IS NOT json_extract(data, '$.reviewedRunId')`;
  yield* sql`CREATE INDEX t3po_tasks_global_thread ON t3po_tasks(json_extract(data, '$.threadId'))`;
});
