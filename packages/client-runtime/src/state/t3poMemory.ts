import type { ProjectId } from "@t3tools/contracts";
import type { T3poMemoryCorrection, T3poMemoryEntry } from "@t3tools/contracts";

// Retain this object until success; an ambiguous transport failure must reuse its operation ID.
export function createMemoryCorrection(
  projectId: ProjectId,
  target: T3poMemoryEntry,
  text: string,
  operationId: string,
): T3poMemoryCorrection {
  return {
    projectId,
    targetId: target.id,
    expectedRevision: target.revision,
    text: text.trim(),
    operationId,
  };
}
