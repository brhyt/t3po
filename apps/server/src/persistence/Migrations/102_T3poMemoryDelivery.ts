import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE t3po_memory_status ADD COLUMN failures INTEGER NOT NULL DEFAULT 0`;
  yield* sql`ALTER TABLE t3po_memory_status ADD COLUMN next_attempt INTEGER NOT NULL DEFAULT 0`;
});
