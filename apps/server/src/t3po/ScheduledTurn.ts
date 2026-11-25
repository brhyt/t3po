import type { ScheduledTaskId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Tells a lead that this turn is a schedule firing, not the user typing. */
export const note = Effect.fn("T3poScheduledTurn.note")(function* (taskId: ScheduledTaskId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    title: string;
  }>`SELECT title FROM scheduled_tasks WHERE task_id = ${taskId}`;
  const title = rows[0]?.title ?? "a deleted schedule";
  return `Scheduled run: the user message at the end of this input is the prompt of your schedule "${title.replaceAll('"', "'")}" (scheduleId ${taskId}), sent automatically at its scheduled time. The user did not type it and may not be watching. Do what it asks: if it is a reminder, write the reminder to the user; if it needs work, route a job with this message as sourceMessageId. Manage it with t3_work_schedule.`;
});
