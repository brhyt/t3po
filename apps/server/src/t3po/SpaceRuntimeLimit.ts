import { isRuntimeModeAbove, type RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as SpaceTools from "./SpaceTools.ts";

/**
 * Lays each space's ceiling from Settings → Tools over the runtime policy. A chat set above it
 * runs at the ceiling, and the agent cannot raise its own mode past it. git, gh and the shell
 * run inside this mode's sandbox, so this is what limits them.
 */
export const layer: Layer.Layer<
  RuntimePolicy.RuntimePolicyV2,
  never,
  RuntimePolicy.RuntimePolicyV2 | SqlClient.SqlClient
> = Layer.effect(
  RuntimePolicy.RuntimePolicyV2,
  Effect.gen(function* () {
    const base = yield* RuntimePolicy.RuntimePolicyV2;
    const sql = yield* SqlClient.SqlClient;
    return RuntimePolicy.RuntimePolicyV2.of({
      resolve: Effect.fn("SpaceRuntimeLimit.resolve")(function* (input) {
        const resolved = yield* base.resolve(input);
        const limit = yield* SpaceTools.spaceRuntimeLimit(input.thread.projectId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          // An unreadable limit holds the agent to asking first rather than lifting it.
          Effect.catch((cause) =>
            Effect.logWarning("Could not read the space's mode limit; asking first.", {
              threadId: input.thread.id,
              cause,
            }).pipe(Effect.as<RuntimeMode>("approval-required")),
          ),
        );
        if (limit === undefined) return resolved;
        return {
          ...resolved,
          runtimeMode: isRuntimeModeAbove(resolved.runtimeMode, limit)
            ? limit
            : resolved.runtimeMode,
          maxRuntimeMode:
            resolved.maxRuntimeMode !== undefined &&
            !isRuntimeModeAbove(resolved.maxRuntimeMode, limit)
              ? resolved.maxRuntimeMode
              : limit,
        };
      }),
    });
  }),
);
