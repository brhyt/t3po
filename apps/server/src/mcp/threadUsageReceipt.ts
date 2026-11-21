import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestratorMcpRunUsageReceipt,
} from "@t3tools/contracts";

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
): OrchestratorMcpRunUsageReceipt {
  const attempts = new Map(
    projection.attempts
      .filter((attempt) => attempt.runId === run.id)
      .map((attempt) => [attempt.id, attempt]),
  );
  const turns = projection.providerTurns.flatMap((turn) => {
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
  const final = ["completed", "failed", "cancelled"].includes(run.status);
  const coveredAttempts = new Set(turns.map((turn) => turn.attemptId));
  // Native subagents, compaction, and mixed models require their own priced usage receipts.
  const complete =
    final &&
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
