import { type TurnTokenUsage } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { HttpServerResponse } from "effect/http";
import * as ConsumerApiGrants from "../persistence/ConsumerApiGrants.ts";

export const CONSUMER_ANTHROPIC_PATH = "/api/consumer/anthropic/v1/messages";
export const CONSUMER_REQUEST_BYTES = 7_168;
// Reservations use the documented full model context window, never a byte-to-token estimate.
export const CONSUMER_MODEL_INPUT_TOKENS: Readonly<Record<string, number>> = {
  "claude-haiku-4-5-20251001": 200_000,
  "claude-sonnet-4-6": 1_000_000,
};
export const CONSUMER_OUTPUT_TOKENS = 2_048;
export const CONSUMER_REQUEST_DURATION_MS = 120_000;

const textBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const textContent = Schema.Union([Schema.String, Schema.Array(textBlock)]);
const requestSchema = Schema.Struct({
  model: Schema.String,
  max_tokens: Schema.Int,
  messages: Schema.NonEmptyArray(
    Schema.Struct({ role: Schema.Literals(["user", "assistant"]), content: textContent }),
  ),
  system: Schema.optional(textContent),
  tools: Schema.optional(Schema.Array(Schema.Unknown)),
});
const counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const usageSchema = Schema.Struct({
  service_tier: Schema.optional(Schema.String),
  input_tokens: Schema.optional(counter),
  output_tokens: Schema.optional(counter),
  cache_creation_input_tokens: Schema.optional(counter),
  cache_read_input_tokens: Schema.optional(counter),
});
const eventSchema = Schema.Struct({
  type: Schema.String,
  usage: Schema.optional(usageSchema),
  message: Schema.optional(Schema.Struct({ model: Schema.String, usage: usageSchema })),
});
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(requestSchema));
const decodeEvent = Schema.decodeEffect(Schema.fromJsonString(eventSchema));
const failure = (message: string) =>
  HttpServerResponse.jsonUnsafe(
    { type: "error", error: { type: "invalid_request_error", message } },
    { status: 400, headers: { "cache-control": "no-store" } },
  );

/** Whitelisting removes caching, tool definitions, model overrides, beta options and provider routing. */
export const boundedConsumerRequest = Effect.fn("ConsumerAnthropicGateway.boundRequest")(function* (
  raw: string,
  grant: Pick<ConsumerApiGrants.ConsumerGrant, "model" | "maxRequestBytes" | "maxOutputTokens">,
) {
  const parsed = yield* decodeRequest(raw).pipe(
    Effect.mapError(
      () =>
        new ConsumerApiGrants.ConsumerGrantError({ detail: "Consumer chat accepts text only." }),
    ),
  );
  if (
    parsed.model !== grant.model ||
    parsed.max_tokens < 1 ||
    parsed.max_tokens > grant.maxOutputTokens ||
    (parsed.tools?.length ?? 0) > 0 ||
    parsed.messages.length > 256
  ) {
    return yield* new ConsumerApiGrants.ConsumerGrantError({
      detail: "Consumer request exceeds its authorized model or limits.",
    });
  }
  const messages = [...parsed.messages];
  const body = () => ({
    model: grant.model,
    max_tokens: parsed.max_tokens,
    stream: true,
    service_tier: "standard_only",
    thinking: { type: "disabled" },
    ...(parsed.system === undefined ? {} : { system: parsed.system }),
    messages,
  });
  let serialized = yield* encodeRequest(body());
  let truncated = false;
  // Drop only complete earlier exchanges; never truncate the current user's words.
  while (
    new TextEncoder().encode(serialized).byteLength > grant.maxRequestBytes &&
    messages.length > 2
  ) {
    messages.shift();
    while (messages.length > 1 && messages[0]?.role !== "user") messages.shift();
    truncated = true;
    serialized = yield* encodeRequest(body());
  }
  if (
    new TextEncoder().encode(serialized).byteLength > grant.maxRequestBytes ||
    messages.at(-1)?.role !== "user"
  ) {
    return yield* new ConsumerApiGrants.ConsumerGrantError({
      detail: "The message is too long for consumer chat. Shorten it and try again.",
    });
  }
  return { body: serialized, truncated };
});

export class ConsumerAnthropicGateway extends Context.Service<
  ConsumerAnthropicGateway,
  {
    readonly configured: boolean;
    readonly issue: ConsumerApiGrants.ConsumerApiGrants["Service"]["issue"];
    readonly read: ConsumerApiGrants.ConsumerApiGrants["Service"]["read"];
    readonly rejectUnconsumed: ConsumerApiGrants.ConsumerApiGrants["Service"]["rejectUnconsumed"];
    readonly forward: (
      token: string,
      body: string,
    ) => Effect.Effect<HttpServerResponse.HttpServerResponse, ConsumerApiGrants.ConsumerGrantError>;
  }
>()("t3/provider/ConsumerAnthropicGateway") {}

const make = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const grants = yield* ConsumerApiGrants.ConsumerApiGrants;
  const http = yield* HttpClient.HttpClient;
  const apiKey = environment.ANTHROPIC_API_KEY;
  const configured = Boolean(environment.T3_CONSUMER_CLAUDE_POLICY && apiKey?.trim());
  if (configured) {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA synchronous = FULL;`;
  }
  return ConsumerAnthropicGateway.of({
    configured,
    issue: grants.issue,
    read: grants.read,
    rejectUnconsumed: grants.rejectUnconsumed,
    forward: Effect.fn("ConsumerAnthropicGateway.forward")(function* (token, raw) {
      if (!configured || !apiKey || token.length > 100)
        return failure("Consumer chat is unavailable.");
      const pending = yield* grants.readToken(token);
      if (
        !pending ||
        pending.status !== "ready" ||
        pending.expiresAt <= (yield* Clock.currentTimeMillis)
      )
        return failure("This consumer request has already been attempted or expired.");
      const bounded = yield* boundedConsumerRequest(raw, pending).pipe(Effect.result);
      if (bounded._tag === "Failure") return failure(bounded.failure.message);
      // This durable claim must commit before any provider request. A timeout, restart or retry cannot issue a second request.
      const grant = yield* grants.claim(token, bounded.success.truncated);
      if (!grant) return failure("This consumer request has already been attempted.");
      const start = yield* Clock.currentTimeMillis;
      const request = HttpClientRequest.post("https://api.anthropic.com/v1/messages").pipe(
        HttpClientRequest.setHeaders({
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        }),
        HttpClientRequest.bodyText(bounded.success.body, "application/json"),
      );
      const attempted = yield* http
        .execute(request)
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.timeout(CONSUMER_REQUEST_DURATION_MS),
          Effect.result,
        );
      if (attempted._tag === "Failure") {
        yield* grants.finish(grant.runId, "indeterminate");
        return failure(
          "The provider result is unknown. This request will not be retried automatically.",
        );
      }
      const upstream = attempted.success;
      if (upstream.status !== 200) {
        // 4xx/5xx responses do not prove that no provider work occurred; retain the reservation for reconciliation.
        yield* grants.finish(grant.runId, "indeterminate");
        return failure(
          "The provider did not complete this request. Its status must be reconciled.",
        );
      }
      const decoder = new TextDecoder();
      let buffered = "";
      let received = 0;
      const usage: typeof usageSchema.Type = {};
      let actualModel: string | null = null;
      let finished = false;
      const observe = Effect.fnUntraced(function* (chunk: Uint8Array) {
        received += chunk.byteLength;
        if (received > 2_000_000)
          return yield* new ConsumerApiGrants.ConsumerGrantError({
            detail: "Consumer response exceeded its limit.",
          });
        buffered += decoder.decode(chunk, { stream: true });
        const frames = buffered.split(/\r?\n\r?\n/);
        buffered = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (!data) continue;
          const event = yield* decodeEvent(data).pipe(
            Effect.mapError(
              () =>
                new ConsumerApiGrants.ConsumerGrantError({ detail: "Invalid provider response." }),
            ),
          );
          if (event.type === "message_start" && event.message) {
            actualModel = event.message.model;
            Object.assign(usage, event.message.usage);
          }
          if (event.usage) Object.assign(usage, event.usage);
          if (event.type === "error")
            return yield* new ConsumerApiGrants.ConsumerGrantError({
              detail: "Provider response interrupted.",
            });
          if (event.type === "message_stop") {
            const complete =
              actualModel === grant.model &&
              usage.input_tokens !== undefined &&
              usage.output_tokens !== undefined &&
              usage.input_tokens <= (CONSUMER_MODEL_INPUT_TOKENS[grant.model] ?? 0) &&
              usage.service_tier === "standard" &&
              usage.output_tokens <= grant.maxOutputTokens &&
              usage.cache_creation_input_tokens === 0 &&
              usage.cache_read_input_tokens === 0;
            const receipt: TurnTokenUsage = complete
              ? {
                  usageScope: "main_agent",
                  usageStatus: "complete",
                  inputTokens: usage.input_tokens!,
                  outputTokens: usage.output_tokens!,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  hasSubagents: false,
                  models: [grant.model],
                }
              : { usageScope: "main_agent", usageStatus: "partial", hasSubagents: false };
            yield* grants.finish(
              grant.runId,
              complete ? "completed" : "indeterminate",
              receipt,
              usage.service_tier ?? null,
            );
            finished = true;
          }
        }
      });
      const remaining = Math.max(
        1,
        CONSUMER_REQUEST_DURATION_MS - ((yield* Clock.currentTimeMillis) - start),
      );
      return HttpServerResponse.stream(
        upstream.stream.pipe(
          Stream.tap(observe),
          Stream.interruptWhen(Effect.sleep(remaining)),
          Stream.ensuring(
            Effect.suspend(() =>
              finished ? Effect.void : grants.finish(grant.runId, "indeterminate"),
            ).pipe(Effect.ignore),
          ),
        ),
        {
          contentType: "text/event-stream",
          headers: { "cache-control": "no-store, no-transform", "x-accel-buffering": "no" },
        },
      );
    }),
  });
});
export const layer = Layer.effect(ConsumerAnthropicGateway, make).pipe(
  Layer.provide(ConsumerApiGrants.layer),
);
