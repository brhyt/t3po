// @effect-diagnostics anyUnknownInErrorContext:off -- ScratchStack.deploy exposes framework-owned error requirements.
import { inMemoryState } from "alchemy/State";
import * as Test from "@alchemy.run/test/Vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import { MobileSourceMapsUploadCredentials, RelayObservability } from "./observability.ts";

const { test } = Test.make({ providers: Layer.empty, state: inMemoryState() });

test.provider("disabled observability provisions no telemetry resources or credentials", (stack) =>
  Effect.gen(function* () {
    const output = yield* stack
      .deploy(
        Effect.gen(function* () {
          return {
            observability: yield* RelayObservability,
            uploadCredentials: yield* MobileSourceMapsUploadCredentials,
          };
        }),
      )
      .pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ RELAY_OBSERVABILITY: "none" }),
        ),
      );
    expect(output).toEqual({ observability: undefined, uploadCredentials: undefined });
  }),
);
