import { expect, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "../Migrations.ts";

it.effect("holds unsent legacy records without altering receipts or deleting local history", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 112 });
    yield* sql`INSERT INTO t3po_memory_events (event_id, project_id, kind, text, occurred_at, synced_at) VALUES ('unsent', 'project', 'project_brief', 'Pending', '2026-11-22T00:00:00Z', NULL), ('sent', 'project', 'project_brief', 'Acknowledged', '2026-11-22T00:00:00Z', '2026-11-22T01:00:00Z'), ('correction', 'project', 'local_correction', 'Local', '2026-11-22T00:00:00Z', NULL)`;
    yield* runMigrations({ toMigrationInclusive: 113 });
    expect(
      yield* sql`SELECT event_id, text, synced_at, delivery_held FROM t3po_memory_events_v2 ORDER BY sequence`,
    ).toEqual([
      { event_id: "unsent", text: "Pending", synced_at: null, delivery_held: 1 },
      {
        event_id: "sent",
        text: "Acknowledged",
        synced_at: "2026-11-22T01:00:00Z",
        delivery_held: 0,
      },
      { event_id: "correction", text: "Local", synced_at: null, delivery_held: 0 },
    ]);
    yield* sql`INSERT INTO t3po_memory_events_v2 (event_id, project_id, kind, text, occurred_at) VALUES ('new', 'project', 'project_brief', 'New', '2026-11-22T02:00:00Z')`;
    expect(
      yield* sql`SELECT delivery_held FROM t3po_memory_events_v2 WHERE event_id = 'new'`,
    ).toEqual([{ delivery_held: 0 }]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("prevents the previous sender from reading or appending to the upgraded journal", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 112 });
    yield* sql`INSERT INTO t3po_memory_events (event_id, project_id, kind, text, occurred_at) VALUES ('held', 'project', 'project_brief', 'Must remain local', '2026-11-22T00:00:00Z')`;
    yield* runMigrations({ toMigrationInclusive: 113 });
    let delivered = false;
    const legacySend =
      sql`SELECT event_id AS id, kind, text, occurred_at AS occurredAt FROM t3po_memory_events WHERE project_id = 'project' AND synced_at IS NULL AND superseded_by IS NULL AND kind != 'local_correction' ORDER BY sequence LIMIT 20`.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            delivered = true;
          }),
        ),
        Effect.match({ onFailure: () => "blocked", onSuccess: () => "sent" }),
      );
    expect(yield* legacySend).toBe("blocked");
    expect(delivered).toBe(false);
    expect(
      yield* sql`INSERT INTO t3po_memory_events (event_id, project_id, kind, text, occurred_at) VALUES ('legacy-new', 'project', 'project_brief', 'Old sender', '2026-11-22T01:00:00Z')`.pipe(
        Effect.match({ onFailure: () => "blocked", onSuccess: () => "inserted" }),
      ),
    ).toBe("blocked");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
