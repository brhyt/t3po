import { RunId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { taskStatus } from "./TaskStatus.ts";

const finished = {
  pendingRuntimeRequest: null,
  hasActionableProposedPlan: false,
  activeRunId: null,
  latestRunId: RunId.make("finished-run"),
  status: "completed" as const,
};
it("requires review after execution and exposes new work or failures even on a reviewed task", () => {
  expect(taskStatus(false, null)).toBe("up_next");
  expect(taskStatus(false, finished)).toBe("ready_for_review");
  expect(taskStatus(true, finished, finished.latestRunId)).toBe("completed");
  expect(
    taskStatus(true, { ...finished, latestRunId: RunId.make("new-run") }, finished.latestRunId),
  ).toBe("ready_for_review");
  expect(taskStatus(true, { ...finished, activeRunId: RunId.make("new-run") })).toBe("active");
  expect(taskStatus(false, { ...finished, hasActionableProposedPlan: true })).toBe("needs_you");
  for (const status of ["failed", "interrupted", "cancelled", "rolled_back"] as const)
    expect(taskStatus(true, { ...finished, status })).toBe("needs_you");
});

it("routine jobs finish without acceptance while requests, children and failures remain visible", () => {
  expect(taskStatus(false, finished, null, false)).toBe("completed");
  expect(taskStatus(false, { ...finished, hasActionableProposedPlan: true }, null, false)).toBe(
    "needs_you",
  );
  expect(taskStatus(false, { ...finished, status: "failed" }, null, false)).toBe("needs_you");
  expect(taskStatus(false, { ...finished, activeRunId: RunId.make("child") }, null, false)).toBe(
    "active",
  );
  expect(taskStatus(false, finished, null, true)).toBe("ready_for_review");
});
