import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { databaseProvider, externalPostgresOrigin } from "./privateDeployment.ts";

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
  }),
);
