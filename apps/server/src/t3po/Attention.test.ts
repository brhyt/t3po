import { expect, it } from "vite-plus/test";
import { ProjectId, ThreadId, RunId, MessageId, RuntimeRequestId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { taskAttention } from "./Attention.ts";
const encodeUnknown = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const runId = RunId.make("old");
const task = {
  id: "task",
  projectId: ProjectId.make("p"),
  threadId: ThreadId.make("t"),
  channelId: null,
  title: "Task",
  brief: "Work",
  completed: true,
  reviewedRunId: runId,
  createdAt: "now",
};
const result = {
  runId,
  runOrdinal: 1,
  messageId: MessageId.make("m"),
  completedAt: "now",
  checkpointId: null,
  text: "done",
  truncated: false,
};
const shell = {
  latestRunId: runId,
  status: "completed" as const,
  activeRunId: null,
  pendingRuntimeRequest: null,
  hasActionableProposedPlan: false,
};
it("removes reviewed work and never lets an older review hide newer requests or results", () => {
  expect(taskAttention(task, shell, result)).toEqual([]);
  const next = RunId.make("new");
  expect(
    taskAttention(task, { ...shell, latestRunId: next }, { ...result, runId: next }).map(
      (i) => i.reason,
    ),
  ).toEqual(["review"]);
  const waiting = {
    ...shell,
    latestRunId: next,
    status: "waiting" as const,
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("request"),
      kind: "permission" as const,
      createdAt: DateTime.makeUnsafe("2026-11-18T00:00:00Z"),
    },
  };
  const items = taskAttention(task, waiting, result);
  expect(items.map((i) => i.reason)).toEqual(["request"]);
  expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  expect(
    taskAttention(
      task,
      {
        ...waiting,
        pendingRuntimeRequest: {
          ...waiting.pendingRuntimeRequest,
          id: RuntimeRequestId.make("new-request"),
        },
      },
      result,
    )[0]!.key,
  ).not.toBe(items[0]!.key);
  expect(taskAttention(task, { ...waiting, pendingRuntimeRequest: null }, result)).toEqual([]);
  expect(taskAttention(task, { ...shell, status: "failed" }, result).map((i) => i.reason)).toEqual([
    "failed",
  ]);
  expect(taskAttention({ ...task, completed: false }, null, result).map((i) => i.reason)).toEqual([
    "review",
  ]);
});

import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Schema from "effect/Schema";
import * as Attention from "./Attention.ts";
import * as Store from "./Store.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
const projections = Layer.merge(
  Layer.succeed(Store.Store, {
    results: () => Effect.succeed({ results: [result], nextCursor: null }),
  } as unknown as Store.Store["Service"]),
  Layer.succeed(Threads.ThreadManagementService, {
    getThreadShell: () => Effect.succeed(null),
  } as unknown as Threads.ThreadManagementService["Service"]),
);
effectIt.effect("bounds project scans and resumes strictly after the previous task cursor", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (let i = 0; i < 51; i++) {
      const id = `task-${i}`;
      const data = yield* encodeUnknown({
        ...task,
        id,
        completed: false,
      });
      yield* sql`INSERT INTO t3po_tasks(id, project_id, data) VALUES (${id}, ${task.projectId}, ${data})`;
    }
    const queue = yield* Attention.Attention;
    const first = yield* queue.list({ projectId: task.projectId });
    expect(first.items).toHaveLength(50);
    const second = yield* queue.list({ projectId: task.projectId, before: first.nextCursor! });
    expect(second.items.map((item) => item.taskId)).toEqual(["task-0"]);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.key)).size).toBe(51);
    expect((yield* queue.list({ projectId: ProjectId.make("other") })).items).toEqual([]);
  }).pipe(
    Effect.provide(
      Attention.layer.pipe(Layer.provide(projections), Layer.provideMerge(Sqlite.layerMemory)),
    ),
  ),
);
