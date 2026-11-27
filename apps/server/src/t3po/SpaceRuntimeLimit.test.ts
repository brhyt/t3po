import { expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type { OrchestrationV2AppThread, RuntimeMode } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SpaceRuntimeLimit from "./SpaceRuntimeLimit.ts";

const fixture = SpaceRuntimeLimit.layer.pipe(
  Layer.provide(RuntimePolicy.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);
const resolve = (projectId: string, runtimeMode: RuntimeMode) =>
  Effect.flatMap(RuntimePolicy.RuntimePolicyV2, (policy) =>
    policy.resolve({
      thread: {
        id: ThreadId.make("t"),
        projectId: ProjectId.make(projectId),
        runtimeMode,
        interactionMode: "default",
        worktreePath: null,
      } as unknown as OrchestrationV2AppThread,
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt" } as never,
    }),
  );

it.effect("runs a chat set above its space's limit at the limit, and lowers nothing else", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO t3po_spaces (id, name) VALUES ('work', 'Work') ON CONFLICT(id) DO NOTHING`;
    yield* sql`INSERT INTO t3po_project_spaces (project_id, space_id) VALUES ('a', 'work')`;
    yield* sql`INSERT INTO t3po_space_limits (space_id, max_runtime_mode) VALUES ('work', 'auto-accept-edits')`;
    const capped = yield* resolve("a", "full-access");
    expect(capped.runtimeMode).toBe("auto-accept-edits");
    expect(capped.maxRuntimeMode).toBe("auto-accept-edits");
    const lower = yield* resolve("a", "approval-required");
    expect(lower.runtimeMode).toBe("approval-required");
    // A project in no space follows Off Record's limit, which is unset here.
    const free = yield* resolve("b", "full-access");
    expect(free.runtimeMode).toBe("full-access");
    expect(free.maxRuntimeMode).toBeUndefined();
  }).pipe(Effect.provide(fixture)),
);
