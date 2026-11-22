import { ProjectId, ThreadId, EventId, TurnItemId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as Store from "./ExternalActionStore.ts";

export class ExternalActionExecutor extends Context.Service<
  ExternalActionExecutor,
  {
    readonly execute: (id: string) => Effect.Effect<void, Store.ExternalActionError>;
  }
>()("t3/t3po/ExternalActionExecutor") {}

const isExternalActionError = Schema.is(Store.ExternalActionError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const sink = yield* EventSink.EventSinkV2;
  const executionLock = yield* Semaphore.make(1);
  const execute = Effect.fn("ExternalActionExecutor.execute")(
    function* (id: string) {
      const operation = yield* Store.get(id);
      if (
        operation.state === "succeeded" ||
        operation.state === "declined" ||
        operation.state === "blocked" ||
        operation.state === "pending"
      )
        return;
      const ref = {
        projectId: ProjectId.make(operation.projectId),
        host: operation.host,
        repository: operation.repository,
        number: operation.number,
        expectedAccountId: operation.accountId,
      };
      const finish = Effect.fn("ExternalActionExecutor.finish")(function* (
        state: "succeeded" | "uncertain" | "blocked",
      ) {
        yield* sink.withProviderBatch(
          Effect.gen(function* () {
            const current = yield* Store.get(id);
            if (current.state === state) return;
            yield* Store.finish(id, state);
            const now = yield* DateTime.now;
            const threadId = ThreadId.make(operation.threadId);
            const itemId = `external-outcome:${id}`;
            const outcome =
              state === "succeeded"
                ? "PR is now draft (desired state observed)."
                : state === "blocked"
                  ? "Action not performed: authorization or the verified target is no longer available. Request a new action after checking the connection and job grant."
                  : "Outcome uncertain; no automatic retry. Check the pull request before requesting a new action.";
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`${itemId}:${state}`),
                  type: "turn-item.updated",
                  threadId,
                  occurredAt: now,
                  payload: {
                    id: TurnItemId.make(itemId),
                    type: "system_notice",
                    threadId,
                    runId: null,
                    nodeId: null,
                    providerThreadId: null,
                    providerTurnId: null,
                    nativeItemRef: null,
                    parentItemId: null,
                    ordinal: 0,
                    status: "completed",
                    title: "External action result",
                    startedAt: now,
                    completedAt: now,
                    updatedAt: now,
                    message: `${operation.host}/${operation.repository}#${operation.number} · Account ${operation.accountId}\n${outcome}`,
                  },
                },
              ],
            });
          }),
        );
      });
      const reconcile = Effect.fn("ExternalActionExecutor.reconcile")(function* () {
        // Once the mutation may have started, reads may reconcile it but another write needs a fresh decision.
        const target = yield* Store.validateBinding(operation).pipe(
          Effect.andThen(pullRequests.draftTarget(ref)),
          Effect.option,
        );
        const succeeded =
          target._tag === "Some" &&
          target.value.nodeId === operation.prNodeId &&
          target.value.summary.state === "open" &&
          target.value.summary.isDraft === true;
        yield* finish(succeeded ? "succeeded" : "uncertain");
      });
      if (operation.state === "executing" || operation.state === "uncertain") {
        yield* reconcile();
        return;
      }
      const validated = yield* Store.validate(operation).pipe(Effect.option);
      if (validated._tag === "None") {
        yield* finish("blocked");
        return;
      }
      const targetResult = yield* pullRequests.draftTarget(ref).pipe(Effect.option);
      if (targetResult._tag === "None") {
        yield* finish("blocked");
        return;
      }
      const target = targetResult.value;
      if (target.nodeId !== operation.prNodeId || target.summary.state !== "open") {
        yield* finish("blocked");
        return;
      }
      if (target.summary.isDraft === true) {
        const claimed = yield* Store.claim(id).pipe(Effect.orElseSucceed(() => false));
        if (claimed) yield* finish("succeeded");
        else if ((yield* Store.get(id)).state === "approved") yield* finish("blocked");
        return;
      }
      yield* pullRequests
        .runAction({
          ...ref,
          action: "draft",
          expectedDraftNodeId: operation.prNodeId,
          beforeMutation: Store.claim(id).pipe(
            Effect.provideService(SqlClient.SqlClient, sql),
            Effect.orElseSucceed(() => false),
          ),
        })
        .pipe(Effect.option);
      const current = yield* Store.get(id);
      if (current.state === "executing") yield* reconcile();
      else if (current.state === "approved") yield* finish("blocked");
    },
    Effect.provideService(SqlClient.SqlClient, sql),
    executionLock.withPermit,
    Effect.mapError((error) =>
      isExternalActionError(error)
        ? error
        : new Store.ExternalActionError({ reason: "authority", cause: error }),
    ),
  );
  return ExternalActionExecutor.of({ execute });
});
export const layer = Layer.effect(ExternalActionExecutor, make);
