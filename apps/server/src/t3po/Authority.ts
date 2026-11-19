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
    UNION SELECT project_id AS projectId FROM t3po_channels WHERE 't3po-channel:' || id IN (SELECT thread_id FROM ancestors)
      AND ('t3po-channel:' || id <> ${threadId} OR ${includeLead ? 1 : 0} = 1)
    LIMIT 1`;
  const projectId = projects[0]?.projectId;
  return projectId;
});

const checkSpace = Effect.fn("T3po.checkSpace")(function* (event: OrchestrationV2DomainEvent) {
  const sql = yield* SqlClient.SqlClient;
  const scopeOf = Effect.fn("T3po.threadSpace")(function* (id: string) {
    const rows = yield* sql<{
      projectId: string;
      spaceId: string | null;
    }>`SELECT t.project_id AS projectId, s.space_id AS spaceId FROM orchestration_v2_projection_threads t LEFT JOIN t3po_project_spaces s ON s.project_id = t.project_id WHERE t.thread_id = ${id}`;
    return rows[0];
  });
  if (event.type === "thread.created") {
    const membership = yield* sql<{
      spaceId: string;
    }>`SELECT space_id AS spaceId FROM t3po_project_spaces WHERE project_id = ${event.payload.projectId}`;
    const space = membership[0]?.spaceId ?? null;
    if (
      space &&
      (event.payload.runtimeMode !== "approval-required" ||
        event.payload.linkOrigin ||
        event.payload.delegatedFrom)
    )
      return yield* new T3poError({ operation: "approval" });
    const parentId = event.payload.lineage.parentThreadId;
    if (parentId) {
      const parent = yield* scopeOf(parentId);
      if (parent && parent.projectId !== event.payload.projectId && parent.spaceId !== space)
        return yield* new T3poError({ operation: "space_boundary" });
    }
    if (event.payload.forkedFrom) {
      const configured = yield* sql`SELECT project_id FROM t3po_project_spaces LIMIT 1`;
      if (configured.length && event.payload.forkedFrom.type !== "run")
        return yield* new T3poError({ operation: "space_boundary" });
      const source =
        event.payload.forkedFrom.type === "run"
          ? yield* scopeOf(event.payload.forkedFrom.threadId)
          : undefined;
      if ((space || source?.spaceId) && (!source || source.spaceId !== space))
        return yield* new T3poError({ operation: "approval" });
    }
  } else if (
    event.type === "context-transfer.created" ||
    event.type === "context-transfer.updated"
  ) {
    const source = yield* scopeOf(event.payload.sourceThreadId);
    const target = yield* scopeOf(event.payload.targetThreadId);
    if (source?.spaceId !== target?.spaceId)
      return yield* new T3poError({ operation: "space_boundary" });
  } else if (
    event.type === "thread.runtime-mode-updated" ||
    event.type === "thread.provider-switched"
  ) {
    if (
      (yield* scopeOf(event.threadId))?.spaceId &&
      event.payload.runtimeMode !== "approval-required"
    )
      return yield* new T3poError({ operation: "approval" });
  } else if (event.type === "run.created") {
    const thread = yield* sql<{
      mode: string;
    }>`SELECT t.runtime_mode AS mode FROM orchestration_v2_projection_threads t JOIN t3po_project_spaces s ON s.project_id = t.project_id WHERE t.thread_id = ${event.threadId}`;
    if (thread[0] && thread[0].mode !== "approval-required")
      return yield* new T3poError({ operation: "approval" });
  }
});

// Called only inside the event sink transaction: rejection also rolls back receipts and outbox work.
export const admitRun = Effect.fn("T3po.admitRun")(function* (event: OrchestrationV2DomainEvent) {
  yield* checkSpace(event);
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
