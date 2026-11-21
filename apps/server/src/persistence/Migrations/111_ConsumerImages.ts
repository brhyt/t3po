import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE consumer_api_grants ADD COLUMN image_request_id TEXT`;
  yield* sql`CREATE TABLE consumer_images (
    image_request_id TEXT PRIMARY KEY,
    reservation_id TEXT NOT NULL UNIQUE,
    namespace TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    run_id TEXT UNIQUE,
    authorization_json TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'unused',
    expires_at INTEGER NOT NULL,
    consumed_at INTEGER,
    prompt TEXT,
    provider_request_id TEXT,
    usage_json TEXT,
    artifact_id TEXT UNIQUE,
    source_json TEXT,
    image_bytes BLOB
  )`;
});
