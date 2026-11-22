// @effect-diagnostics nodeBuiltinImport:off -- Operation digests use synchronous SHA-256 inside the existing SQLite transaction.
import * as NodeCrypto from "node:crypto";
import { T3poTask, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Authority from "./Authority.ts";

export class ExternalActionError extends Schema.TaggedError<ExternalActionError>()(
  "ExternalActionError",
  {
    reason: Schema.Literals([
      "missing",
      "conflict",
      "binding",
      "identity",
      "authority",
      "decision",
    ]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message() {
    return `External action rejected: ${this.reason}.`;
  }
}

const WorkspaceBinding = Schema.Struct({
  cwd: Schema.String,
  worktreePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
});
const OperationData = Schema.Struct({
  id: Schema.String,
  requestId: Schema.String,
  nodeId: Schema.String,
  threadId: Schema.String,
  runId: Schema.String,
  attemptId: Schema.String,
  providerSessionId: Schema.String,
  taskId: Schema.String,
  projectId: Schema.String,
  spaceId: Schema.NullOr(Schema.String),
  grantVersion: Schema.Number,
  briefRevision: Schema.Number,
  bindingVersion: Schema.Number,
  workspace: WorkspaceBinding,
  accountId: Schema.String,
  host: Schema.String,
  repository: Schema.String,
  number: Schema.Number,
  prNodeId: Schema.String,
  requestKey: Schema.String,
  digest: Schema.String,
  createdAt: Schema.String,
});
export type ExternalAction = typeof OperationData.Type & {
  readonly state:
    | "pending"
    | "approved"
    | "declined"
    | "executing"
    | "succeeded"
    | "uncertain"
    | "blocked";
};
const encodeData = Schema.encodeEffect(Schema.fromJsonString(OperationData));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeData = Schema.decodeEffect(Schema.fromJsonString(OperationData));
const decodeTask = Schema.decodeEffect(Schema.fromJsonString(T3poTask));
const decodeWorkspace = Schema.decodeEffect(Schema.fromJsonString(WorkspaceBinding));

export const get = Effect.fn("ExternalActionStore.get")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    data: string;
    state: ExternalAction["state"];
  }>`SELECT data, state FROM t3po_external_operations WHERE id = ${id}`;
  const row = rows[0];
  if (!row) return yield* new ExternalActionError({ reason: "missing" });
  return { ...(yield* decodeData(row.data)), state: row.state } satisfies ExternalAction;
});

const getBinding = Effect.fn("ExternalActionStore.getBinding")(function* (projectId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    projectId: string;
    version: number;
    accountId: string;
    host: string;
    repository: string;
    enabled: number;
    spaceId: string | null;
  }>`SELECT project_id AS projectId, version, account_id AS accountId, host, repository, enabled, space_id AS spaceId FROM t3po_external_bindings WHERE project_id = ${projectId}`;
  return rows[0] ? { ...rows[0], enabled: rows[0].enabled === 1 } : null;
});

export const setBinding = Effect.fn("ExternalActionStore.setBinding")(function* (input: {
  readonly projectId: string;
  readonly expectedVersion: number;
  readonly accountId: string;
  readonly host: string;
  readonly repository: string;
  readonly enabled: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (
        input.host !== "github.com" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
        !input.accountId.trim() ||
        input.accountId.length > 200
      )
        return yield* new ExternalActionError({ reason: "binding" });
      const prior = yield* getBinding(input.projectId);
      if ((prior?.version ?? 0) !== input.expectedVersion)
        return yield* new ExternalActionError({ reason: "conflict" });
      const spaces = yield* sql<{
        spaceId: string;
      }>`SELECT space_id AS spaceId FROM t3po_project_spaces WHERE project_id = ${input.projectId}`;
      const spaceId = spaces[0]?.spaceId ?? null;
      yield* sql`INSERT INTO t3po_external_bindings(project_id,version,account_id,host,repository,enabled,space_id)
      VALUES (${input.projectId},${input.expectedVersion + 1},${input.accountId},${input.host},${input.repository.toLowerCase()},${input.enabled ? 1 : 0},${spaceId})
      ON CONFLICT(project_id) DO UPDATE SET version=excluded.version,account_id=excluded.account_id,host=excluded.host,repository=excluded.repository,enabled=excluded.enabled,space_id=excluded.space_id`;
      return yield* getBinding(input.projectId);
    }),
  );
});

export const proposalBinding = Effect.fn("ExternalActionStore.proposalBinding")(function* (
  threadId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    data: string;
  }>`SELECT data FROM t3po_tasks WHERE json_extract(data, '$.threadId') = ${threadId}`;
  if (rows.length !== 1 || !rows[0]) return null;
  const task = yield* decodeTask(rows[0].data);
  if (
    !task.grant ||
    task.archived ||
    task.grant.revoked ||
    Date.parse(task.grant.expiresAt) <= DateTime.toEpochMillis(yield* DateTime.now)
  )
    return null;
  const binding = yield* getBinding(task.projectId);
  const spaces = yield* sql<{
    spaceId: string;
  }>`SELECT space_id AS spaceId FROM t3po_project_spaces WHERE project_id = ${task.projectId}`;
  return binding?.enabled && binding.spaceId === (spaces[0]?.spaceId ?? null) ? binding : null;
});

export const validateBinding = Effect.fn("ExternalActionStore.validateBinding")(function* (
  operation: ExternalAction,
) {
  const sql = yield* SqlClient.SqlClient;
  const binding = yield* getBinding(operation.projectId);
  const spaces = yield* sql<{
    spaceId: string;
  }>`SELECT space_id AS spaceId FROM t3po_project_spaces WHERE project_id = ${operation.projectId}`;
  if (
    !binding ||
    !binding.enabled ||
    binding.spaceId !== (spaces[0]?.spaceId ?? null) ||
    binding.spaceId !== operation.spaceId ||
    binding.version !== operation.bindingVersion ||
    binding.accountId !== operation.accountId ||
    binding.host !== operation.host ||
    binding.repository.toLowerCase() !== operation.repository.toLowerCase()
  )
    return yield* new ExternalActionError({ reason: "binding" });
});

export const validate = Effect.fn("ExternalActionStore.validate")(function* (
  operation: ExternalAction,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* validateBinding(operation);
  const admissions = yield* sql<{
    version: number;
    binding: string | null;
    data: string;
    runStatus: string;
    attemptId: string | null;
  }>`
    SELECT a.version, a.binding, t.data, r.status AS runStatus,
      json_extract(r.payload_json, '$.activeAttemptId') AS attemptId
    FROM t3po_grant_admissions a JOIN t3po_tasks t ON t.id = a.task_id
    JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id
    JOIN orchestration_v2_projection_threads th ON th.thread_id = r.thread_id
    JOIN projection_projects p ON p.project_id = th.project_id
    WHERE th.deleted_at IS NULL AND th.archived_at IS NULL AND p.deleted_at IS NULL AND a.run_id = ${operation.runId} AND a.task_id = ${operation.taskId} AND r.thread_id = ${operation.threadId}`;
  const admitted = admissions[0];
  if (
    !admitted ||
    admitted.version !== operation.grantVersion ||
    admitted.binding === null ||
    admitted.runStatus === "cancelled" ||
    admitted.runStatus === "interrupted" ||
    admitted.runStatus === "failed" ||
    admitted.attemptId !== operation.attemptId
  )
    return yield* new ExternalActionError({ reason: "authority" });
  const task = yield* decodeTask(admitted.data);
  const workspace = yield* decodeWorkspace(admitted.binding);
  if (
    task.archived ||
    task.threadId !== operation.threadId ||
    task.projectId !== operation.projectId ||
    task.grant?.spaceId !== operation.spaceId ||
    task.grant?.briefRevision !== operation.briefRevision ||
    (yield* encodeJson(workspace)) !== (yield* encodeJson(operation.workspace))
  )
    return yield* new ExternalActionError({ reason: "authority" });
  yield* Authority.checkJobGrants(operation.threadId, operation.runId, true, operation.workspace);
});

export const propose = Effect.fn("ExternalActionStore.propose")(function* (input: {
  readonly threadId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly providerSessionId: string;
  readonly requestKey: string;
  readonly accountId: string;
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly prNodeId: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      if (
        input.host !== "github.com" ||
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.repository) ||
        !Number.isSafeInteger(input.number) ||
        input.number <= 0 ||
        !input.prNodeId ||
        input.prNodeId.length > 256 ||
        !input.requestKey ||
        input.requestKey.length > 200
      )
        return yield* new ExternalActionError({ reason: "binding" });
      const rows = yield* sql<{
        taskId: string;
        data: string;
        version: number;
        binding: string | null;
      }>`
      SELECT a.task_id AS taskId, t.data, a.version, a.binding FROM t3po_grant_admissions a
      JOIN t3po_tasks t ON t.id = a.task_id WHERE a.run_id = ${input.runId} AND json_extract(t.data, '$.threadId') = ${input.threadId}`;
      if (rows.length !== 1 || !rows[0]?.binding)
        return yield* new ExternalActionError({ reason: "identity" });
      const admitted = rows[0];
      if (!admitted.binding) return yield* new ExternalActionError({ reason: "identity" });
      const task = yield* decodeTask(admitted.data);
      const bindings = yield* sql<{
        version: number;
      }>`SELECT version FROM t3po_external_bindings WHERE project_id = ${task.projectId}`;
      if (!task.grant || !bindings[0]) return yield* new ExternalActionError({ reason: "binding" });
      const scope = {
        threadId: input.threadId,
        runId: input.runId,
        attemptId: input.attemptId,
        providerSessionId: input.providerSessionId,
        requestKey: input.requestKey,
        accountId: input.accountId,
        host: input.host,
        repository: input.repository.toLowerCase(),
        number: input.number,
        prNodeId: input.prNodeId,
        taskId: task.id,
        projectId: task.projectId,
        spaceId: task.grant.spaceId,
        grantVersion: admitted.version,
        briefRevision: task.grant.briefRevision,
        bindingVersion: bindings[0].version,
        workspace: yield* decodeWorkspace(admitted.binding),
      };
      const digest = NodeCrypto.createHash("sha256")
        .update(
          yield* encodeJson({
            operation: "github.pull-request.convert-to-draft",
            schemaVersion: 1,
            ...scope,
          }),
        )
        .digest("hex");
      const existing = yield* sql<{
        id: string;
        digest: string;
      }>`SELECT id, digest FROM t3po_external_operations WHERE thread_id = ${input.threadId} AND run_id = ${input.runId} AND request_key = ${input.requestKey}`;
      if (existing[0]) {
        if (existing[0].digest !== digest)
          return yield* new ExternalActionError({ reason: "conflict" });
        return yield* get(existing[0].id);
      }
      const id = NodeCrypto.randomUUID();
      const operation: ExternalAction = {
        ...scope,
        id,
        requestId: `external-request:${id}`,
        nodeId: `external-node:${id}`,
        digest,
        state: "pending",
        createdAt: DateTime.formatIso(yield* DateTime.now),
      };
      yield* validate(operation);
      const runs = yield* sql<{
        status: string;
      }>`SELECT status FROM orchestration_v2_projection_runs WHERE run_id = ${input.runId}`;
      if (runs[0]?.status !== "running")
        return yield* new ExternalActionError({ reason: "identity" });
      const { state, ...data } = operation;
      yield* sql`INSERT INTO t3po_external_operations (id, thread_id, run_id, request_key, request_id, digest, state, data, updated_at)
      VALUES (${id}, ${input.threadId}, ${input.runId}, ${input.requestKey}, ${operation.requestId}, ${digest}, ${state}, ${yield* encodeData(data)}, ${operation.createdAt})`;
      return operation;
    }),
  );
});

export const applyDecision = Effect.fn("ExternalActionStore.applyDecision")(function* (
  event: OrchestrationV2DomainEvent,
) {
  if (
    event.type !== "runtime-request.updated" ||
    event.payload.responseCapability.type !== "server_action"
  )
    return;
  const request = event.payload;
  const operation = yield* get(event.payload.responseCapability.operationId);
  if (
    event.threadId !== operation.threadId ||
    request.id !== operation.requestId ||
    request.nodeId !== operation.nodeId
  )
    return yield* new ExternalActionError({ reason: "identity" });
  if (request.status === "pending") return;
  const state =
    request.status === "resolved" && request.decision === "accept" ? "approved" : "declined";
  if (
    request.status === "resolved" &&
    (request.answers !== undefined ||
      request.feedback !== undefined ||
      !["accept", "decline", "cancel"].includes(request.decision ?? ""))
  )
    return yield* new ExternalActionError({ reason: "decision" });
  if (operation.state !== "pending") {
    if (
      operation.state === state ||
      (state === "approved" &&
        ["executing", "succeeded", "uncertain", "blocked"].includes(operation.state))
    )
      return;
    return yield* new ExternalActionError({ reason: "decision" });
  }
  if (state === "approved") yield* validate(operation);
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE t3po_external_operations SET state = ${state}, updated_at = ${DateTime.formatIso(yield* DateTime.now)} WHERE id = ${operation.id} AND state = 'pending'`;
});

export const claim = Effect.fn("ExternalActionStore.claim")(function* (id: string) {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const operation = yield* get(id);
      if (operation.state !== "approved") return false;
      yield* validate(operation);
      yield* sql`UPDATE t3po_external_operations SET state = 'executing', updated_at = ${DateTime.formatIso(yield* DateTime.now)} WHERE id = ${id} AND state = 'approved'`;
      return true;
    }),
  );
});

export const finish = Effect.fn("ExternalActionStore.finish")(function* (
  id: string,
  state: "succeeded" | "uncertain" | "blocked",
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`UPDATE t3po_external_operations SET state = ${state}, updated_at = ${DateTime.formatIso(yield* DateTime.now)} WHERE id = ${id} AND ((state IN ('executing', 'uncertain') AND ${state} != 'blocked') OR (state = 'approved' AND ${state} = 'blocked'))`;
});
