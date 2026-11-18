import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { projectConversations } from "./projectConversations";

const project = { environmentId: EnvironmentId.make("1421"), projectId: ProjectId.make("t3po") };
function conversation(id: string) {
  return {
    ...project,
    id: ThreadId.make(id),
    archivedAt: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    delegatedFrom: null,
    visibleItemCount: 5,
    latestUserMessageAt: "2026-11-18T11:00:00Z",
    updatedAt: "2026-11-18T11:00:00Z",
  };
}

describe("projectConversations", () => {
  it("keeps existing conversations with no lead or task record across reloads", () => {
    const saved = conversation("existing-review");
    const empty = { ...conversation("bootstrap"), visibleItemCount: 0, latestUserMessageAt: null };
    expect(projectConversations([saved, empty], project)).toEqual([saved]);
    expect(projectConversations(structuredClone([saved, empty]), project)).toEqual([saved]);
  });

  it("keeps project and environment boundaries and excludes board work and nested chats", () => {
    const saved = conversation("saved");
    const child = {
      ...conversation("child"),
      lineage: { ...saved.lineage, relationshipToParent: "subagent" as const },
    };
    const threads = [
      saved,
      conversation("t3po-lead:lead"),
      conversation("t3po-task:task"),
      child,
      { ...conversation("archived"), archivedAt: "2026-11-18T12:00:00Z" },
      { ...conversation("other-machine"), environmentId: EnvironmentId.make("roc") },
      { ...conversation("other-project"), projectId: ProjectId.make("studio") },
      { ...conversation("side-chat"), lineage: { ...saved.lineage, sideChat: true } },
    ];
    expect(projectConversations(threads, project)).toEqual([saved]);
  });

  it("orders recent work first without modifying shared shell state", () => {
    const older = conversation("older");
    const newer = { ...conversation("newer"), updatedAt: "2026-11-18T12:00:00Z" };
    const threads = Object.freeze([older, newer]);
    expect(projectConversations(threads, project)).toEqual([newer, older]);
    expect(threads).toEqual([older, newer]);
  });
});
