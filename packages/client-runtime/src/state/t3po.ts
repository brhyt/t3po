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
    activity: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "privacy:activity",
      tag: WS_METHODS.privacyActivity,
    }),
    activityChange: createEnvironmentRpcCommand(runtime, {
      label: "privacy:activityChange",
      tag: WS_METHODS.privacyActivityChange,
    }),
    controls: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "privacy:controls",
      tag: WS_METHODS.privacyControls,
    }),
    providerChange: createEnvironmentRpcCommand(runtime, {
      label: "privacy:providerChange",
      tag: WS_METHODS.privacyProviderChange,
    }),
    privacySnapshot: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "privacy:snapshot",
      tag: WS_METHODS.privacySnapshot,
    }),
    privacyChange: createEnvironmentRpcCommand(runtime, {
      label: "privacy:change",
      tag: WS_METHODS.privacyChange,
    }),
    artifactSave: createEnvironmentRpcCommand(runtime, {
      label: "t3po:artifactSave",
      tag: WS_METHODS.t3poArtifactSave,
    }),
    artifactRead: createEnvironmentRpcCommand(runtime, {
      label: "t3po:artifactRead",
      tag: WS_METHODS.t3poArtifactRead,
    }),
    artifactList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "t3po:artifactList",
      tag: WS_METHODS.t3poArtifactList,
    }),
    attention: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "t3po:attention",
      tag: WS_METHODS.t3poAttention,
      refreshTrigger: ({ environmentId, input }) =>
        changes({ environmentId, input: { projectId: input.projectId, metadataOnly: false } }),
    }),
    memoryList: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "t3po:memoryList",
      tag: WS_METHODS.t3poMemoryList,
      refreshTrigger: ({ environmentId, input }) =>
        changes({ environmentId, input: { projectId: input.projectId, metadataOnly: true } }),
    }),
    memoryCorrect: createEnvironmentRpcCommand(runtime, {
      label: "t3po:memoryCorrect",
      tag: WS_METHODS.t3poMemoryCorrect,
    }),
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
