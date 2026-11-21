import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderTurnId, RunAttemptId, RunId } from "@t3tools/contracts";
import { threadUsageReceipt } from "./threadUsageReceipt.ts";

const runId = RunId.make("run-usage");
const firstAttempt = RunAttemptId.make("attempt-first");
const retryAttempt = RunAttemptId.make("attempt-retry");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");
const completeUsage = {
  usageStatus: "complete",
  usageScope: "main_agent",
  inputTokens: 23,
  outputTokens: 11,
  hasSubagents: false,
  models: ["claude-sonnet"],
} as const;
const attempt = (id = firstAttempt) => ({ id, runId, providerInstanceId });
const turn = (id: string, runAttemptId = firstAttempt) => ({
  id: ProviderTurnId.make(id),
  runAttemptId,
  model: "claude-sonnet",
  turnTokenUsage: completeUsage,
});

describe("thread usage receipt", () => {
  it("includes retry costs by provider turn without counting another run", () => {
    const receipt = threadUsageReceipt(
      { id: runId, status: "completed" },
      {
        attempts: [
          attempt(),
          attempt(retryAttempt),
          { ...attempt(RunAttemptId.make("other")), runId: RunId.make("other") },
        ],
        providerTurns: [
          turn("first"),
          turn("retry", retryAttempt),
          turn("foreign", RunAttemptId.make("other")),
        ],
      },
    );
    assert.equal(receipt.coverage, "complete");
    assert.equal(receipt.final, true);
    assert.deepEqual(
      receipt.turns.map((row) => row.providerTurnId),
      ["first", "retry"],
    );
    assert.equal(receipt.turns[0]?.usage?.inputTokens, 23);
  });
  it.each([
    { usage: { ...completeUsage, usageStatus: "partial" as const }, model: "claude-sonnet" },
    { usage: { ...completeUsage, hasSubagents: true }, model: "claude-sonnet" },
    {
      usage: { ...completeUsage, models: ["claude-sonnet", "claude-haiku"] },
      model: "claude-sonnet",
    },
    {
      usage: { ...completeUsage, otherUsage: { inputTokens: 10, outputTokens: 2 } },
      model: "claude-sonnet",
    },
    { usage: { ...completeUsage, localCommand: true }, model: "claude-sonnet" },
    { usage: completeUsage, model: undefined },
    { usage: undefined, model: "claude-sonnet" },
  ])(
    "does not claim complete billing coverage for partial/unknown/child usage: %j",
    ({ usage, model }) => {
      const receipt = threadUsageReceipt(
        { id: runId, status: "completed" },
        {
          attempts: [attempt()],
          providerTurns: [{ ...turn("partial"), model, turnTokenUsage: usage }],
        },
      );
      assert.notEqual(receipt.coverage, "complete");
    },
  );
  it("marks a missing retry receipt and a still-running run as partial", () => {
    const records = {
      attempts: [attempt(), attempt(retryAttempt)],
      providerTurns: [turn("first")],
    };
    assert.equal(
      threadUsageReceipt({ id: runId, status: "completed" }, records).coverage,
      "partial",
    );
    assert.equal(threadUsageReceipt({ id: runId, status: "running" }, records).final, false);
    assert.equal(
      threadUsageReceipt({ id: runId, status: "cancelled" }, { attempts: [], providerTurns: [] })
        .coverage,
      "unavailable",
    );
  });
});
