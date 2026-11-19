import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SchemaIssue from "effect/SchemaIssue";

export function databaseProvider(value: string): "planetscale" | "external-postgres" {
  if (value === "planetscale" || value === "external-postgres") return value;
  throw new Error("RELAY_DATABASE_PROVIDER must be planetscale or external-postgres");
}

export const externalPostgresOrigin = Effect.gen(function* () {
  const provider = yield* Config.schema(
    Schema.Literals(["planetscale", "external-postgres"]),
    "RELAY_DATABASE_PROVIDER",
  ).pipe(Config.withDefault("planetscale"));
  const selected = provider;
  if (selected === "planetscale") return undefined;
  const directUrl = yield* Config.Redacted("DATABASE_URL_UNPOOLED").pipe(Config.option);
  if (Option.isSome(directUrl)) {
    const invalidUrl = new Config.ConfigError(
      new Schema.SchemaError(
        new SchemaIssue.InvalidValue({
          message: "DATABASE_URL_UNPOOLED must be a direct PostgreSQL URL with credentials",
        }),
      ),
    );
    return yield* Effect.try({
      try: () => {
        const url = new URL(Redacted.value(directUrl.value));
        const database = decodeURIComponent(url.pathname.slice(1));
        const user = decodeURIComponent(url.username);
        const password = decodeURIComponent(url.password);
        if (
          !["postgres:", "postgresql:"].includes(url.protocol) ||
          !url.hostname ||
          !database ||
          !user ||
          !password ||
          url.hostname.includes("-pooler.")
        ) {
          throw invalidUrl;
        }
        return {
          scheme: "postgres" as const,
          host: url.hostname,
          port: url.port ? Number(url.port) : 5432,
          database,
          user,
          password: Redacted.make(password),
        };
      },
      catch: () => invalidUrl,
    });
  }
  return {
    scheme: "postgres" as const,
    host: yield* Config.NonEmptyString("RELAY_POSTGRES_HOST"),
    port: yield* Config.Port("RELAY_POSTGRES_PORT").pipe(Config.withDefault(5432)),
    database: yield* Config.NonEmptyString("RELAY_POSTGRES_DATABASE"),
    user: yield* Config.NonEmptyString("RELAY_POSTGRES_USER"),
    password: yield* Config.Redacted("RELAY_POSTGRES_PASSWORD"),
  };
});

export const relayObservabilityMode = Config.schema(
  Schema.Literals(["axiom", "none"]),
  "RELAY_OBSERVABILITY",
).pipe(Config.withDefault("axiom"));
