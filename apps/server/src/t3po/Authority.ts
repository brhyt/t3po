import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import {
  T3poWorkspace,
  T3poTask,
  T3poError,
  T3RO_DEFAULT_CONCURRENT_JOBS,
  T3RO_DEFAULT_WORK_ACCESS,
  RuntimeMode,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as SpaceConnections from "./SpaceConnections.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

const authorityProject = Effect.fn("T3po.authorityProject")(function* (
  threadId: string,
  includeDirectConversation = false,
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
      AND (json_extract(data, '$.threadId') <> ${threadId} OR ${includeDirectConversation ? 1 : 0} = 1)
    UNION SELECT project_id AS projectId FROM t3po_channels WHERE 't3po-channel:' || id IN (SELECT thread_id FROM ancestors)
      AND ('t3po-channel:' || id <> ${threadId} OR ${includeDirectConversation ? 1 : 0} = 1)
    LIMIT 1`;
  const projectId = projects[0]?.projectId;
  return projectId;
});

const runtimeModeRank: Record<RuntimeMode, number> = {
  "approval-required": 0,
  "auto-accept-edits": 1,
  auto: 2,
  "full-access": 3,
};
const isRuntimeMode = Schema.is(RuntimeMode);
/** Whether the project's job permissions allow `mode`; unset permissions allow T3RO_DEFAULT_WORK_ACCESS. */
const workAccessAllows = Effect.fn("T3po.workAccessAllows")(function* (
  projectId: string,
  mode: string | undefined,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    access: string | null;
  }>`SELECT json_extract(data, '$.workAccess') AS access FROM t3po_leads WHERE project_id = ${projectId}`;
  const stored = rows[0]?.access;
  const access = isRuntimeMode(stored) ? stored : T3RO_DEFAULT_WORK_ACCESS;
  return isRuntimeMode(mode) && runtimeModeRank[mode] <= runtimeModeRank[access];
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
    if (space && (event.payload.linkOrigin || event.payload.delegatedFrom))
      return yield* new T3poError({ operation: "space_boundary" });
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
        return yield* new T3poError({ operation: "space_boundary" });
    }
  } else if (
    event.type === "context-transfer.created" ||
    event.type === "context-transfer.updated"
  ) {
    const source = yield* scopeOf(event.payload.sourceThreadId);
    const target = yield* scopeOf(event.payload.targetThreadId);
    if (source?.spaceId !== target?.spaceId)
      return yield* new T3poError({ operation: "space_boundary" });
  } else if (event.type === "run.created") {
    const jobs = yield* sql<{
      id: string;
    }>`SELECT id FROM t3po_tasks WHERE json_extract(data, '$.threadId') = ${event.threadId}`;
    for (const job of jobs) yield* SpaceConnections.checkHandoff(job.id);
  }
});

const encodeWorkspace = Schema.encodeEffect(Schema.fromJsonString(T3poWorkspace));
const encodeBinding = Schema.encodeEffect(
  Schema.fromJsonString(
    Schema.Struct({
      cwd: Schema.String,
      worktreePath: Schema.NullOr(Schema.String),
      branch: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodeTask = Schema.decodeEffect(Schema.fromJsonString(T3poTask));

export const checkJobGrants = Effect.fn("T3po.checkJobGrants")(function* (
  threadId: string,
  runId: string,
  providerStart = false,
  binding?: {
    readonly cwd: string;
    readonly worktreePath: string | null;
    readonly branch: string | null;
  },
  messageId?: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const history = yield* sql<{ taskId: string; data: string | null; grantData: string | null }>`
    SELECT a.task_id AS taskId, t.data, g.data AS grantData FROM t3po_grant_admissions a
    LEFT JOIN t3po_tasks t ON t.id = a.task_id
    LEFT JOIN t3po_job_grants g ON g.task_id = a.task_id AND g.version = a.version
    WHERE a.run_id = ${runId}`;
  for (const admission of history) {
    if (!admission.data || !admission.grantData || !(yield* decodeTask(admission.data)).grant)
      return yield* new T3poError({ operation: "grant_invalid" });
  }
  const tasks = yield* sql<{ data: string }>`WITH RECURSIVE ancestors(thread_id) AS (
    SELECT ${threadId} UNION
    SELECT json_extract(t.payload_json, '$.lineage.parentThreadId')
    FROM orchestration_v2_projection_threads t JOIN ancestors a ON t.thread_id = a.thread_id
    WHERE json_extract(t.payload_json, '$.lineage.parentThreadId') IS NOT NULL
  ) SELECT data FROM t3po_tasks WHERE json_extract(data, '$.threadId') IN (SELECT thread_id FROM ancestors)
    OR id IN (SELECT task_id FROM t3po_grant_admissions WHERE run_id = ${runId})`;
  for (const row of tasks) {
    const task = yield* decodeTask(row.data);
    const grant = task.grant;
    if (!grant) continue;
    if (grant.revoked) return yield* new T3poError({ operation: "grant_revoked" });
    if (!Number.isFinite(Date.parse(grant.expiresAt)))
      return yield* new T3poError({ operation: "grant_invalid" });
    if (Date.parse(grant.expiresAt) <= now)
      return yield* new T3poError({ operation: "grant_expired" });
    const spaces = yield* sql<{
      spaceId: string;
    }>`SELECT space_id AS spaceId FROM t3po_project_spaces WHERE project_id = ${task.projectId}`;
    const projects = yield* sql<{
      root: string;
    }>`SELECT workspace_root AS root FROM projection_projects WHERE project_id = ${task.projectId}`;
    const threads = yield* sql<{
      projectId: string;
      remote: number;
      worktreePath: string | null;
      branch: string | null;
    }>`SELECT project_id AS projectId,
      json_extract(payload_json, '$.worktreePath') AS worktreePath,
      json_extract(payload_json, '$.branch') AS branch,
      (json_extract(payload_json, '$.linkOrigin') IS NOT NULL OR json_extract(payload_json, '$.delegatedFrom') IS NOT NULL) AS remote
      FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
    // Local grants do not authorize delegated descendants to choose another workspace.
    if (
      threadId !== task.threadId ||
      threads[0]?.remote ||
      (threads[0] && threads[0].projectId !== task.projectId) ||
      grant.workspaceRoot !== (projects[0]?.root ?? null) ||
      grant.revoked ||
      Date.parse(grant.expiresAt) <= now ||
      grant.briefRevision !== (task.briefRevision ?? 1) ||
      grant.spaceId !== (spaces[0]?.spaceId ?? null) ||
      (yield* encodeWorkspace(grant.workspace)) !==
        (yield* encodeWorkspace(task.workspace ?? { type: "root" }))
    )
      return yield* new T3poError({ operation: "grant_stale" });
    yield* SpaceConnections.checkHandoff(task.id);
    const admissions = yield* sql<{
      version: number;
      binding: string | null;
    }>`SELECT version, binding FROM t3po_grant_admissions WHERE run_id = ${runId} AND task_id = ${task.id}`;
    if (admissions[0]) {
      if (admissions[0].version !== grant.version)
        return yield* new T3poError({ operation: "grant_stale" });
      if (binding) {
        const thread = threads[0];
        if (
          !thread ||
          thread.worktreePath !== binding.worktreePath ||
          thread.branch !== binding.branch ||
          binding.cwd !== (thread.worktreePath ?? projects[0]?.root) ||
          (grant.workspace.type === "root"
            ? thread.worktreePath !== null
            : thread.worktreePath === null)
        )
          return yield* new T3poError({ operation: "grant_invalid" });
        const encoded = yield* encodeBinding(binding);
        const priorBindings = yield* sql<{
          binding: string;
        }>`SELECT binding FROM t3po_grant_admissions
          WHERE task_id = ${task.id} AND version = ${grant.version} AND binding IS NOT NULL`;
        if (priorBindings.some((prior) => prior.binding !== encoded))
          return yield* new T3poError({ operation: "grant_stale" });
        if (admissions[0].binding !== null && admissions[0].binding !== encoded)
          return yield* new T3poError({ operation: "grant_stale" });
        yield* sql`UPDATE t3po_grant_admissions SET binding = ${encoded}
          WHERE run_id = ${runId} AND task_id = ${task.id} AND binding IS NULL`;
      }
      continue;
    }
    const prompts = yield* sql<{ revision: number }>`SELECT revision FROM t3po_launch_revisions
      WHERE message_id = ${messageId ?? ""} AND task_id = ${task.id}`;
    if (prompts[0] && prompts[0].revision !== grant.briefRevision)
      return yield* new T3poError({ operation: "grant_stale" });
    if (providerStart) return yield* new T3poError({ operation: "grant_stale" });
    const usage = yield* sql<{
      used: number;
      active: number;
    }>`SELECT COALESCE(sum(CASE WHEN g.version = ${grant.version} THEN 1 ELSE 0 END), 0) AS used,
      COALESCE(sum(a.active), 0) AS active FROM t3po_grant_admissions g
      LEFT JOIN t3po_admissions a ON a.run_id = g.run_id
      WHERE g.task_id = ${task.id}`;
    if ((usage[0]?.used ?? 0) >= grant.maxRuns || (usage[0]?.active ?? 0) >= grant.maxConcurrent)
      return yield* new T3poError({ operation: "grant_exhausted" });
    yield* sql`INSERT INTO t3po_grant_admissions (run_id, task_id, version) VALUES (${runId}, ${task.id}, ${grant.version})`;
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
    if (event.payload.runtimeMode === "approval-required") return;
    const governed = yield* authorityProject(event.threadId);
    if (governed && !(yield* workAccessAllows(governed, event.payload.runtimeMode)))
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
  const workerProjectId = yield* authorityProject(event.threadId);
  const projectId =
    workerProjectId ??
    (event.payload.delegatedCompletion !== undefined
      ? yield* authorityProject(event.threadId, true)
      : undefined);
  if (!projectId) return;
  yield* checkJobGrants(
    event.threadId,
    event.payload.id,
    false,
    undefined,
    event.payload.userMessageId,
  );
  if (workerProjectId) {
    const thread = yield* sql<{
      mode: string;
    }>`SELECT json_extract(payload_json, '$.runtimeMode') AS mode FROM orchestration_v2_projection_threads WHERE thread_id = ${event.threadId}`;
    if (!(yield* workAccessAllows(workerProjectId, thread[0]?.mode)))
      return yield* new T3poError({ operation: "approval" });
  }
  // Jobs run until they finish; a project only limits how many run at once.
  const slots = yield* sql<{ open: number }>`SELECT
    COALESCE((SELECT max_concurrent FROM t3po_budgets WHERE project_id = ${projectId}), ${T3RO_DEFAULT_CONCURRENT_JOBS})
    > (SELECT count(*) FROM t3po_admissions WHERE project_id = ${projectId} AND active = 1) AS open`;
  if (!slots[0]?.open) return yield* new T3poError({ operation: "budget" });
  yield* sql`INSERT INTO t3po_admissions (run_id, project_id, active) VALUES (${event.payload.id}, ${projectId}, ${active ? 1 : 0})`;
});
