import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import {
  T3poTask,
  T3poError,
  type OrchestrationV2ThreadShell,
  type T3poResult,
} from "@t3tools/contracts";
import type {
  AttentionItem,
  AttentionPage,
  AttentionQuery,
} from "../../../../packages/contracts/src/t3poAttention.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Store from "./Store.ts";

const decodeTask = Schema.decodeEffect(Schema.fromJsonString(T3poTask));

export function taskAttention(
  task: T3poTask,
  shell: Pick<
    OrchestrationV2ThreadShell,
    | "latestRunId"
    | "pendingRuntimeRequest"
    | "hasActionableProposedPlan"
    | "activeRunId"
    | "pendingBackgroundTasks"
    | "status"
  > | null,
  result: T3poResult | null,
): AttentionItem[] {
  if (task.archived) return [];
  const runId = shell?.latestRunId ?? result?.runId ?? null;
  const reasons: AttentionItem["reason"][] = [];
  if (shell?.pendingRuntimeRequest) reasons.push("request");
  if (shell?.hasActionableProposedPlan) reasons.push("plan");
  const active =
    shell &&
    (shell.activeRunId ||
      (shell.pendingBackgroundTasks?.length ?? 0) > 0 ||
      ["preparing", "queued", "starting", "running", "waiting"].includes(shell.status));
  if (
    !active &&
    shell &&
    ["failed", "interrupted", "cancelled", "rolled_back"].includes(shell.status)
  )
    reasons.push("failed");
  if (
    !active &&
    result &&
    result.runId === runId &&
    (!task.completed || task.reviewedRunId !== runId) &&
    (!shell || shell.status === "completed")
  )
    reasons.push("review");
  return [...new Set(reasons)].map((reason) => ({
    key: JSON.stringify([
      task.id,
      reason,
      runId,
      reason === "request" ? shell?.pendingRuntimeRequest?.id : null,
    ]),
    taskId: task.id,
    threadId: task.threadId,
    title: task.title,
    runId,
    reason,
  }));
}
export class Attention extends Context.Service<
  Attention,
  {
    readonly list: (input: AttentionQuery) => Effect.Effect<AttentionPage, T3poError>;
  }
>()("t3/t3po/Attention") {}
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* Threads.ThreadManagementService;
  const store = yield* Store.Store;
  const list = Effect.fn("Attention.list")(
    function* (input: AttentionQuery) {
      const projectItems: AttentionPage["projectItems"][number][] = [];
      if (input.before === undefined) {
        const budgets = yield* sql<{
          maxRuns: number;
          maxConcurrent: number;
          usedRuns: number;
        }>`SELECT max_runs AS maxRuns, max_concurrent AS maxConcurrent,
          (SELECT count(*) FROM t3po_admissions WHERE project_id = ${input.projectId}) AS usedRuns
          FROM t3po_budgets WHERE project_id = ${input.projectId}`;
        const budget = budgets[0];
        if (budget && (budget.usedRuns >= budget.maxRuns || budget.maxConcurrent === 0)) {
          projectItems.push({
            key: `project-budget:${input.projectId}`,
            projectId: input.projectId,
            reason: "budget",
            blockedBy: budget.usedRuns >= budget.maxRuns ? "run_limit" : "concurrency_disabled",
            usedRuns: budget.usedRuns,
            maxRuns: budget.maxRuns,
          });
        }
        const deliveries = yield* sql<{
          pendingCount: number;
        }>`SELECT (SELECT count(*) FROM t3po_memory_events e
          WHERE e.project_id = ${input.projectId} AND e.synced_at IS NULL
          AND e.superseded_by IS NULL AND e.kind != 'local_correction') AS pendingCount
          FROM t3po_memory_status WHERE project_id = ${input.projectId} AND failures > 0`;
        const delivery = deliveries[0];
        if (delivery && delivery.pendingCount > 0) {
          projectItems.push({
            key: `project-memory:${input.projectId}`,
            projectId: input.projectId,
            reason: "memory_delivery",
            pendingCount: delivery.pendingCount,
          });
        }
      }
      // Bound projection reads even when most tasks have no current attention.
      const rows = yield* sql<{
        cursor: number;
        data: string;
      }>`SELECT rowid AS cursor, data FROM t3po_tasks WHERE project_id = ${input.projectId} AND COALESCE(json_extract(data, '$.archived'), 0) = 0 ${input.before === undefined ? sql`` : sql`AND rowid < ${input.before}`} ORDER BY rowid DESC LIMIT 51`;
      const items = yield* Effect.forEach(
        rows.slice(0, 50),
        (row) =>
          Effect.gen(function* () {
            const task = yield* decodeTask(row.data);
            const shell = yield* threads.getThreadShell(task.threadId);
            const result =
              (yield* store.results({ projectId: input.projectId, taskId: task.id }, 1))
                .results[0] ?? null;
            return taskAttention(task, shell, result);
          }),
        { concurrency: 8 },
      );
      return {
        projectItems,
        items: items.flat(),
        nextCursor: rows.length > 50 ? rows[49]!.cursor : null,
      };
    },
    Effect.mapError((cause) => new T3poError({ operation: "read", cause })),
  );
  return Attention.of({ list });
});
export const layer = Layer.effect(Attention, make);
