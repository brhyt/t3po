import * as NodeOS from "node:os";
import {
  CommandId,
  MessageId,
  ProjectId,
  T3PO_DEFAULT_CONCURRENT_JOBS,
  ThreadId,
  isT3poError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import * as PubSub from "effect/PubSub";
import * as SpaceConnections from "./SpaceConnections.ts";
import * as Store from "./Store.ts";
import * as Service from "./Service.ts";
import * as Changes from "./Changes.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { decodeLaunch, decodeRoute, type RouteRow } from "./Work.ts";

export const drain = Effect.fn("T3poWork.drain")(function* (
  capacityAvailable = (NodeOS.loadavg()[0] ?? 0) < NodeOS.availableParallelism(),
) {
  const sql = yield* SqlClient.SqlClient;
  const service = yield* Service.Service;
  const store = yield* Store.Store;
  const threads = yield* Threads.ThreadManagementService;
  const changes = yield* Changes.Changes;
  const now = DateTime.toEpochMillis(yield* DateTime.now);
  const rows =
    yield* sql<RouteRow>`SELECT id, project_id AS projectId, caller_thread_id AS callerThreadId, job_id AS jobId, workstream_id AS workstreamId, input, launch, state, reason FROM t3po_work_routes WHERE state != 'sent' AND next_attempt <= ${now} ORDER BY next_attempt, sequence LIMIT 20`;
  for (const row of rows) {
    const projectId = ProjectId.make(row.projectId);
    const attempt = yield* Effect.result(
      Effect.gen(function* () {
        yield* SpaceConnections.checkHandoff(row.jobId);
        const input = yield* decodeRoute(row.input);
        const launch = yield* decodeLaunch(row.launch);
        const task = yield* store.getTask(row.jobId, projectId);
        const caller = yield* threads.getThreadShell(ThreadId.make(row.callerThreadId));
        if (!caller || caller.deletedAt || task.archived)
          return "Work is archived or its lead is unavailable.";
        const scope =
          yield* sql`SELECT id FROM t3po_workstreams WHERE id = ${task.workstreamId ?? row.workstreamId} AND json_extract(data, '$.state') != 'archived' AND (channel_id IS NULL OR EXISTS (SELECT 1 FROM t3po_channels c WHERE c.id = t3po_workstreams.channel_id AND COALESCE(json_extract(c.data, '$.archived'), 0) = 0))`;
        if (!scope.length) return "The workstream or channel is archived.";
        const commandId = CommandId.make(`t3po-work:${row.id}`);
        if (input.action === "follow_up") {
          const receipts = yield* sql<{
            status: string;
          }>`SELECT status FROM orchestration_command_receipts WHERE command_id = ${commandId}`;
          if (receipts[0]?.status === "accepted") return null;
          if (receipts[0]?.status === "rejected")
            return "This dispatch was rejected. Ask your lead to retry.";
        }
        if (!capacityAvailable) return "Waiting for machine capacity.";
        const existing = yield* threads.getThreadShell(task.threadId);
        // Replaying an accepted launch must not consume another allowance.
        if (!existing || (input.action === "follow_up" && !existing.activeRunId)) {
          const slots = yield* sql<{
            maxConcurrent: number;
            active: number;
          }>`SELECT COALESCE((SELECT max_concurrent FROM t3po_budgets WHERE project_id = ${projectId}), ${T3PO_DEFAULT_CONCURRENT_JOBS}) AS maxConcurrent, (SELECT count(*) FROM t3po_admissions WHERE project_id = ${projectId} AND active = 1) AS active`;
          if ((slots[0]?.active ?? 0) >= (slots[0]?.maxConcurrent ?? 0))
            return "Waiting for an agent slot in this project.";
        }
        if (input.action === "new_job") {
          yield* service.launch(launch);
        } else {
          if (!existing) return "Waiting for the original job to launch.";
          yield* threads.sendToThread({
            projectId,
            threadId: task.threadId,
            senderThreadId: ThreadId.make(row.callerThreadId),
            commandId,
            messageId: MessageId.make(`t3po-work:${row.id}`),
            text: input.message,
            attachments: [],
            mode: "auto",
            createdBy: "agent",
            creationSource: "mcp",
          });
        }
        return null;
      }),
    );
    const reason =
      attempt._tag === "Success"
        ? attempt.success
        : isT3poError(attempt.failure)
          ? attempt.failure.message
          : "Dispatch needs attention; retrying with the same operation id.";
    const state = reason === null ? "sent" : reason.startsWith("Waiting") ? "queued" : "blocked";
    yield* sql`UPDATE t3po_work_routes SET state = ${state}, reason = ${reason ?? ""}, next_attempt = ${now + 15000} WHERE id = ${row.id}`;
    if (state !== row.state || (reason ?? "") !== row.reason)
      yield* PubSub.publish(changes, { projectId, metadata: false });
  }
});

export const run = Effect.gen(function* () {
  while (true) {
    yield* drain().pipe(Effect.catch((cause) => Effect.logWarning("Work queue retry", cause)));
    yield* Effect.sleep("5 seconds");
  }
});
