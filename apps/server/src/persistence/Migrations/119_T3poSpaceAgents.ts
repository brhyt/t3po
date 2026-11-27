import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // MCP servers t3ro adds for agents. A null space is central; secrets live in the secret store.
  yield* sql`CREATE TABLE t3po_mcp_servers (id TEXT PRIMARY KEY, name TEXT NOT NULL, space_id TEXT, transport TEXT NOT NULL, url TEXT, command TEXT, args_json TEXT NOT NULL DEFAULT '[]', secret_name TEXT, has_secret INTEGER NOT NULL DEFAULT 0, shared INTEGER NOT NULL DEFAULT 1)`;
  // A space's choice for a central server; '' is every project in no space. No row follows `shared`.
  yield* sql`CREATE TABLE t3po_space_mcp_choices (space_id TEXT NOT NULL, server_id TEXT NOT NULL, enabled INTEGER NOT NULL, PRIMARY KEY (space_id, server_id))`;
  // A space's own GitHub access and blocked commands; '' is every project in no space.
  yield* sql`CREATE TABLE t3po_space_agents (space_id TEXT PRIMARY KEY, has_github_token INTEGER NOT NULL DEFAULT 0, git_name TEXT, git_email TEXT, blocked_json TEXT NOT NULL DEFAULT '[]')`;
});
