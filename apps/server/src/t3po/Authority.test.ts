import * as Authority from "./Authority.ts";
import * as TestClock from "effect/testing/TestClock";
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
      const ordinaryId = ThreadId.make("ordinary-chat");
      yield* sink.write({
        events: [
          {
            id: EventId.make("ordinary-before-space"),
            type: "thread.created",
            threadId: ordinaryId,
            occurredAt: now,
            payload: { ...thread(ordinaryId, null), runtimeMode: "full-access" },
          },
        ],
      });
      yield* store.mutate({ type: "assign_space", projectId, spaceId: "personal" });
      const foreignProject = ProjectId.make("business-project");
      yield* store.mutate({ type: "assign_space", projectId: foreignProject, spaceId: "business" });
      for (const payload of [
        { ...thread(ThreadId.make("space-child"), leadId), projectId: foreignProject },
        {
          ...thread(ThreadId.make("space-fork"), null),
          projectId: foreignProject,
          forkedFrom: { type: "run" as const, threadId: leadId, runId: RunId.make("source") },
        },
      ]) {
        expect(
          yield* sink
            .write({
              events: [
                {
                  id: EventId.make(payload.id),
                  type: "thread.created",
                  threadId: payload.id,
                  occurredAt: now,
                  payload,
                },
              ],
            })
            .pipe(Effect.isFailure),
        ).toBe(true);
        expect(
          yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${payload.id}`,
        ).toEqual([]);
      }
      yield* store.mutate({
        type: "create_task",
        projectId: foreignProject,
        id: "handoff",
        channelId: null,
        title: "Explicit handoff",
        brief: "Only this brief",
      });
      yield* sql`INSERT INTO t3po_space_handoffs (job_id, source_project_id, source_space_id, target_project_id, target_space_id) VALUES ('handoff', ${projectId}, 'personal', ${foreignProject}, 'business')`;
      const handoffThread = ThreadId.make("t3po-task:handoff");
      const handoffEvents = () =>
        sink.write({
          events: [
            {
              id: EventId.make("handoff-thread"),
              type: "thread.created",
              threadId: handoffThread,
              occurredAt: now,
              payload: { ...thread(handoffThread, null), projectId: foreignProject },
            },
            {
              id: EventId.make("handoff-run"),
              type: "run.created",
              threadId: handoffThread,
              occurredAt: now,
              payload: run("handoff", handoffThread),
            },
          ],
        });
      expect(yield* handoffEvents().pipe(Effect.isFailure)).toBe(true);
      expect(
        yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${handoffThread}`,
      ).toEqual([]);
      yield* store.mutate({
        type: "connect_space",
        projectId,
        sourceSpaceId: "personal",
        targetSpaceId: "business",
        targetProjectId: foreignProject,
        enabled: true,
      });
      yield* store.mutate({ type: "save_budget", projectId: foreignProject, maxConcurrent: 0 });
      expect(yield* handoffEvents().pipe(Effect.isFailure)).toBe(true);
      yield* store.mutate({
        type: "save_budget",
        projectId: foreignProject,
        maxRuns: 1,
        maxConcurrent: 1,
      });
      yield* store.mutate({
        type: "save_job_grant",
        projectId: foreignProject,
        id: "handoff",
        briefRevision: 1,
        expectedVersion: 0,
        expiresAt: DateTime.formatIso(DateTime.add(now, { hours: 1 })),
        maxRuns: 1,
        maxConcurrent: 1,
      });
      yield* handoffEvents();
      const nestedThread = ThreadId.make("nested-grant-worker");
      expect(
        yield* sink
          .write({
            events: [
              {
                id: EventId.make("nested-grant-thread"),
                type: "thread.created",
                threadId: nestedThread,
                occurredAt: now,
                payload: { ...thread(nestedThread, handoffThread), projectId: foreignProject },
              },
              {
                id: EventId.make("nested-grant-run"),
                type: "run.created",
                threadId: nestedThread,
                occurredAt: now,
                payload: run("nested-grant-run", nestedThread),
              },
            ],
          })
          .pipe(Effect.flip),
      ).toMatchObject({ cause: { operation: "grant_stale" } });
      yield* Authority.checkJobGrants(handoffThread, "handoff", true);
      yield* Authority.checkJobGrants(handoffThread, "handoff", true);
      expect(yield* sql`SELECT * FROM t3po_grant_admissions`).toHaveLength(1);
      expect(
        yield* Authority.checkJobGrants(handoffThread, "second").pipe(
          sql.withTransaction,
          Effect.isFailure,
        ),
      ).toBe(true);
      yield* TestClock.adjust("2 hours");
      expect(
        yield* Authority.checkJobGrants(handoffThread, "handoff", true).pipe(Effect.isFailure),
      ).toBe(true);
      yield* store.mutate({
        type: "revoke_job_grant",
        projectId: foreignProject,
        id: "handoff",
        expectedVersion: 1,
      });
      expect(
        yield* Authority.checkJobGrants(handoffThread, "handoff", true).pipe(Effect.isFailure),
      ).toBe(true);
      yield* store.mutate({
        type: "save_job_grant",
        projectId: foreignProject,
        id: "handoff",
        briefRevision: 1,
        expectedVersion: 2,
        expiresAt: DateTime.formatIso(DateTime.add(now, { hours: 4 })),
      });
      expect(
        yield* Authority.checkJobGrants(handoffThread, "handoff", true).pipe(Effect.isFailure),
      ).toBe(true);
      expect(yield* sql`SELECT * FROM t3po_job_grants WHERE task_id = 'handoff'`).toHaveLength(3);
      yield* store.mutate({
        type: "edit_task",
        projectId: foreignProject,
        id: "handoff",
        title: "Changed",
        brief: "New scope",
        channelId: null,
      });
      expect(
        yield* Authority.checkJobGrants(handoffThread, "fresh").pipe(
          sql.withTransaction,
          Effect.isFailure,
        ),
      ).toBe(true);
      expect(yield* sql`SELECT project_id FROM t3po_admissions WHERE run_id = 'handoff'`).toEqual([
        { project_id: foreignProject },
      ]);
      yield* sink.write({
        events: [
          {
            id: EventId.make("handoff-done"),
            type: "run.updated",
            threadId: handoffThread,
            occurredAt: now,
            payload: { ...run("handoff", handoffThread), status: "completed", completedAt: now },
          },
        ],
      });
      yield* sql`DELETE FROM t3po_admissions WHERE run_id = 'handoff'`;
      for (const type of ["thread.runtime-mode-updated", "thread.provider-switched"] as const) {
        yield* sink.write({
          events: [
            {
              id: EventId.make(`manual:${type}`),
              type,
              threadId: leadId,
              occurredAt: now,
              payload: { ...thread(leadId, null), runtimeMode: "full-access" },
            },
          ],
        });
      }
      yield* sink.write({
        events: [
          {
            id: EventId.make("ordinary-after-space"),
            type: "run.created",
            threadId: ordinaryId,
            occurredAt: now,
            payload: run("ordinary", ordinaryId),
          },
          {
            id: EventId.make("ordinary-complete"),
            type: "run.updated",
            threadId: ordinaryId,
            occurredAt: now,
            payload: { ...run("ordinary", ordinaryId), status: "completed", completedAt: now },
          },
          {
            id: EventId.make("new-space-chat"),
            type: "thread.created",
            threadId: ThreadId.make("new-chat"),
            occurredAt: now,
            payload: { ...thread(ThreadId.make("new-chat"), null), runtimeMode: "full-access" },
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
      yield* store.mutate({ type: "save_budget", projectId, maxConcurrent: 0 });
      expect(yield* launch("disabled").pipe(Effect.isFailure)).toBe(true);
      expect(
        yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = 'child:disabled'`,
      ).toHaveLength(0);
      yield* store.mutate({ type: "save_budget", projectId, maxConcurrent: 1 });
      const admitted = yield* Effect.all(
        [launch("a").pipe(Effect.isSuccess), launch("b").pipe(Effect.isSuccess)],
        { concurrency: "unbounded" },
      );
      expect(admitted.filter(Boolean)).toHaveLength(1);
      const winner = admitted[0] ? "a" : "b";
      const winnerId = ThreadId.make(`child:${winner}`);
      expect((yield* store.read).leads[0]?.budget).toMatchObject({
        maxConcurrent: 1,
        usedRuns: 1,
        activeRuns: 1,
      });
      // A supervised project keeps its jobs from leaving approval-required.
      yield* store.mutate({
        type: "save_work_access",
        projectId,
        runtimeMode: "approval-required",
      });
      expect((yield* store.read).leads[0]?.workAccess).toBe("approval-required");
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
      // Full access is the default, so choosing it again clears the stored setting.
      yield* store.mutate({ type: "save_work_access", projectId, runtimeMode: "full-access" });
      expect((yield* store.read).leads[0]?.workAccess).toBeUndefined();
      yield* sink.write({
        events: [
          {
            id: EventId.make("allowed-escalate"),
            type: "thread.runtime-mode-updated",
            threadId: winnerId,
            occurredAt: now,
            payload: { ...thread(winnerId, leadId), runtimeMode: "full-access" },
          },
        ],
      });
      yield* store.mutate({
        type: "save_work_access",
        projectId,
        runtimeMode: "approval-required",
      });
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
      // Total runs are not capped: a free slot admits more work.
      yield* launch("more");
      const callback = (id: string, threadId = leadId) =>
        sink.write({
          events: [
            {
              id: EventId.make(`callback:${id}`),
              type: "run.created",
              threadId,
              occurredAt: now,
              payload: {
                ...run(id, threadId),
                ordinal: id === "concurrent-callback" ? 3 : 2,
                delegatedCompletion: { disposition: "open", nextGeneration: 1, delivery: null },
              },
            },
          ],
        });
      expect(yield* callback("busy-callback").pipe(Effect.flip)).toMatchObject({
        cause: { _tag: "T3poError", operation: "budget" },
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("more-done"),
            type: "run.updated",
            threadId: ThreadId.make("child:more"),
            occurredAt: now,
            payload: {
              ...run("more", ThreadId.make("child:more")),
              status: "completed",
              completedAt: now,
            },
          },
        ],
      });
      // An existing worker's persisted mode must still be checked at callback admission.
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.runtimeMode', 'full-access') WHERE thread_id = ${winnerId}`;
      expect(yield* callback("worker-callback", winnerId).pipe(Effect.flip)).toMatchObject({
        cause: { _tag: "T3poError", operation: "approval" },
      });
      yield* callback("lead-callback");
      expect((yield* store.read).leads[0]?.budget).toMatchObject({
        maxConcurrent: 1,
        usedRuns: 4,
        activeRuns: 1,
      });
      expect(yield* callback("concurrent-callback").pipe(Effect.flip)).toMatchObject({
        cause: { _tag: "T3poError", operation: "budget" },
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("callback-done"),
            type: "run.updated",
            threadId: leadId,
            occurredAt: now,
            payload: {
              ...run("lead-callback", leadId),
              ordinal: 2,
              status: "completed",
              completedAt: now,
            },
          },
        ],
      });
      expect((yield* store.read).leads[0]?.budget?.activeRuns).toBe(0);
      expect(
        yield* sql`SELECT json_extract(payload_json, '$.runtimeMode') AS mode FROM orchestration_v2_projection_threads WHERE thread_id = ${leadId}`,
      ).toEqual([{ mode: "full-access" }]);
      expect(
        yield* sql`SELECT run_id FROM orchestration_v2_projection_runs WHERE run_id IN ('busy-callback', 'worker-callback', 'concurrent-callback')`,
      ).toEqual([]);
      const reconstructed = yield* Store.Store.pipe(Effect.provide(Layer.fresh(Store.layer)));
      expect((yield* reconstructed.read).leads[0]?.budget?.usedRuns).toBe(4);
      expect(yield* sql`SELECT run_id FROM t3po_admissions`).toHaveLength(4);
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
    yield* store.mutate({ type: "save_budget", projectId, maxConcurrent: 0 });
    expect((yield* store.read).leads[0]?.budget).toEqual({
      maxRuns: 0,
      maxConcurrent: 0,
      usedRuns: 2,
      activeRuns: 1,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect("serializes the last grant slot and keeps channels organizational", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("grant-project");
    yield* store.mutate({ type: "save_budget", projectId, maxConcurrent: 10 });
    yield* store.mutate({
      type: "create_task",
      projectId,
      id: "bounded",
      channelId: null,
      title: "Job",
      brief: "Scope",
    });
    const grant = {
      type: "save_job_grant" as const,
      projectId,
      id: "bounded",
      expectedVersion: 0,
      briefRevision: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
      maxRuns: 1,
      maxConcurrent: 1,
    };
    yield* store.mutate(grant);
    const admit = Effect.fn("test.grantAdmission")(function* (runId: string) {
      yield* Authority.checkJobGrants("t3po-task:bounded", runId);
      yield* sql`INSERT INTO t3po_admissions (run_id, project_id, active) VALUES (${runId}, ${projectId}, 1)`;
    }, sql.withTransaction);
    const results = yield* Effect.all(
      [admit("one").pipe(Effect.isSuccess), admit("two").pipe(Effect.isSuccess)],
      { concurrency: "unbounded" },
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    const winner = results[0] ? "one" : "two";
    yield* store.mutate({ type: "create_channel", projectId, id: "other", name: "Other" });
    yield* store.mutate({
      type: "edit_task",
      projectId,
      id: "bounded",
      channelId: "other",
      title: "Job",
      brief: "Scope",
    });
    yield* store.checkStart("t3po-task:bounded", winner);
    expect(yield* admit("third").pipe(Effect.isFailure)).toBe(true);
    yield* sql`UPDATE t3po_admissions SET active = 0 WHERE run_id = ${winner}`;
    yield* sql`DELETE FROM orchestration_v2_projection_runs WHERE run_id = ${winner}`;
    expect(yield* admit("after-deletion").pipe(Effect.isFailure)).toBe(true);
    yield* store.mutate({ type: "save_space", projectId, id: "new-space", name: "New space" });
    yield* store.mutate({ type: "assign_space", projectId, spaceId: "new-space" });
    expect(yield* store.checkStart("t3po-task:bounded", winner).pipe(Effect.isFailure)).toBe(true);
    expect(yield* store.mutate(grant).pipe(Effect.isFailure)).toBe(true);
    yield* store.mutate({ ...grant, expectedVersion: 2 });
    expect(yield* store.checkStart("t3po-task:bounded", winner).pipe(Effect.isFailure)).toBe(true);
    yield* store.mutate({ type: "revoke_job_grant", projectId, id: "bounded", expectedVersion: 3 });
    expect(yield* admit("revoked-before-admission").pipe(Effect.isFailure)).toBe(true);
  }).pipe(Effect.provide(layer)),
);

it.effect.each(["root", "worktree"] as const)(
  "binds resolved %s execution and fails closed on missing history",
  (type) =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      const sql = yield* SqlClient.SqlClient;
      const projectId = ProjectId.make("binding");
      const threadId = "t3po-task:binding";
      const worktreePath = type === "root" ? null : "/worktrees/generated";
      const branch = type === "root" ? null : "generated/job-branch";
      yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES (${projectId}, 'Test', '/project', '[]', '2026-01-01', '2026-01-01')`;
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
      VALUES (${threadId}, ${projectId}, 'Test', 'codex', 'approval-required', 'default', '2026-01-01', '2026-01-01', json_object('worktreePath', ${worktreePath}, 'branch', ${branch}))`;
      yield* store.mutate({ type: "save_budget", projectId, maxConcurrent: 2 });
      yield* store.mutate({
        type: "create_task",
        projectId,
        id: "binding",
        channelId: null,
        title: "Test",
        brief: "Scope",
        workspace: type === "root" ? { type } : { type, baseRef: "main" },
      });
      yield* store.mutate({
        type: "save_job_grant",
        projectId,
        id: "binding",
        expectedVersion: 0,
        briefRevision: 1,
        expiresAt: "2099-01-01T00:00:00.000Z",
      });
      yield* Authority.checkJobGrants(threadId, "bound");
      const binding = { cwd: worktreePath ?? "/project", worktreePath, branch };
      yield* store.checkStart(threadId, "bound", binding);
      yield* store.checkStart(threadId, "bound", binding);
      expect(
        (yield* store
          .checkStart(threadId, "bound", { ...binding, cwd: "/other" })
          .pipe(Effect.flip)).operation,
      ).toBe("grant_invalid");
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json, '$.branch', 'moved') WHERE thread_id = ${threadId}`;
      expect(
        (yield* store
          .checkStart(threadId, "bound", { ...binding, branch: "moved" })
          .pipe(Effect.flip)).operation,
      ).toBe("grant_stale");
      yield* sql`DELETE FROM t3po_job_grants WHERE task_id = 'binding'`;
      expect((yield* store.checkStart(threadId, "bound").pipe(Effect.flip)).operation).toBe(
        "grant_invalid",
      );
      yield* sql`DELETE FROM t3po_tasks WHERE id = 'binding'`;
      expect((yield* store.checkStart(threadId, "bound").pipe(Effect.flip)).operation).toBe(
        "grant_invalid",
      );
      yield* store.checkStart("unrelated", "legacy");
    }).pipe(Effect.provide(layer)),
);

it.effect("replaces only uncommitted launch reservations and rejects the old reserved prompt", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("reservation");
    yield* store.mutate({ type: "save_budget", projectId, maxConcurrent: 2 });
    yield* store.mutate({
      type: "create_task",
      projectId,
      id: "reservation",
      channelId: null,
      title: "Test",
      brief: "Old",
    });
    const grant = {
      type: "save_job_grant" as const,
      projectId,
      id: "reservation",
      expectedVersion: 0,
      briefRevision: 1,
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    yield* store.mutate(grant);
    const selection = {
      projectId,
      taskId: "reservation",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
      runtimeMode: "approval-required" as const,
    };
    const old = yield* store.reserveLaunch("reservation", projectId, selection);
    yield* store.mutate({
      type: "edit_task",
      projectId,
      id: "reservation",
      title: "Test",
      brief: "New",
      channelId: null,
    });
    yield* store.mutate({ ...grant, expectedVersion: 1, briefRevision: 2 });
    const fresh = yield* store.reserveLaunch("reservation", projectId, selection);
    expect(fresh.briefRevision).toBe(2);
    expect(
      yield* Authority.checkJobGrants(
        "t3po-task:reservation",
        "old",
        false,
        undefined,
        old.messageId,
      ).pipe(Effect.flip),
    ).toMatchObject({ operation: "grant_stale" });
    yield* Authority.checkJobGrants(
      "t3po-task:reservation",
      "new",
      false,
      undefined,
      fresh.messageId,
    );
    yield* sql`INSERT INTO t3po_admissions (run_id, project_id, active) VALUES ('new', ${projectId}, 1)`;
    yield* store.mutate({
      type: "edit_task",
      projectId,
      id: "reservation",
      title: "Test",
      brief: "Third",
      channelId: null,
    });
    expect(yield* store.reserveLaunch("reservation", projectId, selection)).toEqual(fresh);
    expect(
      (yield* sql<{ active: number }>`SELECT active FROM t3po_admissions WHERE run_id = 'new'`)[0]
        ?.active,
    ).toBe(1);
  }).pipe(Effect.provide(layer)),
);
