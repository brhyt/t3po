import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
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
const consumerModel = "claude-haiku-4-5-20251001";
const consumerUsage = {
  usageScope: "main_agent",
  usageStatus: "complete",
  inputTokens: 1376,
  outputTokens: 1053,
  cachedInputTokens: 0,
  cacheCreationTokens: 0,
  hasSubagents: false,
  models: [consumerModel],
} as const;
const consumerProof = {
  runId,
  model: consumerModel,
  status: "completed",
  consumedAt: 1795384890545,
  serviceTier: "standard",
  contextTruncated: 0,
  imageRequestId: null,
  usage: consumerUsage,
} as const;
const invalidConsumerCases: ReadonlyArray<{
  name: string;
  proof?: Partial<NonNullable<Parameters<typeof threadUsageReceipt>[2]>>;
  usage?: TurnTokenUsage;
  turnModel?: string;
  retry?: boolean;
  extraTurn?: boolean;
}> = [
  { name: "unknown display model", turnModel: "unknown-haiku" },
  { name: "another run", proof: { runId: RunId.make("foreign") } },
  { name: "unconsumed grant", proof: { consumedAt: null } },
  { name: "indeterminate grant", proof: { status: "indeterminate" } },
  { name: "missing provider receipt", proof: { usage: null } },
  {
    name: "partial provider receipt",
    proof: { usage: { ...consumerUsage, usageStatus: "partial" } },
  },
  {
    name: "mismatched provider counters",
    proof: { usage: { ...consumerUsage, inputTokens: 1377 } },
  },
  {
    name: "mixed provider models",
    proof: { usage: { ...consumerUsage, models: [consumerModel, "other"] } },
  },
  { name: "nonstandard tier", proof: { serviceTier: "priority" } },
  { name: "truncated context", proof: { contextTruncated: 1 } },
  { name: "partial projected usage", usage: { ...consumerUsage, usageStatus: "partial" } },
  { name: "unknown projected model", usage: { ...consumerUsage, models: undefined } },
  { name: "mixed projected models", usage: { ...consumerUsage, models: [consumerModel, "other"] } },
  {
    name: "nonzero other usage",
    usage: { ...consumerUsage, otherUsage: { inputTokens: 1, outputTokens: 0 } },
  },
  { name: "cache usage", usage: { ...consumerUsage, cachedInputTokens: 1 } },
  { name: "subagent usage", usage: { ...consumerUsage, hasSubagents: true } },
  { name: "reasoning usage", usage: { ...consumerUsage, reasoningTokens: 1 } },
  { name: "local command", usage: { ...consumerUsage, localCommand: true } },
  { name: "uncovered retry", retry: true },
  { name: "multiple provider turns", extraTurn: true },
];

describe("thread usage receipt", () => {
  it("uses the exact single-use gateway receipt when Claude projects a display alias", () => {
    const receipt = threadUsageReceipt(
      { id: runId, status: "completed" },
      {
        attempts: [attempt()],
        providerTurns: [
          {
            ...turn("native-consumer"),
            model: "claude-haiku-4-5",
            turnTokenUsage: {
              ...consumerUsage,
              reasoningTokens: 0,
              otherUsage: { inputTokens: 0, outputTokens: 0 },
            },
          },
        ],
      },
      consumerProof,
    );
    assert.equal(receipt.coverage, "complete");
    assert.equal(receipt.turns[0]?.model, consumerModel);
    assert.deepEqual(receipt.turns[0]?.usage, consumerUsage);
  });
  it.each(invalidConsumerCases)(
    "does not upgrade $name into complete consumer coverage",
    ({ proof, usage, turnModel, retry, extraTurn }) => {
      const providerTurn = {
        ...turn("consumer"),
        model: turnModel ?? "claude-haiku-4-5",
        turnTokenUsage: usage ?? consumerUsage,
      };
      const receipt = threadUsageReceipt(
        { id: runId, status: "completed" },
        {
          attempts: retry ? [attempt(), attempt(retryAttempt)] : [attempt()],
          providerTurns: extraTurn
            ? [providerTurn, { ...providerTurn, id: ProviderTurnId.make("extra") }]
            : [providerTurn],
        },
        { ...consumerProof, ...proof },
      );
      assert.notEqual(receipt.coverage, "complete");
    },
  );
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
