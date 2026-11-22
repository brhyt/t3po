import type { RunAttemptId, RunId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import { McpSessionRegistry } from "../mcp/McpSessionRegistry.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

/** Opt-in prerequisite only: callers must persist the returned fresh native thread before starting. */
export const prepareProposalThread = Effect.fn("prepareProposalThread")(function* (input: {
  readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
  readonly thread: ProviderAdapter.ProviderAdapterV2EnsureThreadInput;
  readonly runId: RunId;
  readonly attemptId: RunAttemptId;
}) {
  const { runtime, thread, runId, attemptId } = input;
  const fail = (detail: string) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: runtime.driver,
      detail,
    });
  if (runtime.driver !== "codex" || runtime.supportsIsolatedProposalThread !== true) {
    return yield* fail("This provider does not support isolated proposal credentials.");
  }
  const store = yield* ProjectionStoreV2;
  const registry = yield* McpSessionRegistry;
  let nativeThread: Effect.Success<ReturnType<typeof runtime.ensureThread>> | undefined;
  const isCurrentAttempt = store.getTurnStartContext(thread.threadId, runId).pipe(
    Effect.map((projection) => {
      const run = projection.runs.find((row) => row.id === runId);
      const attempt = projection.attempts.find((row) => row.id === attemptId);
      const providerThread = projection.providerThreads.find(
        (row) => row.id === attempt?.providerThreadId,
      );
      return (
        run?.activeAttemptId === attemptId &&
        (run.status === "starting" || run.status === "running") &&
        attempt?.runId === runId &&
        (attempt.status === "pending" || attempt.status === "running") &&
        attempt.providerInstanceId === runtime.instanceId &&
        providerThread?.providerSessionId === runtime.providerSessionId &&
        (nativeThread === undefined ||
          (providerThread.id === nativeThread.id &&
            providerThread.nativeThreadRef?.nativeId === nativeThread.nativeThreadRef?.nativeId))
      );
    }),
    Effect.orElseSucceed(() => false),
  );
  if (!(yield* isCurrentAttempt)) return yield* fail("Proposal execution is no longer active.");
  const credential = yield* registry.issue({
    threadId: thread.threadId,
    providerInstanceId: runtime.instanceId,
    proposalExecution: {
      scope: {
        runId,
        attemptId,
        providerSessionId: runtime.providerSessionId,
        capability: "propose-external-action",
      },
      isActive: isCurrentAttempt,
    },
  });
  nativeThread = yield* runtime
    .ensureThread({ ...thread, forceNewNativeThread: true, proposalMcpSession: credential.config })
    .pipe(
      Effect.onError(() => registry.revokeProviderSession(credential.config.providerSessionId)),
    );
  if (thread.existingProviderThread) {
    nativeThread = { ...nativeThread, id: thread.existingProviderThread.id };
  }
  if (!nativeThread.nativeThreadRef?.nativeId) {
    yield* registry.revokeProviderSession(credential.config.providerSessionId);
    return yield* fail("The isolated proposal thread has no native identity.");
  }
  return nativeThread;
});
