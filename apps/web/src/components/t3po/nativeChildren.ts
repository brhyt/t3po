import type { OrchestrationV2ThreadProjection, ThreadId } from "@t3tools/contracts";
import { deriveThreadTurnSubagents } from "@t3tools/client-runtime/state/thread-subagents";

export function deriveNativeChildren(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "subagents">,
  localThreadIds: ReadonlySet<ThreadId>,
) {
  const turn = deriveThreadTurnSubagents(projection);
  const seen = new Set<string>();
  return (turn?.subagents ?? []).flatMap((child) => {
    if (child.origin !== "provider_native") return [];
    const key = child.childThreadId ?? child.id;
    if (seen.has(key)) return [];
    seen.add(key);
    return [
      {
        child,
        navigableThreadId:
          !child.remoteChild &&
          child.childThreadId !== null &&
          localThreadIds.has(child.childThreadId)
            ? child.childThreadId
            : null,
      },
    ];
  });
}
