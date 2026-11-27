import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as Store from "./Store.ts";
import * as SpacePolicy from "./SpacePolicy.ts";
import * as SpaceTools from "./SpaceTools.ts";

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

it.effect(
  "shares references only with named spaces without expanding chat or handoff authority",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.Store;
      const guard = yield* SpacePolicy.SpacePolicy;
      yield* store.mutate({ type: "save_space", projectId, id: "third", name: "Third" });
      for (const [id, space] of [
        ["a", "personal"],
        ["b", "business"],
        ["c", "third"],
      ]) {
        yield* store.mutate({
          type: "assign_space",
          projectId: ProjectId.make(id!),
          spaceId: space!,
        });
        yield* store.mutate({
          type: "save_lead",
          projectId: ProjectId.make(id!),
          name: "Lead",
          brief: "Private brief",
        });
      }
      const resource = {
        type: "share_resource" as const,
        projectId,
        id: "service",
        ownerSpaceId: "personal",
        targetSpaceId: "business",
        name: "Shared design service",
        location: "https://design.example.com",
      };
      yield* store.mutate(resource);
      for (const id of ["a", "b"])
        expect(
          (yield* store.context(ProjectId.make(id), ThreadId.make(`t3po-lead:${id}`))).context,
        ).toContain("https://design.example.com");
      expect(
        (yield* store.context(ProjectId.make("c"), ThreadId.make("t3po-lead:c"))).context,
      ).not.toContain("https://design.example.com");
      expect(yield* guard.allows("t3_thread_read", { threadId: "b" }, scope)).toBe(false);
      for (const location of [
        "https://user:password@example.com",
        "https://example.com?token=secret",
        "javascript:alert(1)",
      ])
        expect(yield* store.mutate({ ...resource, location }).pipe(Effect.isFailure)).toBe(true);
      const connect = {
        type: "connect_space" as const,
        projectId,
        sourceSpaceId: "personal",
        targetSpaceId: "business",
        targetProjectId: ProjectId.make("b"),
        enabled: true,
      };
      yield* store.mutate(connect);
      yield* store.mutate({
        ...connect,
        sourceSpaceId: "business",
        targetSpaceId: "third",
        targetProjectId: ProjectId.make("c"),
      });
      expect(yield* guard.allows("t3_work_route", { destinationProjectId: "b" }, scope)).toBe(true);
      expect(yield* guard.allows("t3_work_route", { destinationProjectId: "c" }, scope)).toBe(
        false,
      );
      expect(yield* guard.allows("t3_thread_read", { threadId: "b" }, scope)).toBe(false);
      expect(yield* guard.allows("t3_thread_send", { threadId: "b" }, scope)).toBe(false);
      expect(
        yield* guard.allows(
          "t3_work_route",
          { destinationProjectId: "a" },
          { ...scope, thread: { ...scope.thread!, threadId: ThreadId.make("b") } },
        ),
      ).toBe(false);
      yield* store.mutate({ type: "unshare_resource", projectId, id: resource.id });
      expect(
        (yield* store.context(ProjectId.make("b"), ThreadId.make("t3po-lead:b"))).context,
      ).not.toContain("https://design.example.com");
      yield* store.mutate({
        type: "assign_space",
        projectId: ProjectId.make("b"),
        spaceId: "third",
      });
      yield* store.mutate({
        type: "assign_space",
        projectId: ProjectId.make("b"),
        spaceId: "business",
      });
      expect(yield* guard.allows("t3_work_route", { destinationProjectId: "b" }, scope)).toBe(
        false,
      );
    }).pipe(Effect.provide(fixture)),
);

it.effect("persists space rules across renames and injects them only into assigned projects", () =>
  Effect.gen(function* () {
    const store = yield* Store.Store;
    yield* store.mutate({ type: "save_lead", projectId, name: "Lead", brief: "Work" });
    yield* store.mutate({
      type: "save_space_rules",
      projectId,
      id: "personal",
      rules: "Use personal accounts only.",
    });
    expect((yield* store.context(projectId, ThreadId.make("t3po-lead:a"))).context).not.toContain(
      "Use personal accounts only.",
    );
    yield* store.mutate({ type: "assign_space", projectId, spaceId: "personal" });
    yield* store.mutate({ type: "save_space", projectId, id: "personal", name: "Private" });
    const rebuilt = yield* Store.Store.pipe(Effect.provide(Layer.fresh(Store.layer)));
    expect((yield* rebuilt.context(projectId, ThreadId.make("t3po-lead:a"))).context).toContain(
      "Use personal accounts only.",
    );
    yield* store.mutate({ type: "save_space_rules", projectId, id: "personal", rules: "" });
    expect((yield* store.context(projectId, ThreadId.make("t3po-lead:a"))).context).not.toContain(
      "Use personal accounts only.",
    );
  }).pipe(Effect.provide(fixture)),
);

it.effect("lets space agents use the browser, devices and pages in their own space's browser", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* Store.Store;
    const guard = yield* SpacePolicy.SpacePolicy;
    expect(yield* SpaceTools.browserProfileFor("a")).toBeUndefined();
    for (const [project, space] of [
      ["a", "personal"],
      ["b", "business"],
    ] as const)
      yield* store.mutate({
        type: "assign_space",
        projectId: ProjectId.make(project),
        spaceId: space,
      });
    for (const name of [
      "preview_open",
      "preview_act",
      "device_open",
      "html_render",
      "send_to_user",
    ])
      expect(yield* guard.allows(name, { url: "https://rig.ai" }, scope)).toBe(true);
    // Another space's conversation stays out of reach through browser tools too.
    expect(yield* guard.allows("preview_status", { threadId: "b" }, scope)).toBe(false);
    expect(yield* SpaceTools.browserProfileFor("a")).toBe("space:personal");
    expect(yield* SpaceTools.browserProfileFor("b")).toBe("space:business");
    expect(yield* SpaceTools.browserProfileFor("c")).toBe("incognito");

    expect(yield* SpaceTools.spaceToolChoice("a", "browser")).toBeUndefined();
    yield* store.mutate({
      type: "set_space_tool",
      projectId,
      spaceId: "personal",
      tool: "browser",
      enabled: false,
    });
    yield* store.mutate({
      type: "set_space_tool",
      projectId,
      spaceId: null,
      tool: "device",
      enabled: true,
    });
    expect(yield* SpaceTools.spaceToolChoice("a", "browser")).toBe(false);
    expect(yield* SpaceTools.spaceToolChoice("b", "browser")).toBeUndefined();
    expect(yield* SpaceTools.spaceToolChoice("c", "device")).toBe(true);
    expect((yield* store.read).spaceTools).toEqual([
      { spaceId: "personal", tool: "browser", enabled: false },
      { spaceId: null, tool: "device", enabled: true },
    ]);
    expect(
      yield* store
        .mutate({
          type: "set_space_tool",
          projectId,
          spaceId: "missing",
          tool: "browser",
          enabled: true,
        })
        .pipe(Effect.isFailure),
    ).toBe(true);
    yield* store.mutate({
      type: "set_space_tool",
      projectId,
      spaceId: "personal",
      tool: "browser",
      enabled: null,
    });
    expect(yield* SpaceTools.spaceToolChoice("a", "browser")).toBeUndefined();
    yield* store.mutate({
      type: "set_space_tool",
      projectId,
      spaceId: "business",
      tool: "browser",
      enabled: true,
    });
    yield* store.mutate({ type: "assign_space", projectId: ProjectId.make("b"), spaceId: null });
    yield* store.mutate({ type: "remove_space", projectId, id: "business" });
    expect((yield* store.read).spaceTools).toEqual([
      { spaceId: null, tool: "device", enabled: true },
    ]);
  }).pipe(Effect.provide(fixture)),
);

it.effect("lets a space turn pull request and issue tools on, and hides what it turned off", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* Store.Store;
    const guard = yield* SpacePolicy.SpacePolicy;
    const withTools = {
      ...scope,
      capabilities: new Set(["orchestration", "pull-requests", "issues"] as const),
    };
    // Before any space exists every tool is listed and allowed, as in T3 Code.
    expect(yield* guard.listed("link_pull_request", withTools)).toBe(true);
    expect(yield* guard.listed("link_pull_request", scope)).toBe(false);
    expect(yield* guard.listed("preview_open", scope)).toBe(false);
    expect(yield* SpaceTools.toolAllowed("a", "pull-requests")).toBe(true);
    for (const [project, space] of [
      ["a", "personal"],
      ["b", "business"],
    ] as const)
      yield* store.mutate({
        type: "assign_space",
        projectId: ProjectId.make(project),
        spaceId: space,
      });
    expect(yield* guard.allows("link_pull_request", { url: "https://x" }, withTools)).toBe(true);
    expect(yield* guard.allows("list_issues", {}, withTools)).toBe(true);
    expect(yield* guard.allows("link_pull_request", { url: "https://x" }, scope)).toBe(false);
    // Still only the caller's own space's work.
    expect(yield* guard.allows("list_thread_issues", { threadId: "b" }, withTools)).toBe(false);
    expect(yield* guard.listed("t3_thread_list", withTools)).toBe(false);
    expect(yield* guard.listed("t3_thread_read", withTools)).toBe(true);
    // The user's own MCP clients keep their full list.
    expect(yield* guard.listed("t3_thread_list", { ...scope, thread: undefined })).toBe(true);

    yield* store.mutate({ type: "set_tool_default", projectId, tool: "issues", enabled: false });
    yield* store.mutate({
      type: "set_space_tool",
      projectId,
      spaceId: "personal",
      tool: "issues",
      enabled: true,
    });
    expect(yield* SpaceTools.toolAllowed("a", "issues")).toBe(true);
    expect(yield* SpaceTools.toolAllowed("b", "issues")).toBe(false);
    expect(yield* SpaceTools.toolAllowed("c", "issues")).toBe(false);
    const read = yield* store.read;
    expect(read.toolDefaults).toEqual([{ tool: "issues", enabled: false }]);
    expect(read.spaceTools).toEqual([{ spaceId: "personal", tool: "issues", enabled: true }]);
  }).pipe(Effect.provide(fixture)),
);

it.effect("lets a space use secrets and schedules, only for its own scheduled tasks", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* Store.Store;
    const guard = yield* SpacePolicy.SpacePolicy;
    const sql = yield* SqlClient.SqlClient;
    for (const [project, space] of [
      ["a", "personal"],
      ["b", "business"],
    ] as const)
      yield* store.mutate({
        type: "assign_space",
        projectId: ProjectId.make(project),
        spaceId: space,
      });
    for (const [task, project] of [
      ["mine", "a"],
      ["theirs", "b"],
    ])
      yield* sql`INSERT INTO scheduled_tasks (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json, model_selection_json, runtime_mode, interaction_mode, created_by, creation_source, created_at, updated_at, last_run_status, run_count) VALUES (${task}, 'T', 'p', 1, '{}', ${project}, '{}', '{}', 'full-access', 'default', 'user', 'mcp', '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z', 'never', 0)`;
    expect(yield* guard.allows("request_secret", { label: "x", reason: "y" }, scope)).toBe(true);
    expect(yield* guard.allows("list_scheduled_tasks", {}, scope)).toBe(true);
    const known = yield* sql`SELECT task_id FROM scheduled_tasks`;
    expect(known.length).toBe(2);
    expect(yield* guard.allows("delete_scheduled_task", { scheduledTaskId: "mine" }, scope)).toBe(
      true,
    );
    expect(yield* guard.allows("delete_scheduled_task", { scheduledTaskId: "theirs" }, scope)).toBe(
      false,
    );
    expect(yield* guard.allows("run_scheduled_task_now", { taskId: "theirs" }, scope)).toBe(false);
    // A delegated task's taskId is not a scheduled task.
    expect(yield* guard.allows("task_status", { taskId: "delegated-1" }, scope)).toBe(true);
    yield* store.mutate({
      type: "set_space_tool",
      projectId,
      spaceId: "personal",
      tool: "secrets",
      enabled: false,
    });
    expect(yield* guard.allows("request_secret", { label: "x", reason: "y" }, scope)).toBe(false);
    expect(yield* guard.listed("request_secret", scope)).toBe(false);
    expect(yield* guard.listed("schedule_task", scope)).toBe(true);
  }).pipe(Effect.provide(fixture)),
);

it.effect("keeps each space's mode limit and drops it with the space", () =>
  Effect.gen(function* () {
    yield* seed;
    const store = yield* Store.Store;
    yield* store.mutate({ type: "assign_space", projectId, spaceId: "business" });
    expect(yield* SpaceTools.spaceRuntimeLimit("a")).toBeUndefined();
    yield* store.mutate({
      type: "set_space_limit",
      projectId,
      spaceId: "business",
      maxRuntimeMode: "auto-accept-edits",
    });
    yield* store.mutate({
      type: "set_space_limit",
      projectId,
      spaceId: null,
      maxRuntimeMode: "approval-required",
    });
    expect(yield* SpaceTools.spaceRuntimeLimit("a")).toBe("auto-accept-edits");
    expect(yield* SpaceTools.spaceRuntimeLimit("c")).toBe("approval-required");
    expect((yield* store.read).spaceLimits).toEqual([
      { spaceId: "business", maxRuntimeMode: "auto-accept-edits" },
      { spaceId: null, maxRuntimeMode: "approval-required" },
    ]);
    yield* store.mutate({
      type: "set_space_limit",
      projectId,
      spaceId: null,
      maxRuntimeMode: null,
    });
    yield* store.mutate({ type: "assign_space", projectId, spaceId: null });
    yield* store.mutate({ type: "remove_space", projectId, id: "business" });
    expect((yield* store.read).spaceLimits).toEqual([]);
  }).pipe(Effect.provide(fixture)),
);

it.effect(
  "moves only ordinary conversations between projects, clears their channel and keeps memory as it was",
  () =>
    Effect.gen(function* () {
      yield* seed;
      const store = yield* Store.Store;
      const guard = yield* SpacePolicy.SpacePolicy;
      const sql = yield* SqlClient.SqlClient;
      for (const [thread, payload] of [
        ["child", '{"lineage":{"parentThreadId":"a"}}'],
        ["delegated", '{"lineage":{"parentThreadId":null},"delegatedFrom":{"threadId":"a"}}'],
        ["t3po-lead:a", '{"lineage":{"parentThreadId":null}}'],
        ["t3po-task:job", '{"lineage":{"parentThreadId":null}}'],
      ] as const)
        yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${thread}, 'a', 'Conversation', 'codex', 'approval-required', 'default', '2026-11-19T00:00:00Z', '2026-11-19T00:00:00Z', ${payload})`;
      for (const [project, space] of [
        ["a", "personal"],
        ["b", "business"],
      ] as const) {
        yield* store.mutate({
          type: "assign_space",
          projectId: ProjectId.make(project),
          spaceId: space,
        });
        yield* store.mutate({
          type: "save_lead",
          projectId: ProjectId.make(project),
          name: "Lead",
          brief: `Brief for ${project}`,
        });
      }
      const memory = () =>
        sql<{
          projectId: string;
          count: number;
        }>`SELECT project_id AS projectId, count(*) AS count FROM t3po_memory_events_v2 GROUP BY project_id ORDER BY project_id`;
      const remembered = yield* memory();
      expect(remembered).toEqual([
        { projectId: "a", count: 1 },
        { projectId: "b", count: 1 },
      ]);
      yield* store.mutate({
        type: "move_conversation",
        projectId,
        threadId: ThreadId.make("a"),
        channelId: "research",
        newChannelName: "Research",
      });
      const move = (threadId: string, targetProjectId = "b") => ({
        type: "move_conversation_project" as const,
        projectId,
        threadId: ThreadId.make(threadId),
        targetProjectId: ProjectId.make(targetProjectId),
      });
      for (const refused of [
        move("child"),
        move("delegated"),
        move("t3po-lead:a"),
        move("t3po-task:job"),
        move("t3po-channel:research"),
        move("a", "a"),
        move("b"),
      ])
        expect(yield* store.checkConversationMove(refused).pipe(Effect.isFailure)).toBe(true);
      yield* store.mutate({
        type: "create_task",
        projectId,
        id: "job",
        channelId: null,
        title: "Job",
        brief: "Do the job.",
      });
      yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.threadId', 'a') WHERE id = 'job'`;
      // A thread a job runs in is not an ordinary conversation.
      expect(yield* store.checkConversationMove(move("a")).pipe(Effect.isFailure)).toBe(true);
      yield* sql`DELETE FROM t3po_tasks WHERE id = 'job'`;
      yield* store.checkConversationMove(move("a"));

      // Agents cannot reach another space's project; only the user interface moves across.
      expect(
        yield* guard.allows("t3_thread_update", { threadId: "a", projectId: "b" }, scope),
      ).toBe(false);
      expect(yield* guard.allows("t3po_mutate", { threadId: "a", projectId: "b" }, scope)).toBe(
        false,
      );

      // Orchestration re-parents the thread; the store then forgets its channel in project a.
      yield* sql`UPDATE orchestration_v2_projection_threads SET project_id = 'b' WHERE thread_id = 'a'`;
      yield* store.mutate(move("a"));
      expect((yield* store.read).conversations).toEqual([]);
      // Old turns are not copied into b's memory, and a's memory stays.
      expect(yield* memory()).toEqual(remembered);
    }).pipe(Effect.provide(fixture)),
);
