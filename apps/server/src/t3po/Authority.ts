import { T3poError, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const authorityProject = Effect.fn("T3po.authorityProject")(function* (
  threadId: string,
  includeLead = false,
) {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* sql<{ projectId: string }>`WITH RECURSIVE ancestors(thread_id) AS (
    SELECT ${threadId}
    UNION
    SELECT json_extract(t.payload_json, '$.lineage.parentThreadId')
    FROM orchestration_v2_projection_threads t JOIN ancestors a ON t.thread_id = a.thread_id
    WHERE json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL
  ) SELECT project_id AS projectId FROM t3po_tasks WHERE json_extract(data, '$.threadId') IN (SELECT thread_id FROM ancestors)
    UNION SELECT project_id AS projectId FROM t3po_leads WHERE json_extract(data, '$.threadId') IN (SELECT thread_id FROM ancestors)
      AND (json_extract(data, '$.threadId') <> ${threadId} OR ${includeLead ? 1 : 0} = 1)
    LIMIT 1`;
  const projectId = projects[0]?.projectId;
  return projectId;
});

// Called only inside the event sink transaction: rejection also rolls back receipts and outbox work.
export const admitRun = Effect.fn("T3po.admitRun")(function* (event: OrchestrationV2DomainEvent) {
  if (
    event.type === "thread.runtime-mode-updated" ||
    event.type === "thread.created" ||
    event.type === "thread.provider-switched"
  ) {
    if (
      event.payload.runtimeMode !== "approval-required" &&
      (yield* authorityProject(event.threadId, true))
    )
      return yield* new T3poError({ operation: "approval" });
    return;
  }
  if (event.type !== "run.created" && event.type !== "run.updated") return;
  const sql = yield* SqlClient.SqlClient;
  const active = ["preparing", "queued", "starting", "running", "waiting"].includes(
    event.payload.status,
  );
  const previous = yield* sql<{
    active: number;
  }>`SELECT active FROM t3po_admissions WHERE run_id = ${event.payload.id}`;
  if (previous[0]) {
    // A terminal run cannot regain a slot without a fresh admission decision.
    if (active && previous[0].active === 0) return yield* new T3poError({ operation: "budget" });
    yield* sql`UPDATE t3po_admissions SET active = ${active ? 1 : 0} WHERE run_id = ${event.payload.id}`;
    return;
  }
  if (event.type !== "run.created") return;
  const projectId = yield* authorityProject(event.threadId, true);
  if (!projectId) return;
  const thread = yield* sql<{
    mode: string;
  }>`SELECT json_extract(payload_json, '$.runtimeMode') AS mode FROM orchestration_v2_projection_threads WHERE thread_id = ${event.threadId}`;
  if (thread[0]?.mode !== "approval-required")
    return yield* new T3poError({ operation: "approval" });
  if (!(yield* authorityProject(event.threadId, event.payload.delegatedCompletion !== undefined)))
    return;
  const budget = yield* sql`SELECT project_id FROM t3po_budgets b WHERE project_id = ${projectId}
    AND max_runs > (SELECT count(*) FROM t3po_admissions WHERE project_id = b.project_id)
    AND max_concurrent > (SELECT count(*) FROM t3po_admissions WHERE project_id = b.project_id AND active = 1)`;
  if (!budget.length) return yield* new T3poError({ operation: "budget" });
  yield* sql`INSERT INTO t3po_admissions (run_id, project_id, active) VALUES (${event.payload.id}, ${projectId}, ${active ? 1 : 0})`;
});
