import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestratorMcpRunUsageReceipt,
  TurnTokenUsage,
} from "@t3tools/contracts";
import type { ConsumerGrant } from "../persistence/ConsumerApiGrants.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeReportedModelSlug,
} from "../provider/ClaudeModelCatalog.ts";

export function threadUsageReceipt(
  run: Pick<OrchestrationV2Run, "id" | "status">,
  projection: {
    readonly attempts: ReadonlyArray<
      Pick<OrchestrationV2RunAttempt, "id" | "runId" | "providerInstanceId">
    >;
    readonly providerTurns: ReadonlyArray<
      Pick<OrchestrationV2ProviderTurn, "id" | "runAttemptId" | "model" | "turnTokenUsage">
    >;
  },
  consumer?: Pick<
    ConsumerGrant,
    | "runId"
    | "model"
    | "status"
    | "consumedAt"
    | "serviceTier"
    | "contextTruncated"
    | "imageRequestId"
  > & { readonly usage: TurnTokenUsage | null },
): OrchestratorMcpRunUsageReceipt {
  const attempts = new Map(
    projection.attempts
      .filter((attempt) => attempt.runId === run.id)
      .map((attempt) => [attempt.id, attempt]),
  );
  let turns = projection.providerTurns.flatMap((turn) => {
    const attempt = turn.runAttemptId === null ? undefined : attempts.get(turn.runAttemptId);
    return attempt === undefined
      ? []
      : [
          {
            providerTurnId: turn.id,
            attemptId: attempt.id,
            providerInstanceId: attempt.providerInstanceId,
            model: turn.model ?? null,
            usage: turn.turnTokenUsage ?? null,
          },
        ];
  });
  const singleUsage = (usage: TurnTokenUsage | null, model: string) =>
    usage?.usageStatus === "complete" &&
    usage.usageScope === "main_agent" &&
    usage.hasSubagents === false &&
    usage.localCommand !== true &&
    usage.cachedInputTokens === 0 &&
    usage.cacheCreationTokens === 0 &&
    (usage.reasoningTokens ?? 0) === 0 &&
    (usage.otherUsage === undefined ||
      (usage.otherUsage.inputTokens === 0 && usage.otherUsage.outputTokens === 0)) &&
    usage.models?.length === 1 &&
    usage.models[0] === model;
  const turn = turns[0];
  const consumerComplete =
    consumer === undefined ||
    (consumer.runId === run.id &&
      consumer.status === "completed" &&
      consumer.consumedAt !== null &&
      consumer.serviceTier === "standard" &&
      consumer.contextTruncated === 0 &&
      consumer.imageRequestId === null &&
      attempts.size === 1 &&
      turns.length === 1 &&
      turn !== undefined &&
      (turn.model === consumer.model ||
        turn.model ===
          resolveClaudeReportedModelSlug(BUNDLED_CLAUDE_MODEL_CATALOG, consumer.model)) &&
      singleUsage(consumer.usage, consumer.model) &&
      singleUsage(turn.usage, consumer.model) &&
      consumer.usage?.inputTokens === turn.usage?.inputTokens &&
      consumer.usage?.outputTokens === turn.usage?.outputTokens);
  if (consumer !== undefined && consumerComplete && turn !== undefined) {
    // Claude projects a display alias; billing keeps the exact model and counters proven by the gateway.
    turns = [{ ...turn, model: consumer.model, usage: consumer.usage }];
  }
  const final = ["completed", "failed", "cancelled"].includes(run.status);
  const coveredAttempts = new Set(turns.map((turn) => turn.attemptId));
  // Native subagents, compaction, and mixed models require their own priced usage receipts.
  const complete =
    final &&
    consumerComplete &&
    turns.length > 0 &&
    coveredAttempts.size === attempts.size &&
    turns.every(
      (turn) =>
        turn.model !== null &&
        turn.usage?.usageStatus === "complete" &&
        !turn.usage.hasSubagents &&
        turn.usage.localCommand !== true &&
        turn.usage.otherUsage === undefined &&
        (turn.usage.models === undefined ||
          (turn.usage.models.length === 1 && turn.usage.models[0] === turn.model)),
    );
  return {
    final,
    coverage: complete
      ? "complete"
      : turns.some((turn) => turn.usage !== null)
        ? "partial"
        : "unavailable",
    turns,
  };
}
