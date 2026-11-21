import { reserve } from "./Work.ts";
import * as Changes from "./Changes.ts";
import * as Worker from "../orchestration-v2/EffectWorker.ts";
import * as Settings from "../serverSettings.ts";
import * as ResourceCleanupService from "../orchestration-v2/ResourceCleanupService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTitleRegenerationService from "../orchestration-v2/ThreadTitleRegenerationService.ts";
import * as RuntimeRequestService from "../orchestration-v2/RuntimeRequestService.ts";
import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as ProviderTurnControlService from "../orchestration-v2/ProviderTurnControlService.ts";
import * as CheckpointRollbackService from "../orchestration-v2/CheckpointRollbackService.ts";
import * as RunFinalizationService from "../orchestration-v2/RunFinalizationService.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  TurnItemId,
  CheckpointId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Store from "./Store.ts";
import * as Outbox from "../orchestration-v2/EffectOutbox.ts";
import * as Option from "effect/Option";

const persistence = Layer.mergeAll(
  Store.layer,
  EventSink.layer.pipe(Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer))),
).pipe(
  Layer.provideMerge(Changes.layer),
  Layer.provideMerge(Outbox.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);
const layer = Worker.layerExecutor.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
      Layer.mock(RunFinalizationService.RunFinalizationService)({}),
      Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
      Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({}),
      Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({}),
      Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
      Layer.mock(ThreadTitleRegenerationService.ThreadTitleRegenerationService)({}),
      Layer.mock(ThreadManagementService.ThreadManagementService)({}),
      Layer.mock(ResourceCleanupService.ResourceCleanupService)({}),
      Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
      Settings.layerTest(),
    ),
  ),
  Layer.provideMerge(persistence),
);
it.effect("pins revisions and durably reports once without starting a destination run", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    const sink = yield* EventSink.EventSinkV2;
    const executor = yield* Worker.OrchestrationEffectExecutorV2;
    const sql = yield* SqlClient.SqlClient;
    const outbox = yield* Outbox.EffectOutboxV2;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("reports");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const leadId = ThreadId.make("t3po-lead:reports");
    const thread = (id: ThreadId, parent: ThreadId | null): OrchestrationV2AppThread => ({
      id,
      projectId,
      title: "Task",
      createdBy: "user",
      creationSource: "web",
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "test" },
      runtimeMode: "approval-required",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: {
        rootThreadId: leadId,
        parentThreadId: parent,
        relationshipToParent: parent ? "subagent" : null,
      },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      lastVisitedAt: null,
    });
    const run = (id: string, threadId: ThreadId): OrchestrationV2Run => ({
      id: RunId.make(id),
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection: { instanceId: providerInstanceId, model: "test" },
      providerThreadId: null,
      userMessageId: MessageId.make(`message:${id}`),
      rootNodeId: null,
      activeAttemptId: null,
      status: "running",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    });

    yield* store.mutate({ type: "save_lead", projectId, name: "Lead", brief: "Investigate" });
    const source = ThreadId.make("t3po-task:job");
    for (const id of [leadId, source])
      yield* sink.write({
        events: [
          {
            id: EventId.make(`thread:${id}`),
            type: "thread.created",
            threadId: id,
            occurredAt: now,
            payload: thread(id, null),
          },
        ],
      });
    yield* sink.write({
      events: [
        {
          id: EventId.make("origin-message"),
          type: "message.updated",
          threadId: leadId,
          occurredAt: now,
          payload: {
            id: MessageId.make("request"),
            threadId: leadId,
            runId: null,
            nodeId: null,
            role: "user",
            text: "Investigate",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
            createdBy: "user",
            creationSource: "web",
          },
        },
      ],
    });
    const routed = yield* reserve(
      leadId,
      {
        requestId: "report-route",
        sourceMessageId: MessageId.make("request"),
        action: "new_job",
        workstreamId: "investigation",
        workstreamTitle: "Investigation",
        goal: "Reproducible findings",
        title: "Routed investigation",
        message: "Investigate",
        reportToOrigin: true,
      },
      { instanceId: providerInstanceId, model: "test" },
    );
    expect((yield* store.getTask(routed.jobId, projectId)).origin?.threadId).toBe(leadId);
    const task = {
      type: "create_task" as const,
      id: "job",
      projectId,
      channelId: null,
      title: "Investigate",
      brief: "First",
      origin: { threadId: leadId, messageId: MessageId.make("request") },
    };
    yield* store.mutate(task);
    yield* store.mutate({ ...task, type: "edit_task", brief: "Second" });
    yield* store.mutate({ type: "save_budget", projectId, maxRuns: 1, maxConcurrent: 1 });
    const execution = run("execution", source);
    yield* sink.write({
      events: [
        {
          id: EventId.make("run"),
          type: "run.created",
          threadId: source,
          occurredAt: now,
          payload: execution,
        },
      ],
    });
    const context = JSON.parse(yield* store.context(projectId, source, "", execution.id));
    expect(context.briefRevision).toBe(2);
    expect(context.assignment).toBe("Second");
    yield* store.mutate({ ...task, type: "edit_task", brief: "Third" });
    expect(JSON.parse(yield* store.context(projectId, source, "", execution.id)).assignment).toBe(
      "Second",
    );
    yield* sink.write({
      events: [
        {
          id: EventId.make("evidence"),
          type: "message.updated",
          threadId: source,
          occurredAt: now,
          payload: {
            id: MessageId.make("answer"),
            threadId: source,
            runId: execution.id,
            nodeId: null,
            role: "assistant",
            createdBy: "agent",
            creationSource: "provider",
            text: "Measured result: latency fell by 20%.",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    const fullText = "Measured result: latency fell by 20%." + "x".repeat(13000);
    yield* sink.write({
      events: [
        {
          id: EventId.make("final-item"),
          type: "turn-item.updated",
          threadId: source,
          occurredAt: now,
          payload: {
            id: TurnItemId.make("final-item"),
            type: "assistant_message",
            phase: "final_answer",
            threadId: source,
            runId: execution.id,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: now,
            completedAt: now,
            updatedAt: now,
            messageId: MessageId.make("final-answer"),
            text: fullText,
            streaming: false,
          },
        },
        {
          id: EventId.make("later-commentary"),
          type: "message.updated",
          threadId: source,
          occurredAt: now,
          payload: {
            id: MessageId.make("commentary"),
            threadId: source,
            runId: execution.id,
            nodeId: null,
            role: "assistant",
            createdBy: "agent",
            creationSource: "provider",
            text: "Later commentary, not the result",
            attachments: [],
            streaming: false,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
    const terminal = {
      id: EventId.make("complete"),
      type: "run.updated" as const,
      threadId: source,
      occurredAt: now,
      payload: { ...execution, status: "completed" as const, completedAt: now },
    };
    yield* sink.write({ events: [terminal] });
    const pending = Option.getOrThrow(yield* outbox.get("t3po-report:execution"));
    expect(pending.request.type).toBe("t3po.report");
    expect((yield* outbox.claimNext({ workerId: "before-restart" }))._tag).toBe("Some");
    yield* outbox.reconcileAfterProcessLoss;
    expect((yield* outbox.claimNext({ workerId: "after-restart" }))._tag).toBe("Some");
    yield* sql`UPDATE orchestration_v2_projection_threads SET project_id = 'revoked' WHERE thread_id = ${leadId}`;
    expect((yield* Effect.result(executor.execute(pending)))._tag).toBe("Failure");
    expect(
      (yield* sql<{
        delivered_at: string | null;
      }>`SELECT delivered_at FROM t3po_task_executions`)[0]?.delivered_at,
    ).toBeNull();
    yield* sql`UPDATE orchestration_v2_projection_threads SET project_id = ${projectId} WHERE thread_id = ${leadId}`;
    yield* executor.execute(pending);
    yield* executor.execute(pending);
    yield* sink.write({ events: [{ ...terminal, id: EventId.make("terminal-replayed") }] });
    yield* executor.execute(pending);
    expect(
      (yield* Effect.result(
        sink.write({
          events: [
            {
              id: EventId.make("over-budget"),
              type: "run.created",
              threadId: source,
              occurredAt: now,
              payload: { ...run("denied", source), ordinal: 2 },
            },
          ],
        }),
      ))._tag,
    ).toBe("Failure");
    const messages =
      yield* sql`SELECT * FROM orchestration_v2_projection_messages WHERE thread_id = ${leadId} AND role = 'system'`;
    expect(messages).toHaveLength(1);
    expect(JSON.stringify(messages)).toContain("Measured result: latency fell by 20%.");
    expect(JSON.stringify(messages)).toContain("answer");
    expect(
      yield* sql`SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = ${leadId}`,
    ).toHaveLength(0);
    expect((yield* store.getTask("job", projectId)).completed).toBe(false);
    expect(yield* sql`SELECT revision FROM t3po_task_revisions WHERE task_id = 'job'`).toHaveLength(
      3,
    );
    expect(
      (yield* sql<{ delivered_at: string }>`SELECT delivered_at FROM t3po_task_executions`)[0]
        ?.delivered_at,
    ).toBeTruthy();
    const visible = yield* sql<{
      ordinal: number;
      payload_json: string;
    }>`SELECT ordinal, payload_json FROM orchestration_v2_projection_turn_items WHERE thread_id = ${leadId}`;
    expect(visible).toHaveLength(1);
    expect(visible[0]!.ordinal).toBeGreaterThan(0);
    expect(JSON.parse(visible[0]!.payload_json)).toMatchObject({
      type: "system_notice",
      runId: null,
    });
    expect(visible[0]!.payload_json).not.toContain("Later commentary");
    yield* sink.write({
      events: [
        {
          ...terminal,
          id: EventId.make("late-checkpoint"),
          payload: { ...terminal.payload, checkpointId: CheckpointId.make("late-checkpoint") },
        },
      ],
    });
    yield* executor.execute(pending);
    yield* sql`DELETE FROM orchestration_v2_projection_turn_items WHERE thread_id = ${source}`;
    yield* sql`DELETE FROM orchestration_v2_projection_messages WHERE thread_id = ${source}`;
    yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE thread_id = ${source}`;
    const snapshot = (yield* sql<{
      result_json: string;
    }>`SELECT result_json FROM t3po_task_executions WHERE run_id = ${execution.id}`)[0]!;
    expect(JSON.parse(snapshot.result_json)).toMatchObject({
      text: fullText,
      runOrdinal: 1,
      checkpointId: "late-checkpoint",
    });
    const results = yield* store.results({ projectId, taskId: "job" });
    expect(results.results[0]).toMatchObject({
      runId: execution.id,
      messageId: "final-answer",
      truncated: true,
      checkpointId: "late-checkpoint",
      briefRevision: 2,
      text: fullText.slice(0, 12000),
    });
    expect(
      yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE thread_id = ${leadId}`,
    ).toHaveLength(1);
    yield* store.mutate({ type: "save_budget", projectId, maxRuns: 3, maxConcurrent: 1 });
    const next = { ...run("next-execution", source), ordinal: 2 };
    yield* sink.write({
      events: [
        {
          id: EventId.make("next-run"),
          type: "run.created",
          threadId: source,
          occurredAt: now,
          payload: next,
        },
      ],
    });
    expect(JSON.parse(yield* store.context(projectId, source, "", next.id))).toMatchObject({
      assignment: "Third",
      briefRevision: 3,
    });
    yield* sink.write({
      events: [
        {
          id: EventId.make("cancel-next"),
          type: "run.updated",
          threadId: source,
          occurredAt: now,
          payload: { ...next, status: "cancelled", completedAt: now },
        },
      ],
    });
    yield* sink.deliverTaskReport(next.id);
    const delivered = (yield* sql<{
      delivered_at: string;
    }>`SELECT delivered_at FROM t3po_task_executions WHERE run_id = ${next.id}`)[0]!.delivered_at;
    yield* sink.write({
      events: [
        {
          id: EventId.make("cancel-checkpoint"),
          type: "run.updated",
          threadId: source,
          occurredAt: now,
          payload: {
            ...next,
            status: "cancelled",
            completedAt: now,
            checkpointId: CheckpointId.make("cancel-checkpoint"),
          },
        },
      ],
    });
    yield* sink.deliverTaskReport(next.id);
    expect(
      (yield* sql<{
        delivered_at: string;
        result_json: string;
      }>`SELECT delivered_at, result_json FROM t3po_task_executions WHERE run_id = ${next.id}`)[0],
    ).toMatchObject({ delivered_at: delivered });
    expect(
      JSON.parse(
        (yield* sql<{
          result_json: string;
        }>`SELECT result_json FROM t3po_task_executions WHERE run_id = ${next.id}`)[0]!.result_json,
      ),
    ).toMatchObject({ status: "cancelled", checkpointId: "cancel-checkpoint" });
    expect(
      yield* sql`SELECT turn_item_id FROM orchestration_v2_projection_turn_items WHERE thread_id = ${leadId}`,
    ).toHaveLength(2);
    yield* sql`INSERT INTO t3po_spaces (id, name) VALUES ('other-space', 'Other')`;
    const other = ProjectId.make("other");
    yield* sql`INSERT INTO t3po_project_spaces (project_id, space_id) VALUES (${other}, 'other-space')`;
    expect(
      (yield* Effect.result(store.mutate({ ...task, id: "forbidden", projectId: other })))._tag,
    ).toBe("Failure");
  }).pipe(Effect.provide(layer)),
);
