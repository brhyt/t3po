import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A space's own choice for a tool; '' is every project in no space. No row follows Settings → Tools.
  yield* sql`CREATE TABLE t3po_space_tools (space_id TEXT NOT NULL, tool TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY (space_id, tool))`;
});
