import {
  ProjectId,
  ScheduledTaskError,
  ScheduledTaskId,
  ThreadId,
  type ModelSelection,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ScheduledTask,
  type T3poSchedule,
  type T3poScheduleRequest,
  type T3poScheduleResult,
  scheduledTaskThreadMode,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";

export interface ScheduleCaller {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode;
}

const fail = (message: string, taskId?: ScheduledTaskId) =>
  new ScheduledTaskError({ message, ...(taskId === undefined ? {} : { taskId }) });

const summary = (task: ScheduledTask): T3poSchedule => ({
  scheduleId: task.id,
  title: task.title,
  prompt: task.prompt,
  enabled: task.enabled,
  schedule: task.schedule,
  nextRunAt: task.nextRunAt,
  lastRunAt: task.lastRunAt,
  lastRunStatus: task.lastRunStatus,
  lastRunError: task.lastRunError,
});

/** Schedules a lead or channel keeps for its own conversation; each run continues that chat. */
const handle = Effect.fn("T3poSchedules.handle")(function* (
  caller: ScheduleCaller,
  input: T3poScheduleRequest,
) {
  const sql = yield* SqlClient.SqlClient;
  const scheduler = yield* ScheduledTaskService.ScheduledTaskService;
  const owners = yield* sql<{ projectId: string }>`
    SELECT project_id AS projectId FROM t3po_leads WHERE json_extract(data, '$.threadId') = ${caller.threadId}
    UNION SELECT project_id AS projectId FROM t3po_channels WHERE 't3po-channel:' || id = ${caller.threadId} AND COALESCE(json_extract(data, '$.archived'), 0) = 0`.pipe(
    Effect.mapError(
      (cause) => new ScheduledTaskError({ message: "Could not read the chat.", cause }),
    ),
  );
  if (!owners.some((owner) => owner.projectId === caller.projectId))
    return yield* fail("Only a live project lead or channel chat can keep schedules.");
  const listed = yield* scheduler.list();
  const own = listed.tasks.filter(
    (task) => task.threadId === caller.threadId && task.projectId === caller.projectId,
  );
  const now = DateTime.formatIsoOffset(
    yield* DateTime.withCurrentZoneLocal(DateTime.nowInCurrentZone),
  );
  const result = (
    schedules: ReadonlyArray<ScheduledTask>,
    deleted?: ScheduledTaskId,
  ): T3poScheduleResult => ({
    timeZone: listed.timeZone ?? "UTC",
    now,
    schedules: schedules.map(summary),
    ...(deleted === undefined ? {} : { deletedScheduleId: deleted }),
  });
  const find = (id: ScheduledTaskId | undefined) => {
    const task = own.find((candidate) => candidate.id === id);
    return task === undefined
      ? Effect.fail(fail("No schedule with that scheduleId in this chat. List them first."))
      : Effect.succeed(task);
  };

  switch (input.action) {
    case "list":
      return result(own);
    case "create": {
      if (input.prompt === undefined || input.schedule === undefined)
        return yield* fail("A new schedule needs `prompt` and `schedule`.");
      const { task } = yield* scheduler.upsert({
        title: input.title ?? input.prompt.split("\n")[0]!.slice(0, 80).trim(),
        prompt: input.prompt,
        enabled: input.enabled ?? true,
        schedule: input.schedule,
        projectId: caller.projectId,
        threadId: caller.threadId,
        threadMode: "continue",
        workspaceStrategy: { type: "root" },
        modelSelection: caller.modelSelection,
        runtimeMode: caller.runtimeMode,
        interactionMode: caller.interactionMode,
        createdBy: "agent",
        creationSource: "mcp",
      });
      return result([task]);
    }
    case "update": {
      const existing = yield* find(input.scheduleId);
      if (input.title === undefined && input.prompt === undefined && input.schedule === undefined) {
        if (input.enabled === undefined) return result([existing]);
        const { task } = yield* scheduler.setEnabled({ id: existing.id, enabled: input.enabled });
        return result([task]);
      }
      const schedule =
        input.schedule ?? (existing.schedule.type === "webhook" ? undefined : existing.schedule);
      if (schedule === undefined)
        return yield* fail("Webhook automations are managed in Settings.", existing.id);
      const { task } = yield* scheduler.upsert({
        id: existing.id,
        requireExisting: true,
        title: input.title ?? existing.title,
        prompt: input.prompt ?? existing.prompt,
        enabled: input.enabled ?? existing.enabled,
        schedule,
        projectId: existing.projectId,
        threadId: caller.threadId,
        // Keep a fresh-session choice made in Settings.
        threadMode: scheduledTaskThreadMode(existing),
        workspaceStrategy: existing.workspaceStrategy,
        modelSelection: existing.modelSelection,
        runtimeMode: existing.runtimeMode,
        interactionMode: existing.interactionMode,
        createdBy: existing.createdBy,
        creationSource: existing.creationSource,
      });
      return result([task]);
    }
    case "delete": {
      const existing = yield* find(input.scheduleId);
      yield* scheduler.delete({ id: existing.id });
      return result([], existing.id);
    }
  }
});

export class Schedules extends Context.Service<
  Schedules,
  {
    readonly handle: (
      caller: ScheduleCaller,
      input: T3poScheduleRequest,
    ) => Effect.Effect<T3poScheduleResult, ScheduledTaskError>;
  }
>()("t3/t3po/Schedules") {}

export const layer = Layer.effect(
  Schedules,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      SqlClient.SqlClient | ScheduledTaskService.ScheduledTaskService
    >();
    return Schedules.of({
      handle: Effect.fn("Schedules.handle")((caller: ScheduleCaller, input: T3poScheduleRequest) =>
        handle(caller, input).pipe(Effect.provide(context)),
      ),
    });
  }),
);

/** Uses the server's service when present; toolkits built without t3po refuse the tool. */
export const optionalLayer = Layer.unwrap(
  Effect.serviceOption(Schedules).pipe(
    Effect.map((service) =>
      Layer.succeed(
        Schedules,
        Option.isSome(service)
          ? service.value
          : Schedules.of({
              handle: Effect.fn("Schedules.unavailable")(() =>
                Effect.fail(new ScheduledTaskError({ message: "Schedules are unavailable." })),
              ),
            }),
      ),
    ),
  ),
);
