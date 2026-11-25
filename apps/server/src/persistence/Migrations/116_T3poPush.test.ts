import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("treats job outcomes and pending requests from before the upgrade as already sent", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 113 });
    yield* sql`INSERT INTO t3po_task_executions (run_id, task_id, revision, result_json) VALUES ('finished', 'job', 1, '{"status":"completed"}'), ('running', 'job', 2, NULL)`;
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json) VALUES ('waiting', 't', 'n', 'user_input', 'pending', 'now', '{}'), ('answered', 't', 'n', 'user_input', 'resolved', 'now', '{}')`;
    yield* runMigrations({ toMigrationInclusive: 116 });
    expect(yield* sql`SELECT key FROM t3po_push_sent ORDER BY key`).toEqual([
      { key: "job:finished" },
      { key: "request:waiting" },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
