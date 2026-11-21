import { assert, describe, it } from "@effect/vitest";
import { ClaudeSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeClaudeQueryOptions } from "./ClaudeAdapterV2.ts";
import {
  readClaudeConsumerPolicy,
  validateConsumerClaudeTurn,
  type ClaudeConsumerPolicy,
} from "./ClaudeConsumerPolicy.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const policy: ClaudeConsumerPolicy = {
  workspaceRoot: "/consumer",
  models: ["claude-sonnet-4-6"],
  maxPromptChars: 6_000,
  maxOutputTokens: 2_000,
  maxQueryBudgetUsd: 0.5,
};
const validTurn = {
  model: "claude-sonnet-4-6",
  cwd: "/consumer",
  text: "Draft a lunch special",
  attachmentCount: 0,
  delegated: false,
  resume: false,
};

describe("consumer Claude policy", () => {
  it.effect("is opt-in and requires an API key rather than operator subscription auth", () =>
    Effect.gen(function* () {
      assert.isUndefined(
        yield* readClaudeConsumerPolicy({}, { CLAUDE_CODE_OAUTH_TOKEN: "operator-subscription" }),
      );
      const host = { T3_CONSUMER_CLAUDE_POLICY: JSON.stringify(policy) };
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            readClaudeConsumerPolicy(host, { CLAUDE_CODE_OAUTH_TOKEN: "operator-subscription" }),
          ),
        ),
      );
      assert.deepEqual(
        yield* readClaudeConsumerPolicy(host, { ANTHROPIC_API_KEY: "test-api-key" }),
        policy,
      );
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect("fails closed for invalid policy and non-normalized workspace roots", () =>
    Effect.gen(function* () {
      for (const value of [
        "bad-json",
        JSON.stringify({ ...policy, workspaceRoot: "relative" }),
        JSON.stringify({ ...policy, workspaceRoot: "/consumer/../private" }),
        JSON.stringify({ ...policy, models: [] }),
        JSON.stringify({ ...policy, maxQueryBudgetUsd: 100 }),
      ]) {
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              readClaudeConsumerPolicy(
                { T3_CONSUMER_CLAUDE_POLICY: value },
                { ANTHROPIC_API_KEY: "test" },
              ),
            ),
          ),
        );
      }
    }).pipe(Effect.provide(Path.layer)),
  );

  it.effect(
    "rejects foreign models/workspaces, native commands, attachments, delegation and steering resumes",
    () =>
      Effect.gen(function* () {
        yield* validateConsumerClaudeTurn(policy, validTurn);
        for (const override of [
          { model: "unpriced-model" },
          { cwd: "/private" },
          { text: " /compact" },
          { text: "x".repeat(6_001) },
          { attachmentCount: 1 },
          { delegated: true },
          { resume: true },
        ]) {
          assert.isTrue(
            Exit.isFailure(
              yield* Effect.exit(validateConsumerClaudeTurn(policy, { ...validTurn, ...override })),
            ),
          );
        }
      }),
  );

  it("overrides coding tools, local settings, CLI bypass flags and MCP credentials", async () => {
    const options = makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
        options: [],
      },
      nativeThreadId: "consumer-thread",
      resume: false,
      cwd: "/consumer",
      attachmentsDir: "/private",
      settings: decodeClaudeSettings({
        launchArgs:
          "--dangerously-skip-permissions --add-dir /private --append-system-prompt private-instructions",
      }),
      sdkSettings: { env: { CLAUDE_CODE_OAUTH_TOKEN: "operator-token" } },
      environment: {
        PATH: "/bin",
        HOME: "/consumer-home",
        ANTHROPIC_API_KEY: "api-key",
        CLAUDE_CODE_OAUTH_TOKEN: "operator-token",
        ANTHROPIC_BASE_URL: "https://untrusted.example",
        PRIVATE_SECRET: "operator-secret",
      },
      permissionMode: "bypassPermissions",
      allowedTools: ["Bash"],
      mcpServers: {
        operator: {
          type: "http",
          url: "https://operator.example/mcp",
          headers: { Authorization: "operator-secret" },
        },
      },
      deviceToolsAvailable: true,
      consumerPolicy: policy,
    });
    assert.deepEqual(options.tools, []);
    assert.deepEqual(options.mcpServers, {});
    assert.deepEqual(options.additionalDirectories, []);
    assert.deepEqual(options.settingSources, []);
    assert.deepEqual(options.settings, {
      autoCompactEnabled: false,
      precomputeCompactionEnabled: false,
      idleCompaction: false,
    });
    assert.deepEqual(options.hooks, {});
    assert.deepEqual(options.skills, []);
    assert.deepEqual(options.plugins, []);
    assert.deepEqual(options.extraArgs, {});
    assert.equal(options.permissionMode, "dontAsk");
    assert.equal(options.allowDangerouslySkipPermissions, false);
    assert.equal(options.maxTurns, 1);
    assert.equal(options.maxBudgetUsd, 0.5);
    assert.equal(options.env?.ANTHROPIC_API_KEY, "api-key");
    assert.equal(options.env?.CLAUDE_CODE_MAX_OUTPUT_TOKENS, "2000");
    assert.isUndefined(options.env?.CLAUDE_CODE_OAUTH_TOKEN);
    assert.isUndefined(options.env?.ANTHROPIC_BASE_URL);
    assert.isUndefined(options.env?.PRIVATE_SECRET);
    assert.notInclude(String(options.systemPrompt), "private-instructions");
    const denied = await options.canUseTool!(
      "Bash",
      { command: "cat /private" },
      { signal: new AbortController().signal, toolUseID: "blocked", requestId: "request-blocked" },
    );
    assert.equal(denied?.behavior, "deny");
  });

  it("keeps native internal chat options unchanged when policy is absent", () => {
    const options = makeClaudeQueryOptions({
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-6",
        options: [],
      },
      nativeThreadId: "native-thread",
      resume: false,
      cwd: "/internal",
      permissionMode: "bypassPermissions",
    });
    assert.deepEqual(options.tools, { type: "preset", preset: "claude_code" });
    assert.equal(options.permissionMode, "bypassPermissions");
    assert.isUndefined(options.maxTurns);
    assert.isUndefined(options.maxBudgetUsd);
  });
});
