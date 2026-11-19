import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

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
  return {
    scheme: "postgres" as const,
    host: yield* Config.NonEmptyString("RELAY_POSTGRES_HOST"),
    port: yield* Config.Port("RELAY_POSTGRES_PORT").pipe(Config.withDefault(5432)),
    database: yield* Config.NonEmptyString("RELAY_POSTGRES_DATABASE"),
    user: yield* Config.NonEmptyString("RELAY_POSTGRES_USER"),
    password: yield* Config.Redacted("RELAY_POSTGRES_PASSWORD"),
  };
});
