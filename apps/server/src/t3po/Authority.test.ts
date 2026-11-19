import authorityMigration from "../persistence/Migrations/103_T3poAuthority.ts";
import { expect, it } from "@effect/vitest";
import {
  EventId,
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

const layer = Layer.mergeAll(
  Store.layer,
  EventSink.layer.pipe(Layer.provide(Layer.merge(EventStore.layer, ProjectionStore.layer))),
).pipe(Layer.provideMerge(Sqlite.layerMemory));
it.effect.each([false, true])(
  "atomically accounts for lead descendants and releases terminal slots (channel=%s)",
  (channelLead) =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      const sink = yield* EventSink.EventSinkV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("authority");
      const providerInstanceId = ProviderInstanceId.make("codex");
      const leadId = ThreadId.make(channelLead ? "t3po-channel:research" : "t3po-lead:authority");
      if (channelLead)
        yield* store.mutate({
          type: "create_channel",
          projectId,
          id: "research",
          name: "Research",
        });
      yield* store.mutate({ type: "save_lead", projectId, name: "Lead", brief: "Work" });
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
      yield* sink.write({
        events: [
          {
            id: EventId.make("lead"),
            type: "thread.created",
            threadId: leadId,
            occurredAt: now,
            payload: thread(leadId, null),
          },
        ],
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("manual-lead-run"),
            type: "run.created",
            threadId: leadId,
            occurredAt: now,
            payload: run("manual-lead", leadId),
          },
        ],
      });
      expect(yield* sql`SELECT run_id FROM t3po_admissions`).toHaveLength(0);
      const launch = Effect.fn("test.launch")(function* (id: string, parent = leadId) {
        const threadId = ThreadId.make(`child:${id}`);
        yield* sink.write({
          events: [
            {
              id: EventId.make(`thread:${id}`),
              type: "thread.created",
              threadId,
              occurredAt: now,
              payload: thread(threadId, parent),
            },
            {
              id: EventId.make(`run:${id}`),
              type: "run.created",
              threadId,
              occurredAt: now,
              payload: run(id, threadId),
            },
          ],
        });
      });
      expect(yield* launch("unconfigured").pipe(Effect.isFailure)).toBe(true);
      expect(
        yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = 'child:unconfigured'`,
      ).toHaveLength(0);
      yield* store.mutate({ type: "save_budget", projectId, maxRuns: 2, maxConcurrent: 1 });
      const admitted = yield* Effect.all(
        [launch("a").pipe(Effect.isSuccess), launch("b").pipe(Effect.isSuccess)],
        { concurrency: "unbounded" },
      );
      expect(admitted.filter(Boolean)).toHaveLength(1);
      const winner = admitted[0] ? "a" : "b";
      const winnerId = ThreadId.make(`child:${winner}`);
      expect((yield* store.read).leads[0]?.budget).toEqual({
        maxRuns: 2,
        maxConcurrent: 1,
        usedRuns: 1,
        activeRuns: 1,
      });
      expect(
        yield* sink
          .write({
            events: [
              {
                id: EventId.make("escalate"),
                type: "thread.runtime-mode-updated",
                threadId: winnerId,
                occurredAt: now,
                payload: { ...thread(winnerId, leadId), runtimeMode: "full-access" },
              },
            ],
          })
          .pipe(Effect.isFailure),
      ).toBe(true);
      yield* sink.write({
        events: [
          {
            id: EventId.make("done"),
            type: "run.updated",
            threadId: winnerId,
            occurredAt: now,
            payload: { ...run(winner, winnerId), status: "failed", completedAt: now },
          },
        ],
      });
      yield* launch("nested", winnerId);
      yield* sink.write({
        events: [
          {
            id: EventId.make("nested-done"),
            type: "run.updated",
            threadId: ThreadId.make("child:nested"),
            occurredAt: now,
            payload: {
              ...run("nested", ThreadId.make("child:nested")),
              status: "completed",
              completedAt: now,
            },
          },
        ],
      });
      expect(yield* launch("exhausted").pipe(Effect.isFailure)).toBe(true);
      const reconstructed = yield* Store.Store.pipe(Effect.provide(Layer.fresh(Store.layer)));
      expect((yield* reconstructed.read).leads[0]?.budget?.usedRuns).toBe(2);
      expect(yield* sql`SELECT run_id FROM t3po_admissions`).toHaveLength(2);
    }).pipe(Effect.provide(layer)),
);

it.effect("backfills historical usage and active reservations without inventing an allowance", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("existing");
    yield* store.mutate({ type: "save_lead", projectId, name: "Lead", brief: "Work" });
    yield* store.mutate({
      type: "create_task",
      projectId,
      id: "existing",
      channelId: null,
      title: "Task",
      brief: "Work",
    });
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('old-done', 't3po-task:existing', 1, 'codex', 'completed', '2026-11-18T12:00:00Z', '{}'), ('old-active', 't3po-task:existing', 2, 'codex', 'waiting', '2026-11-18T12:00:00Z', '{}')`;
    yield* sql`DROP TABLE t3po_admissions`;
    yield* sql`DROP TABLE t3po_budgets`;
    yield* authorityMigration;
    expect((yield* store.read).leads[0]?.budget).toBeUndefined();
    yield* store.mutate({ type: "save_budget", projectId, maxRuns: 0, maxConcurrent: 0 });
    expect((yield* store.read).leads[0]?.budget).toEqual({
      maxRuns: 0,
      maxConcurrent: 0,
      usedRuns: 2,
      activeRuns: 1,
    });
  }).pipe(Effect.provide(layer)),
);
