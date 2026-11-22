import * as Changes from "./Changes.ts";
import * as PubSub from "effect/PubSub";
import type { ProjectId } from "@t3tools/contracts";
import {
  T3poMemoryCorrection,
  T3poMemoryQuery,
  T3poMemoryError,
  type T3poMemoryPage,
  type T3poMemoryEntry,
} from "../../../../packages/contracts/src/t3poMemory.ts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

// The adapter must derive the principal from server authentication, never request fields.
export class MemoryAccess extends Context.Service<
  MemoryAccess,
  {
    readonly authorize: (
      projectId: ProjectId,
      write: boolean,
    ) => Effect.Effect<string, T3poMemoryError>;
  }
>()("t3/t3po/MemoryInspector/MemoryAccess") {}
export class MemoryDeliveryLock extends Context.Service<MemoryDeliveryLock, Semaphore.Semaphore>()(
  "t3/t3po/MemoryInspector/MemoryDeliveryLock",
) {}
export const deliveryLockLayer = Layer.effect(MemoryDeliveryLock, Semaphore.make(1));
export class MemoryInspector extends Context.Service<
  MemoryInspector,
  {
    readonly list: (input: T3poMemoryQuery) => Effect.Effect<T3poMemoryPage, T3poMemoryError>;
    readonly correct: (input: T3poMemoryCorrection) => Effect.Effect<string, T3poMemoryError>;
  }
>()("t3/t3po/MemoryInspector") {}
const isMemoryError = Schema.is(T3poMemoryError);
const decodeQuery = Schema.decodeEffect(T3poMemoryQuery);
const decodeCorrection = Schema.decodeEffect(T3poMemoryCorrection);
const normalizeError = (error: unknown) =>
  isMemoryError(error) ? error : new T3poMemoryError({ reason: "storage" });
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const access = yield* MemoryAccess;
  const lock = yield* MemoryDeliveryLock;
  const changes = yield* Changes.Changes;
  const list = Effect.fn("MemoryInspector.list")(function* (raw: T3poMemoryQuery) {
    const input = yield* decodeQuery(raw).pipe(
      Effect.mapError(() => new T3poMemoryError({ reason: "invalid" })),
    );
    yield* access.authorize(input.projectId, false);
    const rows = yield* sql<
      Omit<T3poMemoryEntry, "stage" | "honchoDelivery" | "honchoProcessing"> & { held: number }
    >`SELECT event_id AS id, sequence, kind, source, occurred_at AS occurredAt,
      substr(text, 1, 12000) AS text, revision, superseded_by AS supersededBy, target_id AS targetId, synced_at AS receiptAcceptedAt, delivery_held AS held
      FROM t3po_memory_events_v2 WHERE project_id = ${input.projectId}
      ${input.before === undefined ? sql`` : sql`AND sequence < ${input.before}`}
      ORDER BY sequence DESC LIMIT 21`;
    return {
      entries: rows.slice(0, 20).map((row): T3poMemoryEntry => ({
        ...row,
        stage:
          row.kind === "local_correction"
            ? "local_only"
            : row.receiptAcceptedAt
              ? "receipt_accepted"
              : row.held === 1
                ? "held_locally"
                : "pending_receipt",
        honchoDelivery: "unknown",
        honchoProcessing: "unknown",
      })),
      nextCursor: rows.length > 20 ? rows[19]!.sequence : null,
    };
  }, Effect.mapError(normalizeError));
  const correct = Effect.fn("MemoryInspector.correct")(
    function* (raw: T3poMemoryCorrection) {
      const input = yield* decodeCorrection(raw).pipe(
        Effect.mapError(() => new T3poMemoryError({ reason: "invalid" })),
      );
      const actor = yield* access.authorize(input.projectId, true);
      const source = `user_correction:${actor}`;
      const id = yield* sql.withTransaction(
        Effect.gen(function* () {
          const prior = yield* sql<{
            projectId: string;
            targetId: string | null;
            text: string;
            source: string;
            correctionRevision: number | null;
          }>`SELECT project_id AS projectId, target_id AS targetId, text, source, correction_revision AS correctionRevision FROM t3po_memory_events_v2 WHERE event_id = ${input.operationId}`;
          if (prior[0]) {
            const row = prior[0];
            if (
              row.projectId !== input.projectId ||
              row.targetId !== input.targetId ||
              row.text !== input.text ||
              row.source !== source ||
              row.correctionRevision !== input.expectedRevision
            )
              return yield* new T3poMemoryError({ reason: "conflict" });
            return input.operationId;
          }
          const target = yield* sql<{
            revision: number;
            supersededBy: string | null;
          }>`SELECT revision, superseded_by AS supersededBy FROM t3po_memory_events_v2 WHERE project_id = ${input.projectId} AND event_id = ${input.targetId}`;
          if (!target[0]) return yield* new T3poMemoryError({ reason: "invalid" });
          if (target[0].revision !== input.expectedRevision || target[0].supersededBy !== null)
            return yield* new T3poMemoryError({ reason: "stale" });
          const now = DateTime.formatIso(yield* DateTime.now);
          yield* sql`INSERT INTO t3po_memory_events_v2 (event_id, project_id, kind, text, occurred_at, target_id, source, correction_revision) VALUES (${input.operationId}, ${input.projectId}, 'local_correction', ${input.text}, ${now}, ${input.targetId}, ${source}, ${input.expectedRevision})`;
          yield* sql`UPDATE t3po_memory_events_v2 SET superseded_by = ${input.operationId}, revision = revision + 1 WHERE project_id = ${input.projectId} AND event_id = ${input.targetId}`;
          return input.operationId;
        }),
      );
      yield* PubSub.publish(changes, { projectId: input.projectId, metadata: true });
      return id;
    },
    lock.withPermit,
    Effect.mapError(normalizeError),
  );
  return MemoryInspector.of({ list, correct });
});
export const layer = Layer.effect(MemoryInspector, make);
