import { ProjectId, T3poTask, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

// Runs inside the event sink transaction, before the child can start or a receipt can replay.
const encodeTask = Schema.encodeEffect(Schema.fromJsonString(T3poTask));

export const recordDelegation = Effect.fn("T3po.recordDelegation")(function* (
  event: OrchestrationV2DomainEvent,
) {
  const sql = yield* SqlClient.SqlClient;
  if (event.type === "run.created") {
    yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.completed', json('false'), '$.reviewedRunId', NULL, '$.archived', json('false')) WHERE json_extract(data, '$.threadId') = ${event.threadId}`;
    return;
  }
  if (
    event.type !== "subagent.updated" ||
    event.payload.origin !== "app_owned" ||
    event.payload.childThreadId === null
  )
    return;
  const owners = yield* sql<{
    projectId: string;
  }>`SELECT project_id AS projectId FROM t3po_leads WHERE json_extract(data, '$.threadId') = ${event.threadId}
    UNION SELECT project_id AS projectId FROM t3po_tasks WHERE json_extract(data, '$.threadId') = ${event.threadId} LIMIT 1`;
  if (!owners[0]) return;
  const projectId = ProjectId.make(owners[0].projectId);
  const task: T3poTask = {
    id: `delegation:${event.payload.id}`,
    projectId,
    channelId: null,
    title: (event.payload.title?.trim() || event.payload.prompt.trim() || "Delegated task").slice(
      0,
      200,
    ),
    brief: (event.payload.prompt.trim() || "See the execution for the full assignment.").slice(
      0,
      12000,
    ),
    threadId: event.payload.childThreadId,
    completed: false,
    archived: false,
    reviewedRunId: null,
    createdAt: DateTime.formatIso(event.payload.startedAt ?? event.payload.updatedAt),
  };
  const encoded = yield* encodeTask(task);
  yield* sql`INSERT INTO t3po_tasks (id, project_id, data) VALUES (${task.id}, ${projectId}, ${encoded}) ON CONFLICT(id) DO NOTHING`;
});
