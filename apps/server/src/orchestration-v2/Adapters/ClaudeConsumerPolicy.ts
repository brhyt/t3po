import {
  CONSUMER_MODEL_INPUT_TOKENS,
  CONSUMER_OUTPUT_TOKENS,
} from "../../provider/ConsumerAnthropicGateway.ts";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

export const ClaudeConsumerPolicy = Schema.Struct({
  workspaceRoot: Schema.NonEmptyString,
  models: Schema.NonEmptyArray(Schema.NonEmptyString),
  maxPromptChars: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20_000 })),
  maxOutputTokens: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: CONSUMER_OUTPUT_TOKENS }),
  ),
  // SDK stops after this budget is exceeded. It is not a preflight spending guarantee.
  maxQueryBudgetUsd: Schema.Number.check(Schema.isBetween({ minimum: 0.01, maximum: 5 })),
});
export type ClaudeConsumerPolicy = typeof ClaudeConsumerPolicy.Type;

export class ClaudeConsumerPolicyError extends Schema.TaggedError<ClaudeConsumerPolicyError>()(
  "ClaudeConsumerPolicyError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

const decodeConsumerPolicy = Schema.decodeEffect(Schema.fromJsonString(ClaudeConsumerPolicy));

/** Host-owned opt-in only. A provider account or browser cannot enable or weaken this policy. */
export const readClaudeConsumerPolicy = Effect.fn("ClaudeConsumerPolicy.read")(function* (
  hostEnvironment: NodeJS.ProcessEnv,
  providerEnvironment: NodeJS.ProcessEnv,
) {
  const raw = hostEnvironment.T3_CONSUMER_CLAUDE_POLICY;
  if (raw === undefined) return undefined;
  const policy = yield* decodeConsumerPolicy(raw).pipe(
    Effect.mapError(
      () => new ClaudeConsumerPolicyError({ detail: "Invalid consumer Claude policy." }),
    ),
  );
  const path = yield* Path.Path;
  if (
    !path.isAbsolute(policy.workspaceRoot) ||
    path.normalize(policy.workspaceRoot) !== policy.workspaceRoot
  ) {
    return yield* new ClaudeConsumerPolicyError({
      detail: "Consumer Claude requires a normalized absolute workspace root.",
    });
  }
  if (policy.models.some((model) => CONSUMER_MODEL_INPUT_TOKENS[model] === undefined)) {
    return yield* new ClaudeConsumerPolicyError({
      detail: "Consumer model lacks a documented input limit.",
    });
  }
  if (!providerEnvironment.ANTHROPIC_API_KEY?.trim()) {
    return yield* new ClaudeConsumerPolicyError({
      detail: "Consumer Claude requires an Anthropic API key.",
    });
  }
  return policy;
});

export function consumerClaudeQueryOverrides(
  policy: ClaudeConsumerPolicy,
  environment: NodeJS.ProcessEnv,
) {
  // Do not inherit OAuth credentials, provider proxies, coding hooks, MCP configuration or CLI flags.
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SYSTEMROOT",
    "ANTHROPIC_API_KEY",
  ] as const) {
    if (environment[name] !== undefined) env[name] = environment[name];
  }
  env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = String(policy.maxOutputTokens);
  env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  env.DISABLE_TELEMETRY = "1";
  env.DISABLE_ERROR_REPORTING = "1";
  return {
    cwd: policy.workspaceRoot,
    additionalDirectories: [],
    env,
    tools: [],
    allowedTools: [],
    disallowedTools: ["*"],
    permissionMode: "dontAsk",
    allowDangerouslySkipPermissions: false,
    canUseTool: async () => ({
      behavior: "deny",
      message: "Tools are unavailable in consumer text chat.",
    }),
    mcpServers: {},
    strictMcpConfig: true,
    settingSources: [],
    settings: {
      autoCompactEnabled: false,
      precomputeCompactionEnabled: false,
      idleCompaction: false,
    },
    plugins: [],
    skills: [],
    agents: {},
    hooks: {},
    extraArgs: {},
    systemPrompt:
      "You are Brega's workspace assistant. Help with writing, planning and reviewing content. You have no tools in this session. Do not claim to generate images, access files, save assets or publish changes. Explain unavailable capabilities plainly.",
    promptSuggestions: false,
    thinking: { type: "disabled" },
    maxTurns: 1,
    maxBudgetUsd: policy.maxQueryBudgetUsd,
  } satisfies Partial<Options>;
}

export const validateConsumerClaudeTurn = Effect.fn("ClaudeConsumerPolicy.validateTurn")(function* (
  policy: ClaudeConsumerPolicy,
  input: {
    readonly model: string;
    readonly cwd: string | null;
    readonly text: string;
    readonly attachmentCount: number;
    readonly delegated: boolean;
    readonly resume: boolean;
  },
) {
  if (!policy.models.includes(input.model) || input.cwd !== policy.workspaceRoot) {
    return yield* new ClaudeConsumerPolicyError({
      detail: "This model or workspace is unavailable in consumer chat.",
    });
  }
  if (
    input.delegated ||
    input.resume ||
    input.attachmentCount > 0 ||
    input.text.trimStart().startsWith("/") ||
    new TextEncoder().encode(input.text).byteLength > 6000 ||
    input.text.length > policy.maxPromptChars
  ) {
    return yield* new ClaudeConsumerPolicyError({
      detail: "Consumer text chat accepts bounded text messages only.",
    });
  }
});
