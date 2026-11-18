import * as TestClock from "effect/testing/TestClock";
import * as PubSub from "effect/PubSub";
import * as Fiber from "effect/Fiber";
import * as Changes from "./Changes.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  NodeId,
  ProviderDriverKind,
  RunId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import { recordDelegation } from "./Delegation.ts";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Store from "./Store.ts";
import * as Sqlite from "../persistence/Sqlite.ts";

const database = Sqlite.layerMemory;
const projectId = ProjectId.make("project-a");
const otherProjectId = ProjectId.make("project-b");
const task = {
  type: "create_task" as const,
  projectId,
  id: "task-a",
  channelId: null,
  title: "Investigate recall",
  brief: "Compare the search results and report evidence.",
};

const seedResult = Effect.fn("test.seedResult")(function* (ordinal: number) {
  const sql = yield* SqlClient.SqlClient;
  const runId = `result-${ordinal}`;
  const messageId = `answer-${ordinal}`;
  const threadId = "t3po-task:task-a";
  const now = "2026-11-18T12:00:00.000Z";
  const message = JSON.stringify({ text: `Result ${ordinal}: [report](/repo/report.md)` });
  const item = JSON.stringify({
    messageId,
    text: "",
    textOmitted: true,
    phase: "final_answer",
    streaming: false,
  });
  yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json) VALUES (${runId}, ${threadId}, ${ordinal}, 'codex', 'completed', ${now}, ${now}, '{"checkpointId":null}')`;
  yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, run_id, role, streaming, created_at, updated_at, payload_json) VALUES (${messageId}, ${threadId}, ${runId}, 'assistant', 0, ${now}, ${now}, ${message})`;
  yield* sql`INSERT INTO orchestration_v2_projection_turn_items (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json) VALUES (${messageId}, ${threadId}, ${runId}, ${ordinal}, 'assistant_message', 'completed', ${now}, ${item})`;
});

it.effect(
  "retains completed results through revisions, review and archival with bounded history",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      const sql = yield* SqlClient.SqlClient;
      yield* store.mutate(task);
      for (let ordinal = 1; ordinal <= 12; ordinal++) yield* seedResult(ordinal);
      const input = { projectId, taskId: task.id };
      const page = yield* store.results(input);
      expect(page.results).toHaveLength(10);
      expect(page.results[0]).toMatchObject({
        runId: "result-12",
        runOrdinal: 12,
        text: "Result 12: [report](/repo/report.md)",
      });
      expect(page.nextCursor).toBe(3);
      const longText = "x".repeat(12001);
      yield* sql`UPDATE orchestration_v2_projection_messages SET payload_json = json_set(payload_json, '$.text', ${longText}) WHERE message_id = 'answer-12'`;
      const excerpt = (yield* store.results(input)).results[0]!;
      expect(excerpt.text).toHaveLength(12000);
      expect(excerpt.truncated).toBe(true);
      yield* sql`INSERT INTO orchestration_v2_projection_messages (message_id, thread_id, role, streaming, created_at, updated_at, payload_json) VALUES ('revision-request', 't3po-task:task-a', 'user', 0, '2026-11-18T13:00:00Z', '2026-11-18T13:00:00Z', '{"text":"Please revise"}')`;
      expect((yield* store.results(input)).results[0]).toEqual(excerpt);
      expect(
        (yield* store.results({ ...input, before: page.nextCursor! })).results.map(
          (result) => result.runOrdinal,
        ),
      ).toEqual([2, 1]);
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'running' WHERE run_id = 'result-12'`;
      expect((yield* store.results(input)).results[0]?.runOrdinal).toBe(11);
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'failed' WHERE run_id = 'result-12'`;
      expect((yield* store.results(input)).results[0]?.runOrdinal).toBe(11);
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE run_id = 'result-12'`;
      yield* sql`UPDATE orchestration_v2_projection_turn_items SET payload_json = json_set(payload_json, '$.phase', 'commentary') WHERE run_id = 'result-12'`;
      expect((yield* store.results(input)).results[0]?.runOrdinal).toBe(11);
      yield* store.mutate(
        { type: "review_task", projectId, id: task.id, completed: true },
        RunId.make("result-11"),
      );
      yield* store.mutate({ type: "review_task", projectId, id: task.id, completed: false });
      yield* store.mutate({ type: "archive_task", projectId, id: task.id, archived: true });
      expect((yield* store.results(input)).results[0]?.runOrdinal).toBe(11);
      yield* store.mutate({ type: "archive_task", projectId, id: task.id, archived: false });
      expect((yield* store.results(input)).results[0]?.runOrdinal).toBe(11);
      expect(
        (yield* store.results({ ...input, projectId: otherProjectId }).pipe(Effect.flip)).operation,
      ).toBe("invalid");
    }).pipe(Effect.provide(Store.layer.pipe(Layer.provideMerge(database)))),
);

it.effect(
  "retains lead identity, task ownership and launch selection across service reconstruction",
  () =>
    Effect.gen(function* () {
      const first = yield* Store.Store.pipe(Effect.provide(Store.layer));
      yield* first.mutate({
        type: "save_lead",
        projectId,
        name: "Studio lead",
        brief: "Improve memory recall.",
      });
      yield* first.mutate(task);
      yield* first.mutate(task);
      const selection = {
        projectId,
        taskId: task.id,
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
        runtimeMode: "approval-required" as const,
      };
      const reserved = yield* first.reserveLaunch(task.id, projectId, selection);
      const second = yield* Store.Store.pipe(Effect.provide(Layer.fresh(Store.layer)));
      expect((yield* second.read).tasks).toHaveLength(1);
      expect(
        yield* second.reserveLaunch(task.id, projectId, {
          ...selection,
          runtimeMode: "full-access",
        }),
      ).toEqual(reserved);
      yield* second.mutate({
        type: "save_lead",
        projectId,
        name: "Renamed lead",
        brief: "Use fresh evidence.",
      });
      const records = yield* second.read;
      expect(records.leads[0]?.threadId).toBe("t3po-lead:project-a");
      const context = yield* second.context(projectId, ThreadId.make("t3po-lead:project-a"));
      expect(context).toContain("Use fresh evidence.");
      expect(context).toContain("Investigate recall");
      expect(yield* second.context(otherProjectId, ThreadId.make("t3po-lead:project-a"))).toBe("");
      expect(yield* second.context(projectId, ThreadId.make("ordinary-thread"))).toBe("");
      expect(
        (yield* second
          .reserveLaunch(task.id, otherProjectId, { ...selection, projectId: otherProjectId })
          .pipe(Effect.flip)).operation,
      ).toBe("invalid");
    }).pipe(Effect.provide(database)),
);

it.effect("rejects cross-project channels and review mutations without modifying the task", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* store.mutate({
      type: "create_channel",
      id: "research",
      projectId: otherProjectId,
      name: "Research",
    });
    expect(
      (yield* store.mutate({ ...task, channelId: "research" }).pipe(Effect.flip)).operation,
    ).toBe("invalid");
    expect((yield* store.read).tasks).toHaveLength(0);
    yield* store.mutate(task);
    expect(
      (yield* store
        .mutate({ type: "review_task", id: task.id, projectId: otherProjectId, completed: true })
        .pipe(Effect.flip)).operation,
    ).toBe("invalid");
    expect((yield* store.read).tasks[0]?.completed).toBe(false);
    for (const input of [
      {
        type: "edit_task" as const,
        id: task.id,
        projectId: otherProjectId,
        title: "Wrong",
        brief: "Wrong",
        channelId: null,
      },
      { type: "archive_task" as const, id: task.id, projectId: otherProjectId, archived: true },
      { type: "edit_channel" as const, id: "research", projectId, name: "Wrong" },
      { type: "archive_channel" as const, id: "research", projectId, archived: true },
      {
        type: "edit_task" as const,
        id: task.id,
        projectId,
        title: "Wrong",
        brief: "Wrong",
        channelId: "research",
      },
    ])
      expect((yield* store.mutate(input).pipe(Effect.flip)).operation).toBe("invalid");
    expect((yield* store.read).tasks[0]?.title).toBe(task.title);
  }).pipe(Effect.provide(Store.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);

it.effect("records a lead delegation atomically and preserves review state on replay", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    const sql = yield* SqlClient.SqlClient;
    yield* store.mutate({
      type: "save_lead",
      projectId,
      name: "Studio lead",
      brief: "Project context",
    });
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("t3po-lead:project-a");
    const childThreadId = ThreadId.make("delegated-worker");
    const event: OrchestrationV2DomainEvent = {
      id: EventId.make("delegation-event"),
      type: "subagent.updated",
      threadId,
      occurredAt: now,
      payload: {
        id: NodeId.make("child"),
        threadId,
        runId: RunId.make("parent-run"),
        parentNodeId: NodeId.make("parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex"),
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Investigate recall",
        title: "Recall research",
        model: "test-model",
        status: "running",
        result: null,
        startedAt: now,
        completedAt: null,
        updatedAt: now,
      },
    };
    yield* sql
      .withTransaction(recordDelegation(event).pipe(Effect.andThen(Effect.fail("rollback"))))
      .pipe(Effect.flip);
    expect((yield* store.read).tasks).toHaveLength(0);
    yield* sql.withTransaction(recordDelegation(event));
    expect((yield* store.read).tasks[0]?.threadId).toBe(childThreadId);
    yield* store.mutate(
      { type: "review_task", projectId, id: "delegation:child", completed: true },
      RunId.make("worker-run"),
    );
    yield* sql.withTransaction(recordDelegation(event));
    const tasks = (yield* store.read).tasks;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.reviewedRunId).toBe("worker-run");
    expect(tasks[0]?.completed).toBe(true);
    expect(yield* store.context(projectId, childThreadId)).toContain("Project context");
  }).pipe(Effect.provide(Store.layer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
);

it.effect("reloads saved project work after closing and reopening the database", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped();
    const filename = path.join(directory, "state.sqlite");
    const openStore = () => Store.layer.pipe(Layer.provide(Sqlite.layerFromPath(filename)));
    yield* Effect.gen(function* () {
      const store = yield* Store.Store;
      yield* store.mutate({
        type: "save_lead",
        projectId,
        name: "Persistent lead",
        brief: "Remember the project goals.",
      });
      yield* store.mutate(task);
      yield* seedResult(1);
    }).pipe(Effect.provide(Store.layer.pipe(Layer.provideMerge(Sqlite.layerFromPath(filename)))));
    const restored = yield* Store.Store.pipe(
      Effect.flatMap((store) => store.read),
      Effect.provide(openStore()),
    );
    expect(restored.leads[0]?.name).toBe("Persistent lead");
    expect(restored.tasks[0]?.brief).toBe(task.brief);
    const results = yield* Store.Store.pipe(
      Effect.flatMap((store) => store.results({ projectId, taskId: task.id })),
      Effect.provide(openStore()),
    );
    expect(results.results[0]?.text).toContain("Result 1");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "edits and moves tasks without replacing history, restores archives, and bounds pages",
  () =>
    Effect.gen(function* () {
      const store = yield* Store.Store;
      yield* store.mutate({ type: "save_lead", projectId, name: "Lead", brief: "Context" });
      yield* store.mutate({ type: "create_channel", projectId, id: "work", name: "Work" });
      yield* store.mutate({ ...task, workspace: { type: "worktree" } });
      yield* store.mutate({
        type: "edit_task",
        projectId,
        id: task.id,
        title: "Updated",
        brief: "New assignment",
        channelId: "work",
        workspace: { type: "worktree", baseRef: "local-feature", startFromOrigin: false },
      });
      expect((yield* store.read).tasks[0]).toMatchObject({
        id: task.id,
        threadId: "t3po-task:task-a",
        title: "Updated",
        channelId: "work",
      });
      expect(yield* store.context(projectId, ThreadId.make("t3po-task:task-a"))).toContain(
        "New assignment",
      );
      yield* store.mutate({ type: "edit_channel", projectId, id: "work", name: "Engineering" });
      yield* store.mutate({ type: "archive_channel", projectId, id: "work", archived: true });
      expect((yield* store.read).tasks).toHaveLength(1);
      expect(
        (yield* store.mutate({ ...task, id: "rejected", channelId: "work" }).pipe(Effect.flip))
          .operation,
      ).toBe("invalid");
      yield* store.mutate({
        type: "edit_task",
        projectId,
        id: task.id,
        title: "Updated",
        brief: "New assignment",
        channelId: null,
      });
      yield* store.mutate({ type: "archive_task", projectId, id: task.id, archived: true });
      expect((yield* store.read).tasks).toHaveLength(0);
      expect((yield* store.list({ view: "archived" })).tasks[0]?.id).toBe(task.id);
      yield* store.mutate({ type: "archive_task", projectId, id: task.id, archived: false });
      yield* store.mutate({ type: "archive_channel", projectId, id: "work", archived: false });
      expect((yield* store.read).channels[0]?.name).toBe("Engineering");
      for (let index = 0; index < 55; index++)
        yield* store.mutate({ ...task, id: `page-${index}` });
      const page = yield* store.list({ projectId });
      expect(page.tasks).toHaveLength(50);
      expect(page.nextCursor).not.toBeNull();
      const next = yield* store.list({ projectId, before: page.nextCursor! });
      expect(next.tasks).toHaveLength(6);
      expect(next.nextCursor).toBeNull();
      expect(
        next.tasks.every((record) => !page.tasks.some((other) => record.id === other.id)),
      ).toBe(true);
      expect((yield* store.list({ projectId: otherProjectId })).tasks).toHaveLength(0);
      expect((yield* store.list({ metadataOnly: true })).tasks).toHaveLength(0);
      for (let index = 0; index < 55; index++)
        yield* store.mutate({
          type: "review_task",
          projectId,
          id: `page-${index}`,
          completed: true,
        });
      const completed = yield* store.list({ projectId, view: "completed" });
      expect(completed.tasks).toHaveLength(50);
      expect(
        (yield* store.list({ projectId, view: "completed", before: completed.nextCursor! })).tasks,
      ).toHaveLength(5);
      expect((yield* store.list({ projectId, view: "open" })).tasks).toHaveLength(1);
    }).pipe(Effect.provide(Store.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);

it.effect(
  "queues reviewed continuity durably, retries failed delivery and isolates project recall",
  () => {
    let online = false;
    const requests: { projectId: string; events: { id: string; kind: string }[] }[] = [];
    const fetcher: typeof globalThis.fetch = async (_url, options) => {
      const input = JSON.parse(new TextDecoder().decode(options?.body as Uint8Array));
      requests.push(input);
      return online
        ? Response.json({
            acceptedIds: input.events.map((event: { id: string }) => event.id),
            context: "Remember the approved decision.",
            available: true,
          })
        : new Response("offline", { status: 503 });
    };
    return Effect.gen(function* () {
      const store = yield* Store.Store;
      const brief = {
        type: "save_lead" as const,
        projectId,
        name: "Lead",
        brief: "Keep decisions with evidence.",
      };
      yield* store.mutate(brief);
      yield* store.mutate(brief);
      yield* store.mutate({ ...brief, projectId: otherProjectId, brief: "Private other project" });
      yield* store.mutate(task);
      yield* seedResult(1);
      yield* store.mutate(
        { type: "review_task", projectId, id: task.id, completed: true },
        RunId.make("result-1"),
      );
      yield* store.mutate(
        { type: "review_task", projectId, id: task.id, completed: true },
        RunId.make("result-1"),
      );
      expect(
        (yield* store.read).memory.find((entry) => entry.projectId === projectId)?.pending,
      ).toBe(2);
      const local = yield* store.context(
        projectId,
        ThreadId.make("t3po-lead:project-a"),
        "What did we decide?",
      );
      expect(local).toContain("Result 1");
      expect(local).not.toContain("Private other project");
      expect(
        (yield* store.read).memory.find((entry) => entry.projectId === projectId)?.pending,
      ).toBe(2);
      const restarted = yield* Store.Store.pipe(Effect.provide(Layer.fresh(Store.layer)));
      online = true;
      yield* TestClock.adjust("2 seconds");
      expect(yield* restarted.context(projectId, ThreadId.make("t3po-lead:project-a"))).toContain(
        "Remember the approved decision.",
      );
      expect(requests[1]?.events).toEqual(requests[0]?.events);
      expect(requests.every((request) => request.projectId === projectId)).toBe(true);
      expect(
        (yield* restarted.read).memory.find((entry) => entry.projectId === projectId)?.pending,
      ).toBe(0);
      expect(
        (yield* restarted.read).memory.find((entry) => entry.projectId === otherProjectId)?.pending,
      ).toBe(1);
      yield* restarted.context(projectId, ThreadId.make("t3po-task:task-a"));
      expect(requests).toHaveLength(2);
      expect(yield* restarted.context(projectId, ThreadId.make("t3po-lead:project-b"))).toBe("");
      yield* restarted.mutate({
        type: "edit_task",
        projectId,
        id: task.id,
        title: task.title,
        brief: "Reconsider",
        channelId: null,
      });
      const sql = yield* SqlClient.SqlClient;
      expect(
        (yield* sql<{
          kind: string;
        }>`SELECT kind FROM t3po_memory_events WHERE project_id = ${projectId} ORDER BY sequence DESC LIMIT 1`)[0]
          ?.kind,
      ).toBe("review_reopened");
    }).pipe(
      Effect.provide(
        Store.layer.pipe(
          Layer.provideMerge(database),
          Layer.provideMerge(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                T3PO_MEMORY_URL: "http://memory.test",
                T3PO_MEMORY_TOKEN: "test-token",
              }),
            ),
          ),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetcher),
    );
  },
);

it.effect(
  "delivers without lead turns, recovers after restart, and fairly bounds retries and batches",
  () => {
    const requests: { projectId: string; query: string; events: { id: string }[] }[] = [];
    let mode: "offline" | "unknown" | "partial" | "online" = "offline";
    const fetcher: typeof globalThis.fetch = async (_url, options) => {
      const input = JSON.parse(new TextDecoder().decode(options?.body as Uint8Array));
      requests.push(input);
      if (mode === "offline") return new Response("offline", { status: 503 });
      if (mode === "unknown")
        return Response.json({
          acceptedIds: [input.events[0].id, "foreign-id"],
          context: "",
          available: true,
        });
      return Response.json({
        acceptedIds: input.events
          .slice(0, mode === "partial" ? 1 : 20)
          .map((event: { id: string }) => event.id),
        context: "",
        available: true,
      });
    };
    return Effect.gen(function* () {
      const store = yield* Store.Store;
      const changes = yield* Changes.Changes;
      const notifications = yield* PubSub.subscribe(changes);
      yield* store.mutate({ type: "save_lead", projectId, name: "Lead", brief: "Initial" });
      const first = yield* store.runMemoryWorker.pipe(Effect.forkScoped);
      yield* PubSub.take(notifications);
      expect(requests).toHaveLength(1);
      expect((yield* store.read).memory[0]?.pending).toBe(1);
      yield* Fiber.interrupt(first);
      // A new Store over the same database must retain the outage cooldown.
      const restarted = yield* Store.Store.pipe(Effect.provide(Layer.fresh(Store.layer)));
      for (let index = 0; index < 24; index++)
        yield* restarted.mutate({
          type: "save_lead",
          projectId,
          name: "Lead",
          brief: String(index),
        });
      yield* restarted.mutate({
        type: "save_lead",
        projectId: otherProjectId,
        name: "Other",
        brief: "Isolated",
      });
      const worker = yield* store.runMemoryWorker.pipe(Effect.forkScoped);
      yield* PubSub.take(notifications);
      expect(requests.at(-1)?.projectId).toBe(otherProjectId);
      mode = "unknown";
      yield* TestClock.adjust("2 seconds");
      yield* PubSub.take(notifications);
      yield* PubSub.take(notifications);
      expect(
        (yield* store.read).memory.find((entry) => entry.projectId === projectId)?.pending,
      ).toBe(25);
      mode = "partial";
      yield* TestClock.adjust("4 seconds");
      yield* PubSub.take(notifications);
      yield* PubSub.take(notifications);
      expect(
        requests.filter((request) => request.projectId === projectId).at(-1)?.events,
      ).toHaveLength(20);
      expect(
        (yield* store.read).memory.find((entry) => entry.projectId === projectId)?.pending,
      ).toBe(24);
      mode = "online";
      yield* TestClock.adjust("8 seconds");
      yield* PubSub.take(notifications);
      expect(
        (yield* store.read).memory.find((entry) => entry.projectId === projectId)?.pending,
      ).toBe(4);
      yield* TestClock.adjust("1 second");
      yield* PubSub.take(notifications);
      expect((yield* store.read).memory.every((entry) => entry.pending === 0)).toBe(true);
      expect(requests.every((request) => request.query === "" && request.events.length <= 20)).toBe(
        true,
      );
      yield* Fiber.interrupt(worker);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Store.layer.pipe(
          Layer.provideMerge(database),
          Layer.provideMerge(Changes.layer),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                T3PO_MEMORY_URL: "http://memory.test",
                T3PO_MEMORY_TOKEN: "test-token",
              }),
            ),
          ),
        ),
      ),
      Effect.provideService(FetchHttpClient.Fetch, fetcher),
    );
  },
);

it.effect(
  "recovers persisted records in a new store and coordinates concurrent recall with delivery",
  () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const requests: { events: { id: string }[]; query: string }[] = [];
    const fetcher: typeof globalThis.fetch = async (_url, options) => {
      const input = JSON.parse(new TextDecoder().decode(options?.body as Uint8Array));
      requests.push(input);
      if (requests.length === 1) {
        entered.resolve();
        await release.promise;
      }
      return Response.json({
        acceptedIds: input.events.map((event: { id: string }) => event.id),
        context: input.query ? "Recalled" : "",
        available: Boolean(input.query),
      });
    };
    const configured = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        T3PO_MEMORY_URL: "http://memory.test",
        T3PO_MEMORY_TOKEN: "test-token",
      }),
    );
    return Effect.gen(function* () {
      yield* Effect.gen(function* () {
        const store = yield* Store.Store;
        yield* store.mutate({ type: "save_lead", projectId, name: "Lead", brief: "Persisted" });
      }).pipe(Effect.provide(Layer.fresh(Store.layer)));
      yield* Effect.gen(function* () {
        const store = yield* Store.Store;
        const changes = yield* Changes.Changes;
        const notifications = yield* PubSub.subscribe(changes);
        yield* store.runMemoryWorker.pipe(Effect.forkScoped);
        yield* Effect.promise(() => entered.promise);
        const recall = yield* store
          .context(projectId, ThreadId.make("t3po-lead:project-a"), "Recall")
          .pipe(Effect.forkScoped);
        // The mutation must commit while the gateway request is still blocked.
        yield* store.mutate({ type: "save_lead", projectId, name: "Lead", brief: "Newer" });
        release.resolve();
        yield* PubSub.take(notifications);
        expect(yield* Fiber.join(recall)).toContain("Recalled");
        expect(requests[0]?.events).toHaveLength(1);
        expect(requests[1]?.events).toHaveLength(0);
        expect((yield* store.read).memory[0]?.pending).toBe(1);
        yield* TestClock.adjust("1 second");
        yield* PubSub.take(notifications);
        yield* PubSub.take(notifications);
        expect((yield* store.read).memory[0]?.pending).toBe(0);
        expect(requests[2]?.events[0]?.id).not.toBe(requests[0]?.events[0]?.id);
        expect((yield* store.read).memory[0]?.available).toBe(true);
      }).pipe(
        Effect.scoped,
        Effect.provide(Layer.fresh(Store.layer.pipe(Layer.provideMerge(Changes.layer)))),
      );
    }).pipe(
      Effect.provide(Layer.merge(database, configured)),
      Effect.provideService(FetchHttpClient.Fetch, fetcher),
    );
  },
);
