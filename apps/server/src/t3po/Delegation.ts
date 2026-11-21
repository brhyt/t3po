import {
  ProjectId,
  T3poTask,
  T3poError,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
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
  if (event.type === "run.updated" || event.type === "subagent.updated") {
    const latest = yield* sql<{
      id: string;
      status: string;
    }>`SELECT run_id AS id, status FROM orchestration_v2_projection_runs WHERE thread_id = ${event.threadId} ORDER BY ordinal DESC LIMIT 1`;
    const children =
      yield* sql`SELECT subagent_id FROM orchestration_v2_projection_subagents WHERE thread_id = ${event.threadId} AND status IN ('pending', 'running', 'waiting') LIMIT 1`;
    if (latest[0]?.status === "completed" && !children.length)
      yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.completed', json('true'), '$.reviewedRunId', ${latest[0].id}) WHERE json_extract(data, '$.threadId') = ${event.threadId} AND json_extract(data, '$.reviewRequired') = 0 AND json_extract(data, '$.completionPolicy') IS NULL`;
  }
  if (event.type === "run.created") {
    const archived =
      yield* sql`SELECT t.id FROM t3po_tasks t LEFT JOIN t3po_workstreams w ON w.id = json_extract(t.data, '$.workstreamId') LEFT JOIN t3po_channels c ON c.id = json_extract(t.data, '$.channelId') WHERE json_extract(t.data, '$.threadId') = ${event.threadId} AND (json_extract(t.data, '$.archived') = 1 OR json_extract(w.data, '$.state') = 'archived' OR json_extract(c.data, '$.archived') = 1) LIMIT 1`;
    if (archived.length) return yield* new T3poError({ operation: "invalid" });
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
    channelId: string | null;
    workstreamId: string | null;
    reviewRequired: number | null;
  }>`SELECT project_id AS projectId, NULL AS channelId, NULL AS workstreamId, NULL AS reviewRequired FROM t3po_leads WHERE json_extract(data, '$.threadId') = ${event.threadId}
    UNION SELECT project_id AS projectId, json_extract(data, '$.channelId') AS channelId, json_extract(data, '$.workstreamId') AS workstreamId, json_extract(data, '$.reviewRequired') AS reviewRequired FROM t3po_tasks WHERE json_extract(data, '$.threadId') = ${event.threadId}
    UNION SELECT project_id AS projectId, id AS channelId, NULL AS workstreamId, NULL AS reviewRequired FROM t3po_channels WHERE 't3po-channel:' || id = ${event.threadId} LIMIT 1`;
  if (!owners[0]) return;
  const projectId = ProjectId.make(owners[0].projectId);
  const task: T3poTask = {
    id: `delegation:${event.payload.id}`,
    projectId,
    channelId: owners[0].channelId,
    ...(owners[0].workstreamId
      ? { workstreamId: owners[0].workstreamId, reviewRequired: owners[0].reviewRequired === 1 }
      : {}),
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
