import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { allowedClerkUserIdsConfig } from "./Config.ts";
import * as Redacted from "effect/Redacted";
import {
  databaseProvider,
  externalPostgresOrigin,
  relayObservabilityMode,
} from "./privateDeployment.ts";

const configured = (values: Record<string, string>) =>
  externalPostgresOrigin.pipe(
    Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
  );
it.effect("preserves the managed default and rejects unknown providers", () =>
  Effect.gen(function* () {
    expect(yield* configured({})).toBeUndefined();
    expect(() => databaseProvider("external")).toThrow();
  }),
);
it.effect("requires complete external configuration instead of falling back to provisioning", () =>
  Effect.gen(function* () {
    const failure = yield* configured({ RELAY_DATABASE_PROVIDER: "external-postgres" }).pipe(
      Effect.flip,
    );
    expect(failure).toBeDefined();
    const origin = yield* configured({
      RELAY_DATABASE_PROVIDER: "external-postgres",
      RELAY_POSTGRES_HOST: "db.example.test",
      RELAY_POSTGRES_DATABASE: "relay",
      RELAY_POSTGRES_USER: "relay_runtime",
      RELAY_POSTGRES_PASSWORD: "test-only",
    });
    expect(origin?.port).toBe(5432);
    expect(origin?.scheme).toBe("postgres");
    expect(Redacted.value(origin!.password)).toBe("test-only");
    const neonOrigin = yield* configured({
      RELAY_DATABASE_PROVIDER: "external-postgres",
      DATABASE_URL_UNPOOLED:
        "postgresql://relay%40runtime:test%3Aonly@ep-test.us-east-2.aws.neon.tech/ro%20relay?sslmode=require",
    });
    expect(neonOrigin).toMatchObject({
      host: "ep-test.us-east-2.aws.neon.tech",
      database: "ro relay",
      user: "relay@runtime",
      port: 5432,
    });
    expect(Redacted.value(neonOrigin!.password)).toBe("test:only");
    for (const invalid of [
      "https://user:test-secret@db.example.test/relay",
      "postgres://user:test-secret@ep-test-pooler.us-east-2.aws.neon.tech/relay",
      "postgres://user:test-secret@db.example.test/",
      "postgres://user@db.example.test/relay",
      "test-secret",
    ]) {
      const error = yield* configured({
        RELAY_DATABASE_PROVIDER: "external-postgres",
        DATABASE_URL_UNPOOLED: invalid,
      }).pipe(Effect.flip);
      expect(String(error)).toContain("DATABASE_URL_UNPOOLED");
      expect(String(error)).not.toContain("test-secret");
    }
  }),
);

it.effect("rejects malformed owner restrictions instead of silently opening access", () =>
  Effect.gen(function* () {
    const parse = (values: Record<string, string>) =>
      allowedClerkUserIdsConfig.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
      );
    expect(Option.isNone(yield* parse({}))).toBe(true);
    expect((yield* Effect.exit(parse({ RELAY_ACCESS_MODE: "allowlist" })))._tag).toBe("Failure");
    expect((yield* Effect.exit(parse({ RELAY_ACCESS_MODE: "allow" })))._tag).toBe("Failure");
    expect(
      Option.getOrThrow(
        yield* parse({ RELAY_ACCESS_MODE: "allowlist", RELAY_ALLOWED_CLERK_USER_IDS: "[]" }),
      ),
    ).toEqual([]);
    expect(
      Option.getOrThrow(
        yield* parse({
          RELAY_ACCESS_MODE: "allowlist",
          RELAY_ALLOWED_CLERK_USER_IDS: '["user_owner"]',
        }),
      ),
    ).toEqual(["user_owner"]);
    for (const invalid of [
      "",
      "user_owner",
      "null",
      '"user_owner"',
      '["*"]',
      '["gilberto@example.test"]',
      '["user_owner", ""]',
    ]) {
      expect(
        (yield* Effect.exit(
          parse({ RELAY_ACCESS_MODE: "allowlist", RELAY_ALLOWED_CLERK_USER_IDS: invalid }),
        ))._tag,
        invalid,
      ).toBe("Failure");
    }
  }),
);
it.effect("requires an explicit observability opt-out and rejects misspelled modes", () =>
  Effect.gen(function* () {
    const parse = (values: Record<string, string>) =>
      relayObservabilityMode.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
      );
    expect(yield* parse({})).toBe("axiom");
    expect(yield* parse({ RELAY_OBSERVABILITY: "none" })).toBe("none");
    expect((yield* Effect.exit(parse({ RELAY_OBSERVABILITY: "off" })))._tag).toBe("Failure");
  }),
);
