import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Store from "./Store.ts";
import * as SpacePolicy from "./SpacePolicy.ts";

const fixture = Layer.merge(Store.layer, SpacePolicy.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const projectId = ProjectId.make("a");
const seed = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  for (const project of ["a", "b", "c", "d"]) {
    yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${project}, ${project}, 'Conversation', 'codex', 'approval-required', 'default', '2026-11-19T00:00:00Z', '2026-11-19T00:00:00Z', '{"lineage":{"parentThreadId":null}}')`;
  }
});
const scope: McpInvocationScope = {
  environmentId: EnvironmentId.make("roc"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: "test",
  thread: {
    threadId: ThreadId.make("a"),
    providerInstanceId: ProviderInstanceId.make("codex"),
    providerSessionId: "test",
  },
  client: undefined,
};

it.effect(
  "keeps projects unassigned and enforces local space targets, including encoded remote targets",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.Store;
      const guard = yield* SpacePolicy.SpacePolicy;
      expect((yield* store.read).projectSpaces).toEqual([]);
      expect((yield* store.read).spaces.map((space) => space.name)).toEqual([
        "Personal",
        "Business",
      ]);
      for (const [project, space] of [
        ["a", "personal"],
        ["b", "business"],
        ["c", "personal"],
      ] as const)
        yield* store.mutate({
          type: "assign_space",
          projectId: ProjectId.make(project),
          spaceId: space,
        });
      expect(yield* guard.allows("t3_thread_read", { threadId: "a" }, scope)).toBe(true);
      expect(yield* guard.allows("t3_thread_read", { threadId: "c" }, scope)).toBe(true);
      expect(yield* guard.allows("t3_thread_read", { threadId: "b" }, scope)).toBe(false);
      expect(yield* guard.allows("t3_thread_read", { threadId: "d" }, scope)).toBe(false);
      expect(
        yield* guard.allows(
          "t3_thread_read",
          { threadId: "a" },
          { ...scope, thread: { ...scope.thread!, threadId: ThreadId.make("d") } },
        ),
      ).toBe(false);
      expect(
        yield* guard.allows(
          "delegate_task",
          { target: JSON.stringify({ environmentId: "1421" }) },
          scope,
        ),
      ).toBe(false);
      expect(yield* guard.allows("delegate_task", { target: { provider: "codex" } }, scope)).toBe(
        true,
      );
      for (const name of [
        "t3_thread_list",
        "t3_project_list",
        "t3_thread_transfer",
        "t3_thread_search",
        "future_tool",
      ])
        expect(yield* guard.allows(name, {}, scope)).toBe(false);
      expect(
        yield* guard.allows("t3_thread_read", { threadId: "a" }, { ...scope, thread: undefined }),
      ).toBe(false);
      yield* store.mutate({ type: "save_space", projectId, id: "personal", name: "Private" });
      expect(
        (yield* store.read).projectSpaces.find((row) => row.projectId === projectId)?.spaceId,
      ).toBe("personal");
      expect(
        yield* store
          .mutate({ type: "remove_space", projectId, id: "personal" })
          .pipe(Effect.isFailure),
      ).toBe(true);
      yield* store.mutate({ type: "assign_space", projectId, spaceId: null });
      yield* store.mutate({ type: "assign_space", projectId: ProjectId.make("c"), spaceId: null });
      yield* store.mutate({ type: "remove_space", projectId, id: "personal" });
      expect((yield* store.read).spaces.map((space) => space.id)).toEqual(["business"]);
      const reconstructed = yield* Store.Store.pipe(Effect.provide(Store.layer));
      expect((yield* reconstructed.read).spaces.map((space) => space.id)).toEqual(["business"]);
    }).pipe(Effect.provide(fixture)),
);

it.effect(
  "moves conversations atomically without replacing their history or crossing projects",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.Store;
      const sql = yield* SqlClient.SqlClient;
      const original =
        yield* sql`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id = 'a'`;
      const move = {
        type: "move_conversation" as const,
        projectId,
        threadId: ThreadId.make("a"),
        channelId: "research",
        newChannelName: "Research",
      };
      yield* store.mutate(move);
      yield* store.mutate(move);
      expect((yield* store.read).conversations).toEqual([
        { projectId, threadId: "a", channelId: "research" },
      ]);
      expect(
        yield* sql`SELECT * FROM orchestration_v2_projection_threads WHERE thread_id = 'a'`,
      ).toEqual(original);
      expect(
        yield* store
          .mutate({ ...move, projectId: ProjectId.make("b"), channelId: "bad" })
          .pipe(Effect.isFailure),
      ).toBe(true);
      expect(yield* sql`SELECT id FROM t3po_channels WHERE id = 'bad'`).toEqual([]);
      yield* store.mutate({
        type: "create_channel",
        projectId: ProjectId.make("b"),
        id: "foreign",
        name: "Other",
      });
      expect(
        yield* store
          .mutate({ ...move, channelId: "foreign", newChannelName: undefined })
          .pipe(Effect.isFailure),
      ).toBe(true);
      yield* store.mutate({ type: "archive_channel", projectId, id: "research", archived: true });
      expect((yield* store.read).conversations).toHaveLength(1);
      expect(yield* store.mutate(move).pipe(Effect.isFailure)).toBe(true);
      yield* store.mutate({ ...move, channelId: null, newChannelName: undefined });
      expect((yield* store.read).conversations).toEqual([]);
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{"activeRunId":"running"}' WHERE thread_id = 'd'`;
      expect(
        yield* store
          .mutate({ type: "assign_space", projectId, spaceId: "personal" })
          .pipe(Effect.isFailure),
      ).toBe(true);
      expect((yield* store.read).projectSpaces).toEqual([]);
    }).pipe(Effect.provide(fixture)),
);
