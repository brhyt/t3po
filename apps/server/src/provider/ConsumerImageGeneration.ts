import {
  ConsumerImageSource,
  ConsumerImageUsage,
  type ConsumerImageAuthorization,
  type ConsumerImageGrant,
  type RunId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ConsumerImages from "../persistence/ConsumerImages.ts";

export const CONSUMER_IMAGE_MODEL = "gpt-image-2.5-flare-2026-09-08";
export const CONSUMER_IMAGE_TOOL = "mcp__brega__generate_image";
const CONSUMER_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const consumerImageToolDefinition = {
  name: CONSUMER_IMAGE_TOOL,
  description:
    "Generate one new image when the user requests an image. The image is retained for saving to Brega. No editing, input images, URLs or file paths are supported.",
  input_schema: {
    type: "object",
    properties: { prompt: { type: "string", minLength: 1, maxLength: 6000 } },
    required: ["prompt"],
    additionalProperties: false,
  },
} as const;
export const consumerImageCapabilities = {
  protocolVersion: 1,
  policy: "brega-text-image-v1",
  profile: "openai-image-square-v1",
  model: CONSUMER_IMAGE_MODEL,
  tools: "brega.generate_image",
  maxImages: 1,
  maxTextRequests: 1,
  maxImageRequests: 1,
  maxPromptBytes: 6000,
  costBoundVerified: false,
  retention: "durable-until-explicit-removal",
} as const;
const policySchema = Schema.Struct({ profile: Schema.Literal("openai-image-square-v1") });
const decodePolicy = Schema.decodeUnknownOption(Schema.fromJsonString(policySchema));
const responseSchema = Schema.Struct({
  data: Schema.Array(Schema.Struct({ b64_json: Schema.String })),
  usage: Schema.optional(Schema.Unknown),
});
const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(responseSchema));
const decodeUsage = Schema.decodeUnknownEffect(ConsumerImageUsage, { onExcessProperty: "error" });
const encodeRequest = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class ConsumerImageGeneration extends Context.Service<
  ConsumerImageGeneration,
  {
    readonly configured: boolean;
    readonly generate: (
      runId: RunId,
      prompt: string,
    ) => Effect.Effect<ConsumerImageSource, ConsumerImages.ConsumerImageError>;
  }
>()("t3/provider/ConsumerImageGeneration") {}

const make = Effect.gen(function* () {
  const environment = yield* HostProcess.Environment;
  const images = yield* ConsumerImages.ConsumerImages;
  const http = yield* HttpClient.HttpClient;
  const digest = yield* Digest.Digest;
  const random = yield* SecureRandom.SecureRandom;
  const serverEnvironment = yield* ServerEnvironment.ServerEnvironment;
  const apiKey = environment.OPENAI_API_KEY;
  const configured =
    Boolean(environment.T3_CONSUMER_CLAUDE_POLICY && apiKey?.trim()) &&
    decodePolicy(environment.T3_CONSUMER_IMAGE_POLICY)._tag === "Some";
  return ConsumerImageGeneration.of({
    configured,
    generate: Effect.fn("ConsumerImageGeneration.generate")(function* (runId, prompt) {
      if (
        !configured ||
        !apiKey ||
        !prompt.trim() ||
        new TextEncoder().encode(prompt).byteLength > 6000
      )
        return yield* new ConsumerImages.ConsumerImageError({ reason: "authorization" });
      const authorization = yield* images.claim(runId, prompt);
      const result = yield* Effect.gen(function* () {
        const body = yield* encodeRequest({
          model: CONSUMER_IMAGE_MODEL,
          prompt,
          n: 1,
          size: "1024x1024",
          quality: "medium",
          output_format: "png",
          background: "opaque",
          moderation: "auto",
          stream: false,
          partial_images: 0,
        });
        const response = yield* http
          .execute(
            HttpClientRequest.post("https://api.openai.com/v1/images/generations").pipe(
              HttpClientRequest.bearerToken(apiKey),
              HttpClientRequest.bodyText(body, "application/json"),
            ),
          )
          .pipe(Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }));
        if (response.status !== 200)
          return yield* new ConsumerImages.ConsumerImageError({ reason: "provider" });
        let received = 0;
        const chunks = yield* Stream.runCollect(
          response.stream.pipe(
            Stream.tap((chunk) => {
              received += chunk.byteLength;
              return received > 28 * 1024 * 1024
                ? Effect.fail(new ConsumerImages.ConsumerImageError({ reason: "artifact" }))
                : Effect.void;
            }),
          ),
        );
        const parsed = yield* decodeResponse(Buffer.concat(chunks).toString("utf8"));
        const encoded = parsed.data[0]?.b64_json;
        if (
          parsed.data.length !== 1 ||
          !encoded ||
          !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) ||
          encoded.length % 4 !== 0
        )
          return yield* new ConsumerImages.ConsumerImageError({ reason: "artifact" });
        const bytes = Buffer.from(encoded, "base64");
        if (
          bytes.byteLength > CONSUMER_IMAGE_MAX_BYTES ||
          bytes.byteLength < 33 ||
          bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
          bytes.subarray(12, 16).toString("ascii") !== "IHDR" ||
          bytes.readUInt32BE(16) !== 1024 ||
          bytes.readUInt32BE(20) !== 1024
        )
          return yield* new ConsumerImages.ConsumerImageError({ reason: "artifact" });
        const decodedUsage = yield* decodeUsage(parsed.usage).pipe(Effect.result);
        const usage = decodedUsage._tag === "Success" ? decodedUsage.success : undefined;
        const requestId = response.headers["x-request-id"];
        const providerRequestId =
          requestId && /^[A-Za-z0-9_-]{1,200}$/.test(requestId) ? requestId : undefined;
        const complete =
          usage !== undefined &&
          providerRequestId !== undefined &&
          usage.input_tokens_details.image_tokens === 0 &&
          usage.input_tokens_details.text_tokens === usage.input_tokens &&
          usage.total_tokens === usage.input_tokens + usage.output_tokens &&
          usage.output_tokens > 0 &&
          usage.output_tokens_details !== undefined &&
          usage.output_tokens_details.image_tokens + usage.output_tokens_details.text_tokens ===
            usage.output_tokens;
        const sha256 = Buffer.from(yield* digest.digest(Digest.sha256, bytes)).toString("hex");
        const source = {
          protocolVersion: 1,
          status: "completed",
          runtimeId: yield* serverEnvironment.getEnvironmentId,
          t3ProjectId: authorization.projectId,
          threadId: authorization.threadId,
          runId,
          artifactId: yield* random.uuidV4(),
          imageRequestId: authorization.grant.imageRequestId,
          provider: "openai",
          model: CONSUMER_IMAGE_MODEL,
          prompt,
          mimeType: "image/png",
          byteLength: bytes.byteLength,
          sha256,
          width: 1024,
          height: 1024,
        } satisfies ConsumerImageSource;
        yield* images.finish(runId, {
          status: complete ? "completed" : "indeterminate",
          source,
          bytes,
          ...(usage ? { usage } : {}),
          ...(providerRequestId ? { providerRequestId } : {}),
        });
        return source;
      }).pipe(Effect.timeout(240000), Effect.result);
      if (result._tag === "Success") return result.success;
      yield* images.finish(runId, { status: "indeterminate" });
      return yield* new ConsumerImages.ConsumerImageError({ reason: "provider" });
    }),
  });
});
export const layer = Layer.effect(ConsumerImageGeneration, make);

export const prepareConsumerImageGrant = Effect.fn("ConsumerImageGeneration.prepareGrant")(
  function* (
    input: Omit<ConsumerImageAuthorization, "grant"> & {
      readonly grant?: ConsumerImageGrant | undefined;
    },
  ) {
    const images = yield* Effect.serviceOption(ConsumerImages.ConsumerImages);
    if (!input.grant) {
      if (Option.isSome(images)) yield* images.value.requireNoGrant(input.messageId);
      return;
    }
    const generator = yield* Effect.serviceOption(ConsumerImageGeneration);
    if (Option.isNone(images) || Option.isNone(generator) || !generator.value.configured)
      return yield* new ConsumerImages.ConsumerImageError({ reason: "unavailable" });
    yield* images.value.authorize({ ...input, grant: input.grant });
  },
);
