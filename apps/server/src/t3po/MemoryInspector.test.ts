import * as Changes from "./Changes.ts";
import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Inspector from "./MemoryInspector.ts";
import { T3poMemoryError } from "../../../../packages/contracts/src/t3poMemory.ts";

const projectId = ProjectId.make("allowed");
const access = Layer.succeed(Inspector.MemoryAccess, {
  authorize: (project) =>
    project === projectId
      ? Effect.succeed("account-a")
      : Effect.fail(new T3poMemoryError({ reason: "forbidden" })),
});
const services = Inspector.layer.pipe(
  Layer.provide(access),
  Layer.provide(Changes.layer),
  Layer.provide(Inspector.deliveryLockLayer),
);
const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (let n = 0; n < 23; n++)
    yield* sql`INSERT INTO t3po_memory_events (event_id, project_id, kind, text, occurred_at, synced_at) VALUES (${`e${n}`}, ${projectId}, 'accepted_result', ${`text${n}`}, '2026-11-18T00:00:00Z', ${n === 22 ? "2026-11-18T01:00:00Z" : null})`;
});
it.effect(
  "pages offline without mistaking receipts for processing and rejects unauthorized projects",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const service = yield* Inspector.MemoryInspector;
      const page = yield* service.list({ projectId });
      expect(page.entries).toHaveLength(20);
      expect(page.entries[0]).toMatchObject({
        stage: "receipt_accepted",
        honchoDelivery: "unknown",
        honchoProcessing: "unknown",
      });
      const next = yield* service.list({ projectId, before: page.nextCursor! });
      expect(next.entries.map((e) => e.id)).toEqual(["e2", "e1", "e0"]);
      expect(next.nextCursor).toBeNull();
      expect(
        yield* service.list({ projectId: ProjectId.make("other") }).pipe(Effect.flip),
      ).toMatchObject({ reason: "forbidden" });
      expect(
        yield* service
          .correct({
            projectId: ProjectId.make("other"),
            operationId: "forbidden",
            targetId: "e0",
            expectedRevision: 0,
            text: "bad",
          })
          .pipe(Effect.flip),
      ).toMatchObject({ reason: "forbidden" });
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
it.effect(
  "persists atomic supersession, rejects stale edits and replays only identical operations",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const service = yield* Inspector.MemoryInspector;
      const input = {
        projectId,
        operationId: "correction-1",
        targetId: "e22",
        expectedRevision: 0,
        text: "Corrected fact",
      };
      expect(yield* service.correct(input)).toBe(input.operationId);
      // Reconstructing the service proves retry state is durable rather than closure state.
      expect(
        yield* Effect.gen(function* () {
          return yield* (yield* Inspector.MemoryInspector).correct(input);
        }).pipe(Effect.provide(services)),
      ).toBe(input.operationId);
      expect(
        yield* service.correct({ ...input, text: "Different" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "conflict" });
      expect(
        yield* service.correct({ ...input, operationId: "stale" }).pipe(Effect.flip),
      ).toMatchObject({ reason: "stale" });
      const page = yield* service.list({ projectId });
      expect(page.entries[0]).toMatchObject({
        id: input.operationId,
        targetId: "e22",
        source: "user_correction:account-a",
        stage: "local_only",
      });
      expect(page.entries[1]).toMatchObject({
        id: "e22",
        revision: 1,
        supersededBy: input.operationId,
      });
      const sql = yield* SqlClient.SqlClient;
      const count = yield* sql<{
        n: number;
      }>`SELECT count(*) AS n FROM t3po_memory_events WHERE kind = 'local_correction'`;
      expect(count[0]?.n).toBe(1);
      yield* service.correct({
        ...input,
        operationId: "correction-2",
        targetId: input.operationId,
        text: "Final fact",
      });
      const active = yield* sql<{
        text: string;
      }>`SELECT text FROM t3po_memory_events WHERE project_id = ${projectId} AND superseded_by IS NULL ORDER BY sequence DESC LIMIT 1`;
      expect(active[0]?.text).toBe("Final fact");
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect(
  "rolls back the new operation if supersession fails and serializes competing corrections",
  () =>
    Effect.gen(function* () {
      yield* setup;
      const service = yield* Inspector.MemoryInspector;
      const sql = yield* SqlClient.SqlClient;
      const input = {
        projectId,
        operationId: "atomic",
        targetId: "e0",
        expectedRevision: 0,
        text: "new",
      };
      yield* sql`CREATE TRIGGER reject_supersession BEFORE UPDATE ON t3po_memory_events BEGIN SELECT RAISE(ABORT, 'test failure'); END`;
      expect(yield* service.correct(input).pipe(Effect.flip)).toMatchObject({ reason: "storage" });
      expect(
        yield* sql`SELECT event_id FROM t3po_memory_events WHERE event_id = 'atomic'`,
      ).toHaveLength(0);
      yield* sql`DROP TRIGGER reject_supersession`;
      const results = yield* Effect.all(
        [
          service.correct(input).pipe(Effect.result),
          service.correct({ ...input, operationId: "competitor" }).pipe(Effect.result),
        ],
        { concurrency: 2 },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(
        yield* sql`SELECT event_id FROM t3po_memory_events WHERE kind = 'local_correction'`,
      ).toHaveLength(1);
    }).pipe(Effect.provide(services.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);
