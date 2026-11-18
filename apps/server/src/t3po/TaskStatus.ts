import type { OrchestrationV2ThreadShell, RunId, T3poTaskView } from "@t3tools/contracts";

export function taskStatus(
  completed: boolean,
  shell: Pick<
    OrchestrationV2ThreadShell,
    | "pendingRuntimeRequest"
    | "hasActionableProposedPlan"
    | "activeRunId"
    | "pendingBackgroundTasks"
    | "status"
    | "latestRunId"
  > | null,
  reviewedRunId: RunId | null = null,
): T3poTaskView["status"] {
  if (!shell) return completed ? "completed" : "up_next";
  if (shell.pendingRuntimeRequest || shell.hasActionableProposedPlan) return "needs_you";
  if (
    shell.activeRunId ||
    (shell.pendingBackgroundTasks?.length ?? 0) > 0 ||
    ["preparing", "queued", "starting", "running", "waiting"].includes(shell.status)
  )
    return "active";
  if (["failed", "interrupted", "cancelled", "rolled_back"].includes(shell.status))
    return "needs_you";
  if (completed && reviewedRunId === shell.latestRunId) return "completed";
  return shell.status === "completed" ? "ready_for_review" : "up_next";
}
