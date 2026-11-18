import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import {
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import type * as Persistence from "../platform/persistence.ts";

export function createT3poAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | Persistence.EnvironmentCacheStore | R, E>,
) {
  const changes = createEnvironmentRpcSubscriptionAtomFamily(runtime, {
    label: "t3po:changes",
    tag: WS_METHODS.t3poSubscribe,
  });
  const snapshot = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "t3po:snapshot",
    tag: WS_METHODS.t3poSnapshot,
    refreshTrigger: ({ environmentId, input }) =>
      changes({
        environmentId,
        input: {
          ...(input.projectId ? { projectId: input.projectId } : {}),
          metadataOnly: input.metadataOnly ?? false,
        },
      }),
  });
  return {
    snapshot,
    results: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "t3po:results",
      tag: WS_METHODS.t3poResults,
      refreshTrigger: ({ environmentId, input }) =>
        changes({ environmentId, input: { projectId: input.projectId, metadataOnly: false } }),
    }),
    mutate: createEnvironmentRpcCommand(runtime, {
      label: "t3po:mutate",
      tag: WS_METHODS.t3poMutate,
    }),
    launch: createEnvironmentRpcCommand(runtime, {
      label: "t3po:launch",
      tag: WS_METHODS.t3poLaunch,
    }),
  };
}
