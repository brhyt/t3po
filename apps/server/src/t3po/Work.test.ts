import { expect, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type T3poWorkRoute,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Store from "./Store.ts";
import * as Changes from "./Changes.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SpaceConnections from "./SpaceConnections.ts";
import { reserve, saveNotes } from "./Work.ts";

const projectId = ProjectId.make("project");
const caller = ThreadId.make("t3po-channel:research");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "test-model" };
const input: T3poWorkRoute = {
  requestId: "research",
  sourceMessageId: MessageId.make("source"),
  action: "new_job",
  workstreamId: "latency",
  workstreamTitle: "Latency",
  goal: "Reduce latency",
  title: "Measure latency",
  message: "Measure latency and report reproducible evidence.",
};
const fixture = Store.layer.pipe(
  Layer.provideMerge(Changes.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);
const seed = Effect.gen(function* () {
  const store = yield* Store.Store;
  const sql = yield* SqlClient.SqlClient;
  yield* store.mutate({ type: "save_lead", projectId, name: "Lead", brief: "Improve the project" });
  yield* store.mutate({ type: "create_channel", projectId, id: "research", name: "Research" });
  yield* store.mutate({ type: "create_channel", projectId, id: "other", name: "Other" });
  yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) VALUES ('source', ${caller}, 'run', 'user', 0, 'now', 'now', '{"text":"Measure latency"}')`;
});

it.effect("launches handed-off jobs with the project's work model and permissions", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* Store.Store;
    const sql = yield* SqlClient.SqlClient;
    const launched = (id: string) =>
      sql<{
        model: string;
        mode: string;
      }>`SELECT json_extract(launch, '$.modelSelection.model') AS model, json_extract(launch, '$.runtimeMode') AS mode FROM t3po_work_routes WHERE id = ${id}`.pipe(
        Effect.map((rows) => rows[0]),
      );
    const launchModel = (id: string) => launched(id).pipe(Effect.map((row) => row?.model));
    const chatModel = yield* reserve(caller, input, model);
    expect(yield* launchModel(chatModel.id)).toBe("test-model");
    const workModel = { instanceId: ProviderInstanceId.make("claude"), model: "work-model" };
    yield* store.mutate({ type: "save_work_model", projectId, modelSelection: workModel });
    yield* store.mutate({ type: "save_work_access", projectId, runtimeMode: "approval-required" });
    // Renaming the lead (also how it names itself) must not drop the chosen model.
    yield* store.mutate({ type: "save_lead", projectId, name: "Renamed", brief: "Improve" });
    expect((yield* store.read).leads[0]?.workModel).toEqual(workModel);
    const chosen = yield* reserve(caller, { ...input, requestId: "second" }, model);
    expect(yield* launched(chosen.id)).toEqual({ model: "work-model", mode: "approval-required" });
    expect((yield* launched(chatModel.id))?.mode).toBe("full-access");
    yield* store.mutate({ type: "save_work_model", projectId, modelSelection: null });
    expect((yield* store.read).leads[0]?.workModel).toBeUndefined();
    const reset = yield* reserve(caller, { ...input, requestId: "third" }, model);
    expect(yield* launchModel(reset.id)).toBe("test-model");
  }).pipe(Effect.provide(fixture)),
);

it.effect("persists before dispatch, groups independent jobs and replays without duplicates", () =>
  Effect.gen(function* () {
    yield* seed;
    const first = yield* reserve(caller, input, model);
    expect(first.state).toBe("queued");
    expect(yield* reserve(caller, input, model)).toEqual(first);
    const second = yield* reserve(
      caller,
      { ...input, requestId: "implementation", title: "Fix latency" },
      model,
    );
    expect(second.workstreamId).toBe(first.workstreamId);
    expect(second.jobId).not.toBe(first.jobId);
    const store = yield* Store.Store;
    const page = yield* store.list({ projectId, channelId: "research", view: "all" });
    expect(page.tasks).toHaveLength(2);
    expect(page.workstreams).toHaveLength(1);
    expect(page.tasks[0]).toMatchObject({
      workspace: { type: "worktree" },
      reviewRequired: false,
      workstreamId: first.workstreamId,
    });
    const conflict = yield* reserve(caller, { ...input, message: "Changed on retry" }, model).pipe(
      Effect.flip,
    );
    expect(conflict.operation).toBe("invalid");
  }).pipe(Effect.provide(fixture)),
);

it.effect(
  "follow-ups reuse a job and reject another channel, forged source, or worker caller",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const first = yield* reserve(caller, input, model);
      const followup = {
        ...input,
        requestId: "correction",
        action: "follow_up" as const,
        workstreamId: first.workstreamId,
        jobId: first.jobId,
        message: "Include the cold-start numbers.",
      };
      expect((yield* reserve(caller, followup, model)).jobId).toBe(first.jobId);
      expect(
        (yield* reserve(
          caller,
          { ...followup, requestId: "report-followup", reportToOrigin: true },
          model,
        ).pipe(Effect.flip)).operation,
      ).toBe("invalid");
      const sql = yield* SqlClient.SqlClient;
      expect(
        yield* sql`SELECT id FROM t3po_work_routes WHERE json_extract(input, '$.requestId') = 'report-followup'`,
      ).toHaveLength(0);
      const store = yield* Store.Store;
      expect((yield* store.list({ projectId, view: "all" })).tasks).toHaveLength(1);
      for (const target of [
        ThreadId.make("t3po-channel:other"),
        ThreadId.make(`t3po-task:${first.jobId}`),
      ])
        expect((yield* reserve(target, followup, model).pipe(Effect.flip)).operation).toBe(
          "invalid",
        );
      expect(
        (yield* reserve(
          caller,
          { ...input, sourceMessageId: MessageId.make("forged") },
          model,
        ).pipe(Effect.flip)).operation,
      ).toBe("invalid");
      yield* store.mutate({ type: "archive_task", projectId, id: first.jobId, archived: true });
      expect(
        (yield* reserve(caller, { ...followup, requestId: "later" }, model).pipe(Effect.flip))
          .operation,
      ).toBe("invalid");
    }).pipe(Effect.provide(fixture)),
);

it.effect("moves grouping without replacing execution and keeps stream closure independent", () =>
  Effect.gen(function* () {
    yield* seed;
    const first = yield* reserve(caller, input, model);
    const second = yield* reserve(
      caller,
      { ...input, requestId: "second", workstreamId: "throughput", workstreamTitle: "Throughput" },
      model,
    );
    const store = yield* Store.Store;
    const original = yield* store.getTask(first.jobId, projectId);
    yield* store.mutate({
      type: "move_job",
      projectId,
      id: first.jobId,
      workstreamId: second.workstreamId,
    });
    expect(yield* store.getTask(first.jobId, projectId)).toMatchObject({
      threadId: original.threadId,
      workstreamId: second.workstreamId,
    });
    expect(
      (yield* store
        .mutate({
          type: "move_job",
          projectId: ProjectId.make("different"),
          id: first.jobId,
          workstreamId: second.workstreamId,
        })
        .pipe(Effect.flip)).operation,
    ).toBe("invalid");
    const page = yield* store.list({ projectId, view: "all" });
    const stream = page.workstreams.find((stream) => stream.id === second.workstreamId)!;
    yield* store.mutate({ type: "save_workstream", ...stream, state: "completed" });
    expect((yield* store.getTask(first.jobId, projectId)).completed).toBe(false);
    yield* store.mutate({ type: "save_workstream", ...stream, state: "active" });
    expect(
      (yield* store.list({ projectId, view: "all" })).workstreams.find(
        (stream) => stream.id === second.workstreamId,
      )?.state,
    ).toBe("active");
  }).pipe(Effect.provide(fixture)),
);

import * as TestClock from "effect/testing/TestClock";
import * as Service from "./Service.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { announce, drain } from "./WorkRunner.ts";

it.effect("recovers queued dispatch after capacity clears and does not relaunch sent jobs", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* Store.Store;
    yield* store.mutate({ type: "save_budget", projectId, maxConcurrent: 1 });
    const receipt = yield* reserve(caller, input, model);
    const launches: string[] = [];
    const threads = {
      getThreadShell: (id: ThreadId) =>
        Effect.succeed(id === caller ? { id: caller, deletedAt: null } : null),
    } as unknown as Threads.ThreadManagementService["Service"];
    const service = {
      launch: (launch: { taskId?: string }) =>
        Effect.sync(() => {
          launches.push(launch.taskId!);
          return { threadId: ThreadId.make(`t3po-task:${launch.taskId}`) };
        }),
    } as unknown as Service.Service["Service"];
    const run = (capacity: boolean) =>
      drain(capacity).pipe(
        Effect.provideService(Threads.ThreadManagementService, threads),
        Effect.provideService(Service.Service, service),
      );
    yield* run(false);
    expect(launches).toEqual([]);
    expect((yield* store.list({ projectId, view: "all" })).tasks[0]?.dispatch).toMatchObject({
      state: "queued",
      reason: "Waiting for machine capacity.",
    });
    yield* TestClock.adjust("16 seconds");
    yield* run(true);
    yield* TestClock.adjust("16 seconds");
    yield* run(true);
    expect(launches).toEqual([receipt.jobId]);
    expect((yield* store.list({ projectId, view: "all" })).tasks[0]?.dispatch?.state).toBe("sent");
  }).pipe(Effect.provide(fixture)),
);

it.effect(
  "an acknowledged follow-up recovers after a crash even when the allowance is exhausted",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.Store;
      const sql = yield* SqlClient.SqlClient;
      const receipt = yield* reserve(caller, input, model);
      yield* sql`UPDATE t3po_work_routes SET state = 'sent' WHERE id = ${receipt.id}`;
      const followup = yield* reserve(
        caller,
        {
          ...input,
          requestId: "follow",
          action: "follow_up",
          workstreamId: receipt.workstreamId,
          jobId: receipt.jobId,
        },
        model,
      );
      yield* store.mutate({ type: "save_budget", projectId, maxConcurrent: 0 });
      const threads = {
        getThreadShell: () => Effect.succeed({ id: caller, deletedAt: null }),
        sendToThread: () => Effect.die("A committed send must not be retried."),
      } as unknown as Threads.ThreadManagementService["Service"];
      yield* sql`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error) VALUES (${`t3po-work:${followup.id}`}, 'thread', ${caller}, 'thread.message-send', 'now', 0, 'accepted', NULL)`;
      yield* drain(false).pipe(
        Effect.provideService(Threads.ThreadManagementService, threads),
        Effect.provideService(Service.Service, {} as Service.Service["Service"]),
      );
      const rows = yield* sql<{
        state: string;
      }>`SELECT state FROM t3po_work_routes WHERE id = ${followup.id}`;
      expect(rows[0]?.state).toBe("sent");
      yield* sql`UPDATE orchestration_command_receipts SET status = 'rejected' WHERE command_id = ${`t3po-work:${followup.id}`}`;
      yield* sql`UPDATE t3po_work_routes SET state = 'queued', next_attempt = 0 WHERE id = ${followup.id}`;
      yield* drain(false).pipe(
        Effect.provideService(Threads.ThreadManagementService, threads),
        Effect.provideService(Service.Service, {} as Service.Service["Service"]),
      );
      const rejected = yield* sql<{
        state: string;
      }>`SELECT state FROM t3po_work_routes WHERE id = ${followup.id}`;
      expect(rejected[0]?.state).toBe("blocked");
    }).pipe(Effect.provide(fixture)),
);

it.effect(
  "hands off only the supplied brief, pins ownership, and permanently fences revoked retries",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.Store;
      const sql = yield* SqlClient.SqlClient;
      const destination = ProjectId.make("receiving");
      yield* store.mutate({
        type: "save_lead",
        projectId: destination,
        name: "Receiver",
        brief: "Destination context",
      });
      yield* store.mutate({ type: "assign_space", projectId, spaceId: "personal" });
      yield* store.mutate({ type: "assign_space", projectId: destination, spaceId: "business" });
      const handoff = { ...input, destinationProjectId: destination };
      expect(yield* reserve(caller, handoff, model).pipe(Effect.isFailure)).toBe(true);
      const grant = {
        type: "connect_space" as const,
        projectId,
        sourceSpaceId: "personal",
        targetSpaceId: "business",
        targetProjectId: destination,
        enabled: true,
      };
      yield* store.mutate(grant);
      const receipt = yield* reserve(caller, handoff, model);
      expect(yield* reserve(caller, handoff, model)).toEqual(receipt);
      const task = yield* store.getTask(receipt.jobId, destination);
      expect(task.brief).toBe(input.message);
      expect(task.channelId).toBeNull();
      expect(task.workspace).toEqual({ type: "worktree" });
      expect((yield* store.list({ projectId, view: "all" })).tasks).toHaveLength(0);
      expect(yield* SpaceConnections.checkHandoff(receipt.jobId).pipe(Effect.isSuccess)).toBe(true);
      expect(
        yield* reserve(
          caller,
          { ...handoff, requestId: "follow", action: "follow_up", jobId: receipt.jobId },
          model,
        ).pipe(Effect.isFailure),
      ).toBe(true);
      yield* store.mutate({ ...grant, enabled: false });
      expect(yield* SpaceConnections.checkHandoff(receipt.jobId).pipe(Effect.isFailure)).toBe(true);
      yield* store.mutate(grant);
      expect(yield* reserve(caller, handoff, model).pipe(Effect.isFailure)).toBe(true);
      const fresh = yield* reserve(
        caller,
        { ...handoff, requestId: "new-authorized-handoff" },
        model,
      );
      expect(fresh.jobId).not.toBe(receipt.jobId);
      expect(
        yield* sql`SELECT source_project_id, target_project_id, revoked FROM t3po_space_handoffs WHERE job_id = ${receipt.jobId}`,
      ).toEqual([{ source_project_id: projectId, target_project_id: destination, revoked: 1 }]);
      expect(yield* store.context(projectId, caller)).toContain(receipt.jobId);
      expect(yield* store.context(destination, task.threadId)).not.toContain("Improve the project");
    }).pipe(Effect.provide(fixture)),
);

it.effect("tells the routing chat once when a job's latest run finishes", () =>
  Effect.gen(function* () {
    yield* seed;
    const sql = yield* SqlClient.SqlClient;
    const receipt = yield* reserve(caller, input, model);
    const job = ThreadId.make(`t3po-task:${receipt.jobId}`);
    const finish = (ordinal: number, status: string, text: string) =>
      Effect.gen(function* () {
        const runId = `run:${ordinal}`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${runId}, ${job}, ${ordinal}, 'codex', ${status}, 'now', '{}')`;
        yield* sql`INSERT INTO t3po_task_executions (run_id, task_id, revision, result_json) VALUES (${runId}, ${receipt.jobId}, 1, json_object('status', ${status}, 'text', ${text}))`;
      });
    const sent: Array<{
      threadId: string;
      senderThreadId?: string;
      commandId: string;
      text: string;
    }> = [];
    const threads = {
      getThreadShell: (id: ThreadId) =>
        Effect.succeed(id === caller ? { id: caller, deletedAt: null, archivedAt: null } : null),
      sendToThread: (send: (typeof sent)[number]) =>
        Effect.gen(function* () {
          sent.push(send);
          yield* sql`INSERT INTO orchestration_command_receipts (command_id, aggregate_kind, aggregate_id, command_type, accepted_at, result_sequence, status, error) VALUES (${send.commandId}, 'thread', ${caller}, 'thread.message-send', 'now', 0, 'accepted', NULL)`;
        }),
    } as unknown as Threads.ThreadManagementService["Service"];
    const tick = announce().pipe(Effect.provideService(Threads.ThreadManagementService, threads));
    yield* finish(1, "cancelled", "Stopped early");
    yield* tick;
    expect(sent).toEqual([]);
    yield* finish(2, "completed", "Plan written to plan.md");
    yield* tick;
    yield* tick;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ threadId: caller, senderThreadId: job });
    expect(sent[0]?.text).toContain("Plan written to plan.md");
    // An older run that finishes late does not report once a newer run exists.
    yield* sql`UPDATE t3po_task_executions SET result_json = json_object('status', 'completed', 'text', 'old') WHERE run_id = 'run:1'`;
    yield* tick;
    expect(sent).toHaveLength(1);
  }).pipe(Effect.provide(fixture)),
);

it.effect("saves notes for the calling chat and hands them to the jobs it routes", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* Store.Store;
    yield* saveNotes(caller, { text: "Preference: report p95, not averages." });
    const saved = yield* saveNotes(caller, {
      edits: [{ oldText: "p95", newText: "p99" }],
    });
    expect(saved).toMatchObject({ channelId: "research", revision: 2, updatedBy: "lead" });
    expect(yield* store.notes(projectId, null)).toBeNull();
    for (const thread of ["t3po-task:other", "ordinary-thread"])
      expect(
        (yield* saveNotes(ThreadId.make(thread), { text: "x" }).pipe(Effect.flip)).operation,
      ).toBe("invalid");
    const job = yield* reserve(caller, input, model);
    const context = JSON.parse(
      yield* store.context(projectId, ThreadId.make(`t3po-task:${job.jobId}`)),
    );
    expect(context.routingNotes).toBe("Preference: report p99, not averages.");
    expect(context.notes).toBeUndefined();
  }).pipe(Effect.provide(fixture)),
);
