// @effect-diagnostics anyUnknownInErrorContext:off -- ScratchStack.deploy exposes framework-owned error requirements.
import { inMemoryState } from "alchemy/State";
import * as Test from "@alchemy.run/test/Vitest";
import { it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";
import { existingZoneIds, ManagedEndpointZone, RelayApiZone } from "./zone.ts";

const ZONE = "b".repeat(32);
const configuration = {
  RELAY_ZONE_MODE: "existing",
  RELAY_API_ZONE_ID: ZONE,
  RELAY_TUNNEL_ZONE_ID: ZONE,
  RELAY_API_ZONE_NAME: "example.test",
  RELAY_TUNNEL_ZONE_NAME: "example.test",
};
const { test } = Test.make({ providers: Layer.empty, state: inMemoryState() });

test.provider("existing zones do not register Zone resources even on a fresh stage", (stack) =>
  Effect.gen(function* () {
    // No Cloudflare Zone provider exists here: a resource declaration would fail.
    const result = yield* stack
      .deploy(
        Effect.gen(function* () {
          const api = yield* RelayApiZone;
          const tunnel = yield* ManagedEndpointZone;
          return {
            apiKind: api.kind,
            tunnelKind: tunnel.kind,
            apiBinding: api.zoneId.toString(),
            tunnelBinding: tunnel.zoneId.toString(),
          };
        }),
      )
      .pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ ...configuration, RELAY_API_ZONE_ID: "a".repeat(32) }),
        ),
      );
    expect(result).toEqual({
      apiKind: "existing",
      tunnelKind: "existing",
      apiBinding: `ExistingZone_${"a".repeat(32)}`,
      tunnelBinding: `ExistingZone_${ZONE}`,
    });
  }),
);

it.effect("requires both IDs in existing mode instead of silently adopting a zone", () =>
  Effect.gen(function* () {
    const parse = (values: Record<string, string>) =>
      existingZoneIds.pipe(
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown(values)),
      );
    expect(yield* parse({})).toBeUndefined();
    expect(yield* parse(configuration)).toEqual({ api: ZONE, tunnel: ZONE });
    for (const values of [
      { RELAY_ZONE_MODE: "existing" },
      { ...configuration, RELAY_API_ZONE_ID: "" },
      { ...configuration, RELAY_TUNNEL_ZONE_ID: "bad" },
      { ...configuration, RELAY_ZONE_MODE: "external" },
    ])
      expect((yield* Effect.exit(parse(values)))._tag).toBe("Failure");
  }),
);
