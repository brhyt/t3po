import { expect, it } from "@effect/vitest";
import {
  SourceControlProviderKind,
  PullRequestOperationError,
  EventId,
  NodeId,
  RuntimeRequestId,
  ThreadId,
  ProjectId,
  type OrchestrationV2DomainEvent,
  type PullRequestSummary,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Store from "./ExternalActionStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Executor from "./ExternalActionExecutor.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const input = {
  threadId: "worker",
  runId: "run",
  attemptId: "attempt",
  providerSessionId: "session",
  requestKey: "request",
  accountId: "github:owner",
  host: "github.com",
  repository: "owner/repo",
  number: 42,
  prNodeId: "PR_exact",
};
const seed = Effect.fn("ExternalActionTest.seed")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const now = DateTime.formatIso(yield* DateTime.now);
  const grant = {
    version: 1,
    briefRevision: 1,
    spaceId: null,
    workspace: { type: "root" },
    route: "local",
    workspaceRoot: "/project",
    expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { hours: 1 })),
    revoked: false,
    maxRuns: 1,
    maxConcurrent: 1,
  };
  const task = {
    id: "task",
    projectId: "project",
    threadId: input.threadId,
    title: "Draft this PR",
    brief: "Work",
    channelId: null,
    completed: false,
    reviewedRunId: null,
    createdAt: now,
    workspace: { type: "root" },
    briefRevision: 1,
    grant,
  };
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('project','Project','/project','[]',${now},${now})`;
  yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id,project_id,title,default_provider,provider_instance_id,runtime_mode,interaction_mode,created_at,updated_at,payload_json) VALUES (${input.threadId},'project','Work','codex','codex','approval-required','default',${now},${now},${yield* encodeJson({ branch: null, worktreePath: null })})`;
  yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id,thread_id,ordinal,provider,provider_instance_id,status,requested_at,payload_json) VALUES (${input.runId},${input.threadId},1,'codex','codex','running',${now},${yield* encodeJson({ activeAttemptId: input.attemptId })})`;
  yield* sql`INSERT INTO t3po_tasks (id,project_id,data) VALUES ('task','project',${yield* encodeJson(task)})`;
  yield* sql`INSERT INTO t3po_job_grants (task_id,version,project_id,data) VALUES ('task',1,'project',${yield* encodeJson(grant)})`;
  yield* sql`INSERT INTO t3po_grant_admissions(run_id,task_id,version,binding) VALUES (${input.runId},'task',1,${yield* encodeJson({ cwd: "/project", worktreePath: null, branch: null })})`;
  yield* Store.setBinding({
    projectId: "project",
    expectedVersion: 0,
    accountId: input.accountId,
    host: input.host,
    repository: input.repository,
    enabled: true,
  });
});
const decision = (
  operation: Store.ExternalAction,
  choice: "accept" | "decline" | "acceptForSession" = "accept",
) =>
  Effect.gen(function* () {
    const now = yield* DateTime.now;
    return {
      id: EventId.make(`decision:${operation.id}`),
      type: "runtime-request.updated",
      threadId: ThreadId.make(operation.threadId),
      occurredAt: now,
      payload: {
        id: RuntimeRequestId.make(operation.requestId),
        nodeId: NodeId.make(operation.nodeId),
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "permission",
        status: "resolved",
        responseCapability: { type: "server_action", operationId: operation.id },
        createdAt: now,
        resolvedAt: now,
        decision: choice,
      },
    } satisfies OrchestrationV2DomainEvent;
  });

it.effect("replays one immutable operation and rejects changed targets and decisions", () =>
  Effect.gen(function* () {
    yield* seed();
    const operation = yield* Store.propose(input);
    expect(yield* Store.propose(input)).toEqual(operation);
    expect(yield* Store.propose({ ...input, number: 43 }).pipe(Effect.flip)).toMatchObject({
      reason: "conflict",
    });
    expect(yield* Store.propose({ ...input, runId: "forged" }).pipe(Effect.flip)).toMatchObject({
      reason: "identity",
    });
    expect(
      yield* Store.propose({ ...input, requestKey: "other", accountId: "other" }).pipe(Effect.flip),
    ).toMatchObject({ reason: "binding" });
    expect(
      yield* Store.applyDecision(yield* decision(operation, "acceptForSession")).pipe(Effect.flip),
    ).toMatchObject({ reason: "decision" });
    yield* Store.applyDecision(yield* decision(operation));
    yield* Store.applyDecision(yield* decision(operation));
    expect((yield* Store.get(operation.id)).state).toBe("approved");
    expect(
      yield* Store.applyDecision(yield* decision(operation, "decline")).pipe(Effect.flip),
    ).toMatchObject({ reason: "decision" });
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect.each([
  "revoked",
  "expired",
  "replaced",
  "brief",
  "workspace",
  "binding",
  "cancelled",
  "attempt",
  "archived",
  "deleted",
] as const)("rechecks %s authority at the mutation claim", (change) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* seed();
    const operation = yield* Store.propose(input);
    yield* Store.applyDecision(yield* decision(operation));
    if (change === "revoked")
      yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.grant.revoked', json('true'))`;
    if (change === "expired")
      yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.grant.expiresAt', '1970-01-01T00:00:00.000Z')`;
    if (change === "replaced")
      yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.grant.version', 2)`;
    if (change === "brief")
      yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.briefRevision', 2)`;
    if (change === "workspace")
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.worktreePath', '/other')`;
    if (change === "binding")
      yield* Store.setBinding({
        projectId: "project",
        expectedVersion: 1,
        accountId: input.accountId,
        host: input.host,
        repository: input.repository,
        enabled: false,
      });
    if (change === "cancelled")
      yield* sql`UPDATE orchestration_v2_projection_runs SET status='cancelled'`;
    if (change === "attempt")
      yield* sql`UPDATE orchestration_v2_projection_runs SET payload_json = json_set(payload_json, '$.activeAttemptId', 'replacement')`;
    if (change === "archived")
      yield* sql`UPDATE orchestration_v2_projection_threads SET archived_at = '2026-01-01T00:00:00.000Z'`;
    if (change === "deleted") yield* sql`DELETE FROM t3po_job_grants`;
    expect(yield* Store.claim(operation.id).pipe(Effect.isFailure)).toBe(true);
    expect((yield* Store.get(operation.id)).state).toBe("approved");
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect("one claimant wins and declining creates no execution", () =>
  Effect.gen(function* () {
    yield* seed();
    const operation = yield* Store.propose(input);
    yield* Store.applyDecision(yield* decision(operation));
    expect(
      yield* Effect.all([Store.claim(operation.id), Store.claim(operation.id)], {
        concurrency: "unbounded",
      }),
    ).toEqual([true, false]);
    const declined = yield* Store.propose({ ...input, requestKey: "declined" });
    yield* Store.applyDecision(yield* decision(declined, "decline"));
    expect(yield* Store.claim(declined.id)).toBe(false);
  }).pipe(Effect.provide(Sqlite.layerMemory)),
);

it.effect.each([
  "draft",
  "ready",
  "unreadable",
  "already-draft",
  "restart",
  "revoked",
  "preflight-revoked",
] as const)("reconciles lost mutation response as %s without another mutation", (outcome) => {
  let writes = 0;
  let draft = outcome === "already-draft" || outcome === "restart";
  let reads = 0;
  let revokeDuringPreflight: Effect.Effect<void> = Effect.void;
  const summary = (): PullRequestSummary => ({
    provider: SourceControlProviderKind.make("github"),
    projectId: ProjectId.make("project"),
    repository: "owner/repo",
    number: 42,
    title: "PR",
    url: "https://github.com/owner/repo/pull/42",
    state: "open",
    isDraft: draft,
    headBranch: "feature",
    baseBranch: "main",
    updatedAt: "2026-01-01T00:00:00.000Z",
  });
  const external = Executor.layer.pipe(
    Layer.provide(
      Layer.mock(PullRequests.PullRequestService)({
        draftTarget: () =>
          Effect.gen(function* () {
            reads++;
            if (outcome === "preflight-revoked") yield* revokeDuringPreflight;
            if (writes && outcome === "unreadable")
              return yield* new PullRequestOperationError({
                operation: "test",
                detail: "Unavailable",
              });
            return { nodeId: "PR_exact", summary: summary() };
          }),
        runAction: (action) =>
          Effect.gen(function* () {
            expect(action.expectedDraftNodeId).toBe("PR_exact");
            expect(action.expectedAccountId).toBe(input.accountId);
            const permitted = yield* action.beforeMutation!;
            if (outcome === "preflight-revoked") {
              expect(permitted).toBe(false);
              return yield* new PullRequestOperationError({ operation: "test", detail: "Revoked" });
            }
            expect(permitted).toBe(true);
            writes++;
            draft = outcome === "draft";
            return yield* new PullRequestOperationError({
              operation: "test",
              detail: "Lost response",
            });
          }),
      }),
    ),
    Layer.provide(
      EventSink.layer.pipe(Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer))),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return Effect.gen(function* () {
    yield* seed();
    const database = yield* SqlClient.SqlClient;
    revokeDuringPreflight =
      database`UPDATE t3po_tasks SET data = json_set(data, '$.grant.revoked', json('true'))`.pipe(
        Effect.orDie,
        Effect.asVoid,
      );
    const operation = yield* Store.propose(input);
    yield* Store.applyDecision(yield* decision(operation));
    if (outcome === "restart") yield* Store.claim(operation.id);
    const blocked = outcome === "revoked" || outcome === "preflight-revoked";
    if (outcome === "revoked") {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.grant.revoked', json('true'))`;
    }
    const executor = yield* Executor.ExternalActionExecutor;
    yield* executor.execute(operation.id);
    yield* executor.execute(operation.id);
    expect(writes).toBe(outcome === "already-draft" || outcome === "restart" || blocked ? 0 : 1);
    const sql = yield* SqlClient.SqlClient;
    const notices = yield* sql<{
      payload: string;
    }>`SELECT payload_json AS payload FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${`external-outcome:${operation.id}`}`;
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toContain(
      blocked ? "Action not performed" : draft ? "desired state observed" : "no automatic retry",
    );
    expect(reads).toBeGreaterThanOrEqual(outcome === "revoked" ? 0 : 1);
    expect((yield* Store.get(operation.id)).state).toBe(
      blocked ? "blocked" : draft ? "succeeded" : "uncertain",
    );
  }).pipe(Effect.provide(external));
});
