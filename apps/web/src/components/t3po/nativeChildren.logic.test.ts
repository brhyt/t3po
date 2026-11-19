import { describe, expect, it } from "vite-plus/test";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { deriveNativeChildren } from "./nativeChildren";

function child(overrides: Partial<OrchestrationV2Subagent> = {}): OrchestrationV2Subagent {
  return {
    id: NodeId.make("native-child"),
    threadId: ThreadId.make("parent"),
    runId: null,
    parentNodeId: NodeId.make("parent-node"),
    origin: "provider_native",
    createdBy: "agent",
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerThreadId: null,
    childThreadId: ThreadId.make("child-thread"),
    nativeTaskRef: null,
    prompt: "Implement",
    title: "Worker",
    model: null,
    status: "running",
    result: null,
    startedAt: DateTime.makeUnsafe("2026-11-18T00:00:00Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-18T00:00:01Z"),
    ...overrides,
  };
}

describe("native children", () => {
  it.each(["completed", "failed", "cancelled", "interrupted", "idle"] as const)(
    "keeps %s children visible with their actual status",
    (status) => {
      const agent = child({ status });
      const rows = deriveNativeChildren(
        { runs: [], subagents: [agent] },
        new Set([agent.childThreadId!]),
      );
      expect(rows).toEqual([{ child: agent, navigableThreadId: agent.childThreadId }]);
    },
  );

  it("retains children without a local thread and never invents a navigation target", () => {
    const agents = [child(), child({ id: NodeId.make("no-thread"), childThreadId: null })];
    const rows = deriveNativeChildren({ runs: [], subagents: agents }, new Set());
    expect(rows.map((row) => row.child.id)).toEqual(agents.map((agent) => agent.id));
    expect(rows.map((row) => row.navigableThreadId)).toEqual([null, null]);
  });

  it("excludes app-owned board work and shows each native child only once without modifying projections", () => {
    const native = child();
    const agents = [
      native,
      child({ id: NodeId.make("z-duplicate") }),
      child({
        id: NodeId.make("task"),
        origin: "app_owned",
        childThreadId: ThreadId.make("task-thread"),
      }),
    ];
    const projection = { runs: [], subagents: agents };
    const rows = deriveNativeChildren(projection, new Set());
    expect(rows.map((row) => row.child.id)).toEqual([native.id]);
    expect(projection.subagents).toEqual(agents);
    expect(projection.subagents).toHaveLength(3);
  });
});
