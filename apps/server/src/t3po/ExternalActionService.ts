import { NodeId, ProjectId, RuntimeRequestId, ThreadId, TurnItemId } from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpThreadCaller } from "../mcp/McpInvocationContext.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as TurnItemPositionStore from "../orchestration-v2/TurnItemPositionStore.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ExternalActionStore from "./ExternalActionStore.ts";

export class ExternalActionService extends Context.Service<
  ExternalActionService,
  {
    readonly proposeDraft: (input: {
      readonly caller: McpThreadCaller;
      readonly number: number;
      readonly requestKey: string;
    }) => Effect.Effect<
      { operationId: string; requestId: string; state: string },
      ExternalActionStore.ExternalActionError
    >;
  }
>()("t3/t3po/ExternalActionService") {}

const isExternalActionError = Schema.is(ExternalActionStore.ExternalActionError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const sink = yield* EventSink.EventSinkV2;
  const positions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const proposeDraft = Effect.fn("ExternalActionService.proposeDraft")(
    function* (input: {
      readonly caller: McpThreadCaller;
      readonly number: number;
      readonly requestKey: string;
    }) {
      const execution = input.caller.proposalExecution;
      if (!execution || execution.capability !== "propose-external-action")
        return yield* new ExternalActionStore.ExternalActionError({ reason: "identity" });
      const binding = yield* ExternalActionStore.proposalBinding(input.caller.threadId);
      if (!binding)
        return yield* new ExternalActionStore.ExternalActionError({ reason: "binding" });
      const target = yield* pullRequests.draftTarget({
        projectId: ProjectId.make(binding.projectId),
        host: binding.host,
        repository: binding.repository,
        number: input.number,
        expectedAccountId: binding.accountId,
      });
      return yield* sink.withProviderBatch(
        Effect.gen(function* () {
          const operation = yield* ExternalActionStore.propose({
            threadId: input.caller.threadId,
            ...execution,
            requestKey: input.requestKey,
            accountId: binding.accountId,
            host: binding.host,
            repository: binding.repository,
            number: input.number,
            prNodeId: target.nodeId,
          });
          const threadId = ThreadId.make(operation.threadId);
          const requestId = RuntimeRequestId.make(operation.requestId);
          const nodeId = NodeId.make(operation.nodeId);
          const existing =
            yield* sql`SELECT runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE runtime_request_id = ${requestId}`;
          if (!existing.length && operation.state === "pending") {
            const now = yield* DateTime.now;
            const itemId = TurnItemId.make(`external-action:${operation.id}`);
            const ordinal = yield* positions.allocate({
              threadId,
              turnItemId: itemId,
              runId: null,
            });
            yield* sink.write({
              events: [
                {
                  id: yield* ids.allocate.event({ threadId }),
                  type: "node.updated",
                  threadId,
                  providerInstanceId: input.caller.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    id: nodeId,
                    threadId,
                    runId: null,
                    parentNodeId: null,
                    rootNodeId: nodeId,
                    kind: "approval_request",
                    status: "waiting",
                    countsForRun: false,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    runtimeRequestId: requestId,
                    checkpointScopeId: null,
                    startedAt: now,
                    completedAt: null,
                  },
                },
                {
                  id: yield* ids.allocate.event({ threadId }),
                  type: "runtime-request.updated",
                  threadId,
                  providerInstanceId: input.caller.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    id: requestId,
                    nodeId,
                    providerTurnId: null,
                    nativeRequestRef: null,
                    kind: "permission",
                    status: "pending",
                    responseCapability: { type: "server_action", operationId: operation.id },
                    createdAt: now,
                    resolvedAt: null,
                  },
                },
                {
                  id: yield* ids.allocate.event({ threadId }),
                  type: "turn-item.updated",
                  threadId,
                  providerInstanceId: input.caller.providerInstanceId,
                  occurredAt: now,
                  payload: {
                    id: itemId,
                    threadId,
                    runId: null,
                    nodeId,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal,
                    status: "waiting",
                    title: "Convert pull request to draft",
                    startedAt: now,
                    completedAt: null,
                    updatedAt: now,
                    type: "approval_request",
                    requestId,
                    requestKind: "permission",
                    prompt: `Convert ${operation.host}/${operation.repository}#${operation.number} to draft using account ${operation.accountId}?`,
                    reason: `This approval applies only to this operation, with job grant v${operation.grantVersion} and repository binding v${operation.bindingVersion}.`,
                    options: [
                      { decision: "accept", label: "Approve once" },
                      { decision: "decline", label: "Decline" },
                    ],
                  },
                },
              ],
            });
          }
          return {
            operationId: operation.id,
            requestId: operation.requestId,
            state: operation.state,
          };
        }),
      );
    },
    Effect.provideService(SqlClient.SqlClient, sql),
    Effect.mapError((error) =>
      isExternalActionError(error)
        ? error
        : new ExternalActionStore.ExternalActionError({ reason: "authority" }),
    ),
  );
  return ExternalActionService.of({ proposeDraft });
});
export const layer = Layer.effect(ExternalActionService, make);
