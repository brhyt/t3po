import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";

export class Changes extends Context.Service<
  Changes,
  PubSub.PubSub<{
    readonly projectId: ProjectId;
    readonly metadata: boolean;
  }>
>()("t3/t3po/Changes") {}

export const layer = Layer.effect(
  Changes,
  PubSub.sliding<{ projectId: ProjectId; metadata: boolean }>(128),
);
