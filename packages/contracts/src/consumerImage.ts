import * as Schema from "effect/Schema";
import { MessageId, ProjectId, RunId, ThreadId } from "./baseSchemas.ts";

const identifier = Schema.NonEmptyString.check(Schema.isMaxLength(256));
const counter = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
export const ConsumerImageGrant = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  policy: Schema.Literal("brega-text-image-v1"),
  reservationId: identifier,
  imageRequestId: identifier,
  profile: Schema.Literal("openai-image-square-v1"),
});
export type ConsumerImageGrant = typeof ConsumerImageGrant.Type;
export const ConsumerImageUsage = Schema.Struct({
  input_tokens: counter,
  output_tokens: counter,
  total_tokens: counter,
  input_tokens_details: Schema.Struct({ text_tokens: counter, image_tokens: counter }),
  output_tokens_details: Schema.optional(
    Schema.Struct({ text_tokens: counter, image_tokens: counter }),
  ),
});
export type ConsumerImageUsage = typeof ConsumerImageUsage.Type;
export const ConsumerImageSource = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  status: Schema.Literal("completed"),
  runtimeId: identifier,
  t3ProjectId: ProjectId,
  threadId: ThreadId,
  runId: RunId,
  artifactId: identifier,
  imageRequestId: identifier,
  provider: Schema.Literal("openai"),
  model: Schema.Literal("gpt-image-2.5-flare-2026-09-08"),
  prompt: Schema.String.check(Schema.isMaxLength(6000)),
  mimeType: Schema.Literal("image/png"),
  byteLength: counter,
  sha256: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
  width: Schema.Literal(1024),
  height: Schema.Literal(1024),
});
export type ConsumerImageSource = typeof ConsumerImageSource.Type;
export const ConsumerImageExecution = Schema.Struct({
  ...ConsumerImageGrant.fields,
  status: Schema.Literals(["unused", "forwarding", "completed", "rejected", "indeterminate"]),
  upstreamRequests: Schema.Literals([0, 1]),
  model: Schema.Literal("gpt-image-2.5-flare-2026-09-08"),
  providerRequestId: Schema.NullOr(Schema.String),
  usage: Schema.NullOr(ConsumerImageUsage),
  artifact: Schema.optional(ConsumerImageSource),
});
export type ConsumerImageExecution = typeof ConsumerImageExecution.Type;
export const ConsumerImageCapabilities = Schema.Struct({
  protocolVersion: Schema.Literal(1),
  policy: Schema.Literal("brega-text-image-v1"),
  profile: Schema.Literal("openai-image-square-v1"),
  model: Schema.Literal("gpt-image-2.5-flare-2026-09-08"),
  tools: Schema.Literal("brega.generate_image"),
  maxImages: Schema.Literal(1),
  maxTextRequests: Schema.Literal(1),
  maxImageRequests: Schema.Literal(1),
  maxPromptBytes: Schema.Literal(6000),
  costBoundVerified: Schema.Literal(false),
  retention: Schema.Literal("durable-until-explicit-removal"),
});
export const ConsumerArtifactReadInput = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  runId: RunId,
  artifactId: identifier,
  offset: counter,
  limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 262144 }))),
});
export const ConsumerArtifactReadResult = Schema.Struct({
  source: ConsumerImageSource,
  data: Schema.String,
  offset: counter,
  nextOffset: counter,
  eof: Schema.Boolean,
});
export const ConsumerImageAuthorization = Schema.Struct({
  grant: ConsumerImageGrant,
  requestNamespace: identifier,
  messageId: MessageId,
  threadId: ThreadId,
  projectId: ProjectId,
  model: Schema.String,
  message: Schema.String,
});
export type ConsumerImageAuthorization = typeof ConsumerImageAuthorization.Type;
