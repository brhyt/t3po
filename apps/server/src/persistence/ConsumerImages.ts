import {
  ConsumerImageAuthorization,
  ConsumerImageExecution,
  ConsumerImageSource,
  ConsumerImageUsage,
  MessageId,
  RunId,
  type ConsumerArtifactReadInput,
  type ConsumerArtifactReadResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ConsumerImageError extends Schema.TaggedError<ConsumerImageError>()(
  "ConsumerImageError",
  {
    reason: Schema.Literals([
      "unavailable",
      "authorization",
      "already-attempted",
      "provider",
      "artifact",
    ]),
  },
) {
  override get message(): string {
    return `Consumer image ${this.reason}. No automatic regeneration was attempted.`;
  }
}
const rowSchema = Schema.Struct({
  imageRequestId: Schema.String,
  namespace: Schema.String,
  authorizationJson: Schema.String,
  runId: Schema.NullOr(RunId),
  status: ConsumerImageExecution.fields.status,
  expiresAt: Schema.Number,
  consumedAt: Schema.NullOr(Schema.Number),
  providerRequestId: Schema.NullOr(Schema.String),
  usageJson: Schema.NullOr(Schema.String),
  sourceJson: Schema.NullOr(Schema.String),
});
type ImageRow = typeof rowSchema.Type;
const decodeRows = Schema.decodeUnknownEffect(Schema.Array(rowSchema));
const decodeAuthorization = Schema.decodeEffect(Schema.fromJsonString(ConsumerImageAuthorization));
const encodeAuthorization = Schema.encodeEffect(Schema.fromJsonString(ConsumerImageAuthorization));
const decodeSource = Schema.decodeEffect(Schema.fromJsonString(ConsumerImageSource));
const encodeSource = Schema.encodeEffect(Schema.fromJsonString(ConsumerImageSource));
const decodeUsage = Schema.decodeEffect(Schema.fromJsonString(ConsumerImageUsage));
const encodeUsage = Schema.encodeEffect(Schema.fromJsonString(ConsumerImageUsage));
const protect = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, ConsumerImageError, R> =>
  effect.pipe(Effect.mapError(() => new ConsumerImageError({ reason: "unavailable" })));

export class ConsumerImages extends Context.Service<
  ConsumerImages,
  {
    readonly authorize: (
      input: ConsumerImageAuthorization,
    ) => Effect.Effect<void, ConsumerImageError>;
    readonly requireNoGrant: (messageId: MessageId) => Effect.Effect<void, ConsumerImageError>;
    readonly bind: (
      messageId: MessageId,
      runId: RunId,
      threadId: string,
      model: string,
    ) => Effect.Effect<ConsumerImageAuthorization | null, ConsumerImageError>;
    readonly claim: (
      runId: RunId,
      prompt: string,
    ) => Effect.Effect<ConsumerImageAuthorization, ConsumerImageError>;
    readonly finish: (
      runId: RunId,
      result: {
        status: "completed" | "indeterminate";
        providerRequestId?: string;
        usage?: ConsumerImageUsage;
        source?: ConsumerImageSource;
        bytes?: Uint8Array;
      },
    ) => Effect.Effect<void, ConsumerImageError>;
    readonly execution: (
      runId: RunId,
      terminal?: boolean,
      messageId?: MessageId,
    ) => Effect.Effect<ConsumerImageExecution | null, ConsumerImageError>;
    readonly readArtifact: (
      namespace: string,
      input: typeof ConsumerArtifactReadInput.Type,
    ) => Effect.Effect<typeof ConsumerArtifactReadResult.Type, ConsumerImageError>;
  }
>()("t3/persistence/ConsumerImages") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = sql.literal(
    `image_request_id AS "imageRequestId", namespace, authorization_json AS "authorizationJson", run_id AS "runId", status, expires_at AS "expiresAt", consumed_at AS "consumedAt", provider_request_id AS "providerRequestId", usage_json AS "usageJson", source_json AS "sourceJson"`,
  );
  const byMessage = Effect.fn("ConsumerImages.byMessage")(function* (messageId: MessageId) {
    return (
      (yield* protect(
        sql`SELECT ${columns} FROM consumer_images WHERE message_id=${messageId}`.pipe(
          Effect.flatMap(decodeRows),
        ),
      ))[0] ?? null
    );
  });
  const byRun = Effect.fn("ConsumerImages.byRun")(function* (runId: RunId) {
    return (
      (yield* protect(
        sql`SELECT ${columns} FROM consumer_images WHERE run_id=${runId}`.pipe(
          Effect.flatMap(decodeRows),
        ),
      ))[0] ?? null
    );
  });
  const executionFrom = Effect.fn("ConsumerImages.executionFrom")(function* (row: ImageRow) {
    const authorization = yield* protect(decodeAuthorization(row.authorizationJson));
    return {
      ...authorization.grant,
      status:
        row.status === "forwarding" &&
        (yield* Clock.currentTimeMillis) - (row.consumedAt ?? 0) > 240000
          ? "indeterminate"
          : row.status,
      upstreamRequests: row.consumedAt === null ? 0 : 1,
      model: "gpt-image-2.5-flare-2026-09-08",
      providerRequestId: row.providerRequestId,
      usage: row.usageJson === null ? null : yield* protect(decodeUsage(row.usageJson)),
      ...(row.sourceJson === null
        ? {}
        : { artifact: yield* protect(decodeSource(row.sourceJson)) }),
    } satisfies ConsumerImageExecution;
  });
  return ConsumerImages.of({
    authorize: Effect.fn("ConsumerImages.authorize")(function* (input) {
      if (
        !input.requestNamespace.startsWith("client:") ||
        input.grant.imageRequestId !== `${input.grant.reservationId}:image`
      )
        return yield* new ConsumerImageError({ reason: "authorization" });
      const json = yield* protect(encodeAuthorization(input));
      const expiresAt = (yield* Clock.currentTimeMillis) + 10 * 60000;
      yield* protect(sql`INSERT INTO consumer_images (image_request_id,reservation_id,namespace,message_id,project_id,thread_id,authorization_json,expires_at)
        VALUES (${input.grant.imageRequestId},${input.grant.reservationId},${input.requestNamespace},${input.messageId},${input.projectId},${input.threadId},${json},${expiresAt}) ON CONFLICT DO NOTHING`);
      const row = yield* byMessage(input.messageId);
      if (row?.authorizationJson !== json)
        return yield* new ConsumerImageError({ reason: "authorization" });
    }),
    requireNoGrant: Effect.fn("ConsumerImages.requireNoGrant")(function* (messageId) {
      if (yield* byMessage(messageId))
        return yield* new ConsumerImageError({ reason: "authorization" });
    }),
    bind: Effect.fn("ConsumerImages.bind")(function* (messageId, runId, threadId, model) {
      const row = yield* byMessage(messageId);
      if (!row) return null;
      const authorization = yield* protect(decodeAuthorization(row.authorizationJson));
      if (
        authorization.threadId !== threadId ||
        authorization.model !== model ||
        (row.runId !== null && row.runId !== runId)
      )
        return yield* new ConsumerImageError({ reason: "authorization" });
      const rows = yield* protect(
        sql`UPDATE consumer_images SET run_id=${runId} WHERE message_id=${messageId} AND (run_id IS NULL OR run_id=${runId}) AND status='unused' AND expires_at>${yield* Clock.currentTimeMillis} RETURNING ${columns}`.pipe(
          Effect.flatMap(decodeRows),
        ),
      );
      if (!rows[0]) return yield* new ConsumerImageError({ reason: "already-attempted" });
      return authorization;
    }),
    claim: Effect.fn("ConsumerImages.claim")(function* (runId, prompt) {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* protect(
        sql`UPDATE consumer_images SET status='forwarding',consumed_at=${now},prompt=${prompt} WHERE run_id=${runId} AND status='unused' AND expires_at>${now} RETURNING ${columns}`.pipe(
          Effect.flatMap(decodeRows),
        ),
      );
      if (!rows[0]) return yield* new ConsumerImageError({ reason: "already-attempted" });
      return yield* protect(decodeAuthorization(rows[0].authorizationJson));
    }),
    finish: Effect.fn("ConsumerImages.finish")(function* (runId, result) {
      const sourceJson = result.source ? yield* protect(encodeSource(result.source)) : null;
      const usageJson = result.usage ? yield* protect(encodeUsage(result.usage)) : null;
      yield* protect(
        sql`UPDATE consumer_images SET status=${result.status},provider_request_id=${result.providerRequestId ?? null},usage_json=${usageJson},source_json=${sourceJson},artifact_id=${result.source?.artifactId ?? null},image_bytes=${result.bytes ?? null} WHERE run_id=${runId} AND status='forwarding'`,
      );
    }),
    execution: Effect.fn("ConsumerImages.execution")(function* (runId, terminal, messageId) {
      if (terminal && messageId)
        yield* protect(
          sql`UPDATE consumer_images SET run_id=${runId},status='rejected' WHERE message_id=${messageId} AND run_id IS NULL AND status='unused'`,
        );
      if (terminal)
        yield* protect(
          sql`UPDATE consumer_images SET status='rejected' WHERE run_id=${runId} AND status='unused'`,
        );
      const row = yield* byRun(runId);
      return row ? yield* executionFrom(row) : null;
    }),
    readArtifact: Effect.fn("ConsumerImages.readArtifact")(function* (namespace, input) {
      const row = yield* byRun(input.runId);
      if (
        !row ||
        row.namespace !== namespace ||
        !["completed", "indeterminate"].includes(row.status) ||
        !row.sourceJson
      )
        return yield* new ConsumerImageError({ reason: "artifact" });
      const source = yield* protect(decodeSource(row.sourceJson));
      if (
        source.t3ProjectId !== input.projectId ||
        source.threadId !== input.threadId ||
        source.artifactId !== input.artifactId ||
        input.offset > source.byteLength
      )
        return yield* new ConsumerImageError({ reason: "artifact" });
      const limit = input.limit ?? 262144;
      if (
        !Number.isInteger(input.offset) ||
        input.offset < 0 ||
        !Number.isInteger(limit) ||
        limit < 1 ||
        limit > 262144
      )
        return yield* new ConsumerImageError({ reason: "artifact" });
      const chunks = yield* protect(
        sql<{
          data: Uint8Array;
        }>`SELECT substr(image_bytes,${input.offset + 1},${limit}) AS data FROM consumer_images WHERE run_id=${input.runId}`,
      );
      const bytes = chunks[0]?.data;
      if (
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength !== Math.min(limit, source.byteLength - input.offset)
      )
        return yield* new ConsumerImageError({ reason: "artifact" });
      const nextOffset = input.offset + bytes.byteLength;
      return {
        source,
        data: Buffer.from(bytes).toString("base64"),
        offset: input.offset,
        nextOffset,
        eof: nextOffset === source.byteLength,
      };
    }),
  });
});
export const layer = Layer.effect(ConsumerImages, make);
