import { isListedThreadLineage, type ScopedProjectRef } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

type ConversationShell = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "projectId"
  | "archivedAt"
  | "lineage"
  | "delegatedFrom"
  | "visibleItemCount"
  | "latestUserMessageAt"
  | "updatedAt"
>;

/** Ordinary conversations stay reachable even when they have no T3PO board record. */
export function projectConversations<T extends ConversationShell>(
  threads: readonly T[],
  project: ScopedProjectRef,
): T[] {
  return threads
    .filter(
      (thread) =>
        thread.environmentId === project.environmentId &&
        thread.projectId === project.projectId &&
        thread.archivedAt === null &&
        isListedThreadLineage(thread.lineage) &&
        thread.delegatedFrom === null &&
        !thread.id.startsWith("t3po-task:") &&
        !thread.id.startsWith("t3po-lead:") &&
        !thread.id.startsWith("t3po-channel:") &&
        (thread.visibleItemCount > 0 || thread.latestUserMessageAt !== null),
    )
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
}
