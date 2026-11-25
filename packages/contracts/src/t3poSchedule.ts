import * as Schema from "effect/Schema";

import { IsoDateTime, ScheduledTaskId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ScheduledTaskRunStatus,
  ScheduledTaskSchedule,
  ScheduledTaskTimedSchedule,
} from "./scheduledTask.ts";

export const T3poScheduleRequest = Schema.Struct({
  action: Schema.Literals(["list", "create", "update", "delete"]),
  scheduleId: Schema.optional(ScheduledTaskId).annotate({
    description: "Required for update and delete.",
  }),
  title: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  prompt: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(12000))).annotate({
    description: "What you will be told to do when it fires. Required for create.",
  }),
  schedule: Schema.optional(ScheduledTaskTimedSchedule).annotate({
    description:
      "Required for create. fixed_time uses the server timeZone; once takes an ISO time with offset.",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "false pauses, true resumes.",
  }),
});
export type T3poScheduleRequest = typeof T3poScheduleRequest.Type;

export const T3poSchedule = Schema.Struct({
  scheduleId: ScheduledTaskId,
  title: TrimmedNonEmptyString,
  prompt: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
  schedule: ScheduledTaskSchedule,
  nextRunAt: Schema.NullOr(IsoDateTime),
  lastRunAt: Schema.NullOr(IsoDateTime),
  lastRunStatus: ScheduledTaskRunStatus,
  lastRunError: Schema.NullOr(Schema.String),
});
export type T3poSchedule = typeof T3poSchedule.Type;

export const T3poScheduleResult = Schema.Struct({
  /** The server's IANA zone, which fixed_time schedules run in. */
  timeZone: Schema.String,
  /** The server's current time with its offset, for turning "tomorrow at 9" into `once`. */
  now: Schema.String,
  /** This conversation's schedules for list; the saved one for create and update. */
  schedules: Schema.Array(T3poSchedule),
  deletedScheduleId: Schema.optional(ScheduledTaskId),
});
export type T3poScheduleResult = typeof T3poScheduleResult.Type;
