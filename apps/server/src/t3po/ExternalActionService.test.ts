import { assert, it } from "@effect/vitest";
import {
  SourceControlProviderKind,
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  PullRequestOperationError,
  type PullRequestSummary,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Deferred from "effect/Deferred";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as PullRequests from "../pullRequest/PullRequestService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Positions from "../orchestration-v2/TurnItemPositionStore.ts";
import * as ProviderRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as Harness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Store from "./ExternalActionStore.ts";
import * as Executor from "./ExternalActionExecutor.ts";
import * as Service from "./ExternalActionService.ts";

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const threadId = ThreadId.make("external-worker");
const runId = RunId.make("external-run");
const attemptId = RunAttemptId.make("external-attempt");
const projectId = ProjectId.make("external-project");
const instanceId = ProviderInstanceId.make("codex");
const providerSessionId = ProviderSessionId.make("external-session");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  openSession: () => Effect.die("No provider turn is needed to approve an operation"),
} as unknown as ProviderAdapter.ProviderAdapterV2["Service"];

it.effect.each([
  "accept",
  "decline",
  "cancel",
  "revoked",
  "process-loss",
  "uncertain",
  "rollback",
] as const)(
  "delivers a visible exact approval and processes %s through the existing outbox",
  (scenario) => {
    let writes = 0;
    let draft = false;
    const summary = (): PullRequestSummary => ({
      provider: SourceControlProviderKind.make("github"),
      projectId,
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
    const prLayer = Layer.mock(PullRequests.PullRequestService)({
      draftTarget: (input) => {
        assert.equal(input.expectedAccountId, "github:owner");
        assert.equal(input.repository, "owner/repo");
        assert.equal(input.number, 42);
        return Effect.succeed({ nodeId: "PR_exact", summary: summary() });
      },
      runAction: (input) =>
        Effect.gen(function* () {
          assert.equal(input.action, "draft");
          assert.equal(input.expectedDraftNodeId, "PR_exact");
          assert.equal(input.expectedAccountId, "github:owner");
          assert.isTrue(yield* input.beforeMutation!);
          writes++;
          draft = scenario !== "uncertain";
          return yield* new PullRequestOperationError({
            operation: "fixture",
            detail: "Response lost after mutation",
          });
        }),
    });
    const database = Sqlite.layerMemory;
    const runtime = Harness.layerWithRegistry(
      { name: "external-action-integration" },
      ProviderRegistry.layerFromAdapters([adapter]),
      {
        databaseLayer: database,
        runEffectWorker: false,
        externalActionExecutorLayer: Executor.layer.pipe(Layer.provide(prLayer)),
      },
    );
    const layer = Layer.mergeAll(
      database,
      runtime,
      ProjectionStore.layer.pipe(Layer.provide(database)),
      Service.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            runtime,
            prLayer,
            IdAllocator.layer,
            Positions.layer.pipe(Layer.provide(database)),
            database,
          ),
        ),
      ),
    );
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const service = yield* Service.ExternalActionService;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Project','/project','[]',${nowIso},${nowIso})`;
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-external-worker"),
        threadId,
        projectId,
        title: "Worker",
        modelSelection,
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* projections.apply({
        id: EventId.make("external-run-created"),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal: 1,
          providerInstanceId: instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make("external-message"),
          rootNodeId: null,
          activeAttemptId: attemptId,
          status: "running",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      const grant = {
        version: 1,
        briefRevision: 1,
        spaceId: null,
        workspace: { type: "root" },
        route: "local",
        workspaceRoot: "/project",
        expiresAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
        revoked: false,
        maxRuns: 1,
        maxConcurrent: 1,
      };
      const task = {
        id: "external-task",
        projectId,
        threadId,
        title: "Draft PR",
        brief: "Work",
        channelId: null,
        completed: false,
        reviewedRunId: null,
        createdAt: nowIso,
        workspace: { type: "root" },
        briefRevision: 1,
        grant,
      };
      yield* sql`INSERT INTO t3po_tasks (id,project_id,data) VALUES ('external-task',${projectId},${yield* encodeJson(task)})`;
      yield* sql`INSERT INTO t3po_job_grants (task_id,version,project_id,data) VALUES ('external-task',1,${projectId},${yield* encodeJson(grant)})`;
      yield* sql`INSERT INTO t3po_grant_admissions(run_id,task_id,version,binding) VALUES (${runId},'external-task',1,${yield* encodeJson({ cwd: "/project", worktreePath: null, branch: null })})`;
      yield* Store.setBinding({
        projectId,
        expectedVersion: 0,
        accountId: "github:owner",
        host: "github.com",
        repository: "owner/repo",
        enabled: true,
      });
      const input = {
        caller: {
          threadId,
          providerSessionId,
          providerInstanceId: instanceId,
          proposalExecution: {
            runId,
            attemptId,
            providerSessionId,
            capability: "propose-external-action" as const,
          },
        },
        number: 42,
        requestKey: "intent-draft",
      };
      if (scenario === "rollback") {
        const sink = yield* EventSink.EventSinkV2;
        const highWater = yield* sink.latestSequence();
        const published = yield* Deferred.make<void>();
        yield* sink.stream({ afterSequence: highWater }).pipe(
          Stream.tap(() => Deferred.succeed(published, undefined)),
          Stream.runDrain,
          Effect.forkScoped({ startImmediately: true }),
        );
        assert.isTrue(
          yield* sink
            .withProviderBatch(
              service.proposeDraft(input).pipe(Effect.andThen(Effect.fail("rollback fixture"))),
            )
            .pipe(Effect.isFailure),
        );
        yield* TestClock.adjust(0);
        assert.isFalse(yield* Deferred.isDone(published));
        assert.equal(yield* sink.latestSequence(), highWater);
        assert.deepEqual(yield* sql`SELECT id FROM t3po_external_operations`, []);
        assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).runtimeRequests, []);
        return;
      }
      const proposed = yield* service.proposeDraft(input);
      assert.deepEqual(yield* service.proposeDraft(input), proposed);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const approvals = projection.visibleTurnItems.filter(
        (row) => row.item.type === "approval_request",
      );
      assert.lengthOf(approvals, 1);
      assert.equal(approvals[0]?.item.status, "waiting");
      assert.equal(writes, 0);
      yield* worker.drain();
      assert.equal(writes, 0);
      if (scenario === "revoked") {
        yield* sql`UPDATE t3po_tasks SET data = json_set(data,'$.grant.revoked',json('true')) WHERE id='external-task'`;
      }
      const command = {
        type: "runtime-request.respond" as const,
        commandId: CommandId.make("approve-external"),
        threadId,
        requestId: RuntimeRequestId.make(proposed.requestId),
        decision: scenario === "decline" || scenario === "cancel" ? scenario : ("accept" as const),
      };
      if (scenario === "revoked") {
        assert.isTrue(yield* orchestrator.dispatch(command).pipe(Effect.isFailure));
        assert.equal((yield* Store.get(proposed.operationId)).state, "pending");
        assert.equal(
          (yield* projections.getRuntimeRequest(threadId, command.requestId))?.status,
          "pending",
        );
        assert.deepEqual(yield* outbox.listByCommandId(command.commandId), []);
        return;
      }
      yield* orchestrator.dispatch(command);
      yield* orchestrator.dispatch(command);
      const effects = yield* outbox.listByCommandId(command.commandId);
      assert.lengthOf(effects, scenario === "decline" || scenario === "cancel" ? 0 : 1);
      if (scenario === "process-loss") {
        assert.isTrue(Option.isSome(yield* outbox.claimNext({ workerId: "lost-worker" })));
        assert.isTrue(yield* Store.claim(proposed.operationId));
        writes++;
        draft = true;
        assert.equal((yield* outbox.reconcileAfterProcessLoss).requeued, 1);
      }
      yield* worker.drain();
      yield* worker.drain();
      assert.equal(writes, scenario === "decline" || scenario === "cancel" ? 0 : 1);
      assert.equal(
        (yield* Store.get(proposed.operationId)).state,
        scenario === "decline" || scenario === "cancel"
          ? "declined"
          : scenario === "uncertain"
            ? "uncertain"
            : "succeeded",
      );
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(
        after.visibleTurnItems.filter((row) => row.item.type === "approval_request"),
        1,
      );
      assert.lengthOf(after.runs, 1);
      assert.equal(after.runtimeRequests[0]?.status, "resolved");
      const notices = after.visibleTurnItems.filter(
        (row) => row.item.id === `external-outcome:${proposed.operationId}`,
      );
      assert.lengthOf(notices, scenario === "decline" || scenario === "cancel" ? 0 : 1);
      if (notices[0]?.item.type === "system_notice") {
        assert.include(
          notices[0].item.message,
          scenario === "uncertain" ? "no automatic retry" : "desired state observed",
        );
      }
    }).pipe(Effect.provide(layer));
  },
);
