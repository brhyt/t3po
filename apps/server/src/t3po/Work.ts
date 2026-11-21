// @effect-diagnostics-next-line nodeBuiltinImport:off -- Stable identifiers use a synchronous digest without adding a crypto service to transaction tests.
import * as NodeCrypto from "node:crypto";
import {
  ProjectId,
  ThreadId,
  T3poError,
  isT3poError,
  T3poWorkRoute,
  T3poWorkstream,
  T3poLaunchInput,
  type ModelSelection,
  type T3poWorkReceipt,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as PubSub from "effect/PubSub";
import * as SpaceConnections from "./SpaceConnections.ts";
import * as Store from "./Store.ts";
import * as Changes from "./Changes.ts";

const key = (...parts: string[]) =>
  NodeCrypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
const encode = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeRoute = Schema.encodeEffect(Schema.fromJsonString(T3poWorkRoute));
const encodeLaunch = Schema.encodeEffect(Schema.fromJsonString(T3poLaunchInput));
const decodeStream = Schema.decodeEffect(Schema.fromJsonString(T3poWorkstream));
export const decodeRoute = Schema.decodeEffect(Schema.fromJsonString(T3poWorkRoute));
export const decodeLaunch = Schema.decodeEffect(Schema.fromJsonString(T3poLaunchInput));
export interface RouteRow {
  id: string;
  projectId: string;
  callerThreadId: string;
  jobId: string;
  workstreamId: string;
  input: string;
  launch: string;
  state: T3poWorkReceipt["state"];
  reason: string;
}

export const reserve = Effect.fn("T3poWork.reserve")(
  function* (callerThreadId: ThreadId, input: T3poWorkRoute, modelSelection: ModelSelection) {
    if (input.action === "follow_up" && input.reportToOrigin)
      return yield* new T3poError({ operation: "invalid" });
    const sql = yield* SqlClient.SqlClient;
    const store = yield* Store.Store;
    const changes = yield* Changes.Changes;
    const receipt = yield* sql.withTransaction(
      Effect.gen(function* () {
        const owners = yield* sql<{ projectId: string; channelId: string | null }>`
        SELECT project_id AS projectId, NULL AS channelId FROM t3po_leads WHERE json_extract(data, '$.threadId') = ${callerThreadId}
        UNION SELECT project_id AS projectId, id AS channelId FROM t3po_channels WHERE 't3po-channel:' || id = ${callerThreadId} AND COALESCE(json_extract(data, '$.archived'), 0) = 0 LIMIT 1`;
        let owner = owners[0];
        if (!owner) return yield* new T3poError({ operation: "invalid" });
        const source =
          yield* sql`SELECT message_id FROM orchestration_v2_projection_messages WHERE message_id = ${input.sourceMessageId} AND thread_id = ${callerThreadId} AND role = 'user'`;
        if (!source.length) return yield* new T3poError({ operation: "invalid" });
        const id = key(callerThreadId, input.sourceMessageId, input.requestId);
        const encoded = yield* encodeRoute(input);
        const previous =
          yield* sql<RouteRow>`SELECT id, project_id AS projectId, job_id AS jobId, workstream_id AS workstreamId, input, state, reason FROM t3po_work_routes WHERE id = ${id}`;
        if (previous[0]) {
          if (previous[0].input !== encoded) return yield* new T3poError({ operation: "invalid" });
          yield* SpaceConnections.checkHandoff(previous[0].jobId);
          return previous[0];
        }
        const sourceProjectId = owner.projectId;
        const grant = input.destinationProjectId
          ? yield* SpaceConnections.connection(sourceProjectId, input.destinationProjectId)
          : undefined;
        if (input.destinationProjectId) {
          if (!grant || input.action !== "new_job" || input.reportToOrigin)
            return yield* new T3poError({ operation: "space_boundary" });
          const lead =
            yield* sql`SELECT project_id FROM t3po_leads WHERE project_id = ${input.destinationProjectId}`;
          if (!lead.length) return yield* new T3poError({ operation: "invalid" });
          owner = { projectId: input.destinationProjectId, channelId: null };
        }
        const projectId = ProjectId.make(owner.projectId);
        const streamId = key(
          owner.projectId,
          owner.channelId ?? "",
          ...(grant ? [sourceProjectId] : []),
          input.workstreamId,
        );
        const streams = yield* sql<{
          data: string;
        }>`SELECT data FROM t3po_workstreams WHERE id IN (${grant ? streamId : input.workstreamId}, ${streamId}) AND project_id = ${projectId} AND channel_id IS ${owner.channelId} LIMIT 1`;
        const stream = streams[0]
          ? yield* decodeStream(streams[0].data)
          : {
              id: streamId,
              projectId,
              channelId: owner.channelId,
              title: input.workstreamTitle,
              goal: input.goal,
              state: "active" as const,
            };
        if (stream.state === "archived") return yield* new T3poError({ operation: "invalid" });
        let jobId: string;
        if (input.action === "follow_up") {
          if (!input.jobId || !streams[0]) return yield* new T3poError({ operation: "invalid" });
          const task = yield* store.getTask(input.jobId, projectId);
          if (
            task.archived ||
            task.channelId !== owner.channelId ||
            task.workstreamId !== stream.id
          )
            return yield* new T3poError({ operation: "invalid" });
          jobId = task.id;
          yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.completed', json('false'), '$.reviewedRunId', NULL) WHERE id = ${jobId}`;
        } else {
          if (input.jobId) return yield* new T3poError({ operation: "invalid" });
          jobId = `work:${id}`;
          yield* store.mutate({
            type: "create_task",
            ...(input.reportToOrigin
              ? {
                  origin: { threadId: callerThreadId, messageId: input.sourceMessageId },
                  desiredOutcome: input.goal.trim() || input.message,
                  completionPolicy: "human_review" as const,
                }
              : {}),
            projectId,
            id: jobId,
            channelId: owner.channelId,
            title: input.title,
            brief: input.message,
            workspace: { type: "worktree" },
          });
          yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.workstreamId', ${stream.id}, '$.reviewRequired', json(${input.reportToOrigin || input.reviewRequired ? "true" : "false"})) WHERE id = ${jobId}`;
        }
        if (grant)
          yield* sql`INSERT INTO t3po_space_handoffs (job_id, source_project_id, source_space_id, target_project_id, target_space_id) VALUES (${jobId}, ${sourceProjectId}, ${grant.sourceSpaceId}, ${projectId}, ${grant.targetSpaceId})`;
        const active = { ...stream, state: "active" as const };
        yield* sql`INSERT INTO t3po_workstreams (id, project_id, channel_id, data) VALUES (${stream.id}, ${projectId}, ${owner.channelId}, ${yield* encode(active)}) ON CONFLICT(id) DO UPDATE SET data = excluded.data`;
        const launch = yield* encodeLaunch({
          projectId,
          taskId: jobId,
          modelSelection,
          runtimeMode: "approval-required",
        });
        yield* sql`INSERT INTO t3po_work_routes (id, project_id, caller_thread_id, job_id, workstream_id, input, launch) VALUES (${id}, ${projectId}, ${callerThreadId}, ${jobId}, ${stream.id}, ${encoded}, ${launch})`;
        return {
          id,
          projectId,
          jobId,
          workstreamId: stream.id,
          state: "queued" as const,
          reason: "",
        };
      }),
    );
    yield* PubSub.publish(changes, {
      projectId: ProjectId.make(receipt.projectId),
      metadata: false,
    });
    return {
      id: receipt.id,
      jobId: receipt.jobId,
      workstreamId: receipt.workstreamId,
      state: receipt.state,
      reason: receipt.reason,
    };
  },
  Effect.mapError((cause) =>
    isT3poError(cause) ? cause : new T3poError({ operation: "save", cause }),
  ),
);

export class Work extends Context.Service<
  Work,
  {
    readonly reserve: (
      caller: ThreadId,
      input: T3poWorkRoute,
      model: ModelSelection,
    ) => Effect.Effect<T3poWorkReceipt, T3poError>;
  }
>()("t3/t3po/Work") {}
export const layer = Layer.effect(
  Work,
  Effect.gen(function* () {
    const context = yield* Effect.context<Store.Store | Changes.Changes | SqlClient.SqlClient>();
    return Work.of({
      reserve: Effect.fn("Work.reserve")(
        (caller: ThreadId, input: T3poWorkRoute, model: ModelSelection) =>
          reserve(caller, input, model).pipe(Effect.provide(context)),
      ),
    });
  }),
);

export const optionalLayer = Layer.unwrap(
  Effect.serviceOption(Work).pipe(
    Effect.map((service) =>
      Layer.succeed(
        Work,
        Option.isSome(service)
          ? service.value
          : Work.of({
              reserve: Effect.fn("Work.unavailable")(() =>
                Effect.fail(new T3poError({ operation: "invalid" })),
              ),
            }),
      ),
    ),
  ),
);
