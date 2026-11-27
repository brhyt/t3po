import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The most a space's agents may run with; '' is every project in no space. No row is no limit.
  yield* sql`CREATE TABLE t3po_space_limits (space_id TEXT PRIMARY KEY, max_runtime_mode TEXT NOT NULL)`;
  // Pull request and issue tools were blocked in every space; keep that until someone turns them on.
  const spaced = yield* sql`SELECT project_id FROM t3po_project_spaces LIMIT 1`;
  if (!spaced.length) return;
  for (const tool of ["pull-requests", "issues"]) {
    yield* sql`INSERT OR IGNORE INTO t3po_space_tools (space_id, tool, enabled) SELECT id, ${tool}, 0 FROM t3po_spaces`;
    yield* sql`INSERT OR IGNORE INTO t3po_space_tools (space_id, tool, enabled) VALUES ('', ${tool}, 0)`;
  }
});
