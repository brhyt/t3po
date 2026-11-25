import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ScheduledTaskId,
  type T3poScheduleRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Changes from "./Changes.ts";
import * as Schedules from "./Schedules.ts";
import * as Store from "./Store.ts";

const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");
const channel = ThreadId.make("t3po-channel:research");
const leadA = ThreadId.make(`t3po-lead:${projectA}`);
const leadB = ThreadId.make(`t3po-lead:${projectB}`);
const callerOf = (threadId: ThreadId, projectId: ProjectId): Schedules.ScheduleCaller => ({
  threadId,
  projectId,
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
  runtimeMode: "full-access",
  interactionMode: "default",
});
const projectOf = (threadId: ThreadId) =>
  threadId === leadB ? projectB : threadId.startsWith("t3po-") ? projectA : projectB;

const fixture = (
  sent: Ref.Ref<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>,
  runDueWork: Ref.Ref<Effect.Effect<void>>,
) =>
  Layer.mergeAll(Schedules.layer, Store.layer).pipe(
    Layer.provideMerge(ScheduledTaskService.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        NodeCrypto.layer,
        ManagedPolicy.layerTest(),
        Changes.layer,
        // Capture the poll pass so the test drives the due run directly.
        Layer.mock(Scheduler.Scheduler)({
          register: (name, work) =>
            name !== "scheduled-tasks"
              ? Effect.void
              : Effect.context<Effect.Services<typeof work>>().pipe(
                  Effect.flatMap((context) =>
                    Ref.set(runDueWork, work.pipe(Effect.provideContext(context), Effect.ignore)),
                  ),
                ),
        }),
        Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/projects",
          isScratchProject: () => Effect.succeed(false),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (threadId) =>
            Effect.succeed({
              projectId: projectOf(threadId),
              deletedAt: null,
              archivedAt: null,
            } as never),
          sendToThread: (input) =>
            Ref.update(sent, (all) => [...all, input]).pipe(Effect.as({} as never)),
          getThreadRecords: () => Effect.succeed({ runs: [], messages: [] } as never),
        }),
        Layer.mock(SecretRequests.SecretRequests)({}),
      ),
    ),
    Layer.provideMerge(Sqlite.layerMemory),
  );

const seed = Effect.gen(function* () {
  const store = yield* Store.Store;
  yield* store.mutate({ type: "save_lead", projectId: projectA, name: "A", brief: "" });
  yield* store.mutate({ type: "save_lead", projectId: projectB, name: "B", brief: "" });
  yield* store.mutate({
    type: "create_channel",
    projectId: projectA,
    id: "research",
    name: "Research",
  });
});

const run = (caller: Schedules.ScheduleCaller, input: T3poScheduleRequest) =>
  Schedules.Schedules.pipe(Effect.flatMap((service) => service.handle(caller, input)));

it.effect(
  "binds a chat's schedule to that chat and keeps other chats' schedules out of reach",
  () =>
    Effect.gen(function* () {
      const sent = yield* Ref.make<
        ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>
      >([]);
      const runDueWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
      yield* Effect.gen(function* () {
        yield* seed;
        const scheduler = yield* ScheduledTaskService.ScheduledTaskService;
        const created = yield* run(callerOf(channel, projectA), {
          action: "create",
          title: "Weekly signups",
          prompt: "Summarize last week's signups for the user.",
          schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1] },
        });
        const scheduleId = created.schedules[0]!.scheduleId;
        expect(created.timeZone).not.toBe("");
        const stored = (yield* scheduler.list()).tasks.find((task) => task.id === scheduleId)!;
        expect(stored).toMatchObject({
          projectId: projectA,
          threadId: channel,
          threadMode: "continue",
          enabled: true,
        });

        const other = yield* run(callerOf(leadB, projectB), {
          action: "create",
          prompt: "Remind the user to send the invoice.",
          schedule: { type: "interval", everyMs: 3_600_000 },
        });
        const otherId = other.schedules[0]!.scheduleId;

        const listed = (thread: ThreadId, project: ProjectId) =>
          run(callerOf(thread, project), { action: "list" }).pipe(
            Effect.map((result) => result.schedules.map((schedule) => schedule.scheduleId)),
          );
        expect(yield* listed(channel, projectA)).toEqual([scheduleId]);
        expect(yield* listed(leadA, projectA)).toEqual([]);
        expect(yield* listed(leadB, projectB)).toEqual([otherId]);

        const refused = (input: T3poScheduleRequest, thread = channel, project = projectA) =>
          run(callerOf(thread, project), input).pipe(
            Effect.flip,
            Effect.map((error) => error.message),
          );
        expect(yield* refused({ action: "delete", scheduleId: otherId })).toContain(
          "No schedule with that scheduleId",
        );
        expect(yield* refused({ action: "update", scheduleId: otherId, enabled: false })).toContain(
          "No schedule with that scheduleId",
        );
        expect(yield* refused({ action: "list" }, channel, projectB)).toContain(
          "Only a live project lead or channel",
        );
        expect(
          yield* refused({ action: "list" }, ThreadId.make("ordinary-thread"), projectB),
        ).toContain("Only a live project lead or channel");
        expect((yield* scheduler.list()).tasks.find((task) => task.id === otherId)?.enabled).toBe(
          true,
        );

        const paused = yield* run(callerOf(channel, projectA), {
          action: "update",
          scheduleId,
          enabled: false,
        });
        expect(paused.schedules[0]).toMatchObject({ enabled: false, nextRunAt: null });
        const deleted = yield* run(callerOf(channel, projectA), { action: "delete", scheduleId });
        expect(deleted.deletedScheduleId).toBe(scheduleId);
        expect(yield* listed(channel, projectA)).toEqual([]);
      }).pipe(Effect.provide(fixture(sent, runDueWork)));
    }),
);

it.effect("sends a due schedule's prompt into its channel as a scheduled message", () =>
  Effect.gen(function* () {
    const sent = yield* Ref.make<ReadonlyArray<ThreadManagementService.ThreadManagementSendInput>>(
      [],
    );
    const runDueWork = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    yield* Effect.gen(function* () {
      yield* seed;
      const created = yield* run(callerOf(channel, projectA), {
        action: "create",
        title: "Site check",
        prompt: "Check the site and tell the user if it is down.",
        schedule: { type: "interval", everyMs: 60_000 },
      });
      const scheduleId: ScheduledTaskId = created.schedules[0]!.scheduleId;
      yield* TestClock.adjust("61 seconds");
      yield* Effect.flatten(Ref.get(runDueWork));
      const [message] = yield* Ref.get(sent);
      expect(message).toMatchObject({
        projectId: projectA,
        threadId: channel,
        scheduledTaskId: scheduleId,
        text: "Check the site and tell the user if it is down.",
      });
      const store = yield* Store.Store;
      expect(yield* store.scheduledTurnNote(scheduleId)).toContain('your schedule "Site check"');
    }).pipe(Effect.provide(fixture(sent, runDueWork)));
  }),
);
