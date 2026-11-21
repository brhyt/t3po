import { RunId, ThreadId, TurnTokenUsage } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

export class ConsumerGrantError extends Schema.TaggedError<
  ConsumerGrantError,
  { readonly brand: unique symbol }
>()("ConsumerGrantError", { detail: Schema.String }) {
  override get message(): string {
    return this.detail;
  }
}

export const ConsumerGrant = Schema.Struct({
  runId: RunId,
  threadId: ThreadId,
  model: Schema.String,
  token: Schema.String,
  maxRequestBytes: Schema.Int,
  maxOutputTokens: Schema.Int,
  expiresAt: Schema.Int,
  status: Schema.Literals(["ready", "forwarding", "completed", "rejected", "indeterminate"]),
  consumedAt: Schema.NullOr(Schema.Int),
  usageJson: Schema.NullOr(Schema.String),
  serviceTier: Schema.NullOr(Schema.String),
  contextTruncated: Schema.Int,
});
export type ConsumerGrant = typeof ConsumerGrant.Type;
export type ConsumerGrantInput = Pick<
  ConsumerGrant,
  "runId" | "threadId" | "model" | "maxRequestBytes" | "maxOutputTokens"
>;

export class ConsumerApiGrants extends Context.Service<
  ConsumerApiGrants,
  {
    readonly issue: (input: ConsumerGrantInput) => Effect.Effect<ConsumerGrant, ConsumerGrantError>;
    readonly read: (runId: RunId) => Effect.Effect<ConsumerGrant | null, ConsumerGrantError>;
    readonly readToken: (token: string) => Effect.Effect<ConsumerGrant | null, ConsumerGrantError>;
    readonly claim: (
      token: string,
      contextTruncated: boolean,
    ) => Effect.Effect<ConsumerGrant | null, ConsumerGrantError>;
    readonly rejectUnconsumed: (
      runId: RunId,
    ) => Effect.Effect<ConsumerGrant | null, ConsumerGrantError>;
    readonly finish: (
      runId: RunId,
      status: "completed" | "rejected" | "indeterminate",
      usage?: TurnTokenUsage,
      serviceTier?: string | null,
    ) => Effect.Effect<void, ConsumerGrantError>;
  }
>()("t3/persistence/ConsumerApiGrants") {}

const encodeUsage = Schema.encodeEffect(Schema.fromJsonString(TurnTokenUsage));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const random = yield* SecureRandom.SecureRandom;
  const columns = sql.literal(
    `run_id AS "runId", thread_id AS "threadId", model, token, max_request_bytes AS "maxRequestBytes", max_output_tokens AS "maxOutputTokens", expires_at AS "expiresAt", status, consumed_at AS "consumedAt", usage_json AS "usageJson", service_tier AS "serviceTier", context_truncated AS "contextTruncated"`,
  );
  const decode = Schema.decodeUnknownEffect(Schema.Array(ConsumerGrant));
  const protect = <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, ConsumerGrantError, R> =>
    effect.pipe(
      Effect.mapError(
        () => new ConsumerGrantError({ detail: "Consumer request state is unavailable." }),
      ),
    );
  const read = Effect.fn("ConsumerApiGrants.read")(function* (runId: RunId) {
    const rows = yield* protect(
      sql`SELECT ${columns} FROM consumer_api_grants WHERE run_id = ${runId}`.pipe(
        Effect.flatMap(decode),
      ),
    );
    return rows[0] ?? null;
  });
  return ConsumerApiGrants.of({
    read,
    issue: Effect.fn("ConsumerApiGrants.issue")(function* (input) {
      const token = `${yield* random.uuidV4()}${yield* random.uuidV4()}`;
      const expiresAt = (yield* Clock.currentTimeMillis) + 10 * 60_000;
      yield* protect(sql`INSERT INTO consumer_api_grants (run_id,thread_id,model,token,max_request_bytes,max_output_tokens,status,expires_at)
        VALUES (${input.runId},${input.threadId},${input.model},${token},${input.maxRequestBytes},${input.maxOutputTokens},'ready',${expiresAt}) ON CONFLICT(run_id) DO NOTHING`);
      const stored = yield* read(input.runId);
      if (
        !stored ||
        stored.threadId !== input.threadId ||
        stored.model !== input.model ||
        stored.maxRequestBytes !== input.maxRequestBytes ||
        stored.maxOutputTokens !== input.maxOutputTokens ||
        stored.status !== "ready" ||
        stored.expiresAt <= (yield* Clock.currentTimeMillis)
      ) {
        return yield* new ConsumerGrantError({
          detail:
            "This consumer request has already been attempted or changed. Reconcile its result before retrying.",
        });
      }
      return stored;
    }),
    readToken: Effect.fn("ConsumerApiGrants.readToken")(function* (token) {
      const rows = yield* protect(
        sql`SELECT ${columns} FROM consumer_api_grants WHERE token = ${token}`.pipe(
          Effect.flatMap(decode),
        ),
      );
      return rows[0] ?? null;
    }),
    claim: Effect.fn("ConsumerApiGrants.claim")(function* (token, contextTruncated) {
      const now = yield* Clock.currentTimeMillis;
      const rows = yield* protect(
        sql`UPDATE consumer_api_grants SET status='forwarding',consumed_at=${now},context_truncated=${contextTruncated ? 1 : 0}
        WHERE token=${token} AND status='ready' AND expires_at>${now} RETURNING ${columns}`.pipe(
          Effect.flatMap(decode),
        ),
      );
      return rows[0] ?? null;
    }),
    rejectUnconsumed: Effect.fn("ConsumerApiGrants.rejectUnconsumed")(function* (runId) {
      yield* protect(
        sql`UPDATE consumer_api_grants SET status='rejected' WHERE run_id=${runId} AND status='ready'`,
      );
      return yield* read(runId);
    }),
    finish: Effect.fn("ConsumerApiGrants.finish")(function* (runId, status, usage, serviceTier) {
      const usageJson =
        usage === undefined
          ? null
          : yield* encodeUsage(usage).pipe(
              Effect.mapError(() => new ConsumerGrantError({ detail: "Invalid usage receipt." })),
            );
      yield* protect(
        sql`UPDATE consumer_api_grants SET status=${status},usage_json=${usageJson},service_tier=${serviceTier ?? null} WHERE run_id=${runId} AND status='forwarding'`,
      );
    }),
  });
});
export const layer = Layer.effect(ConsumerApiGrants, make);
