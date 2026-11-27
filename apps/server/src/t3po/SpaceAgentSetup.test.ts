import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as SpaceAgentSetup from "./SpaceAgentSetup.ts";
import * as Store from "./Store.ts";

const secrets = new Map<string, Uint8Array>();
const secretStore = Layer.succeed(ServerSecretStore.ServerSecretStore, {
  get: (name: string) => Effect.succeed(Option.fromNullishOr(secrets.get(name))),
  set: (name: string, value: Uint8Array) => Effect.sync(() => void secrets.set(name, value)),
  remove: (name: string) => Effect.sync(() => void secrets.delete(name)),
} as unknown as ServerSecretStore.ServerSecretStore["Service"]);
const fixture = Layer.merge(Store.layer, SpaceAgentSetup.layer).pipe(
  Layer.provideMerge(secretStore),
  Layer.provideMerge(Sqlite.layerMemory),
);
const projectId = ProjectId.make("a");
const put = (name: string, value: string) => secrets.set(name, new TextEncoder().encode(value));

it.effect("gives each space its shared and own connections, GitHub access and limits", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    for (const project of ["a", "b", "c"])
      yield* sql`INSERT INTO orchestration_v2_projection_threads (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json) VALUES (${project}, ${project}, 'Chat', 'codex', 'full-access', 'default', '2026-11-27T00:00:00Z', '2026-11-27T00:00:00Z', '{"lineage":{"parentThreadId":null}}')`;
    const store = yield* Store.Store;
    const setup = yield* SpaceAgentSetup.SpaceAgentSetup;
    expect((yield* setup.forThread("a")).key).toBe("");
    yield* store.mutate({ type: "assign_space", projectId, spaceId: "personal" });
    yield* store.mutate({
      type: "assign_space",
      projectId: ProjectId.make("b"),
      spaceId: "business",
    });
    const server = (
      id: string,
      name: string,
      spaceId: string | null,
      shared: boolean,
      secretName?: string,
    ) =>
      store.mutate({
        type: "save_mcp_server",
        projectId,
        id,
        name,
        spaceId,
        transport: "http",
        url: `https://${name}.example/mcp`,
        args: [],
        ...(secretName ? { secretName, secret: "s3cret" } : {}),
        shared,
      });
    yield* server("shared", "docs", null, true, "Authorization");
    put(SpaceAgentSetup.mcpSecretName("shared"), "Bearer s3cret");
    yield* server("chosen", "billing", null, false);
    yield* server("own", "crm", "business", false);
    yield* store.mutate({
      type: "set_space_mcp",
      projectId,
      spaceId: "business",
      serverId: "chosen",
      enabled: true,
    });
    yield* store.mutate({
      type: "set_space_mcp",
      projectId,
      spaceId: "personal",
      serverId: "shared",
      enabled: false,
    });
    const names = (threadId: string) =>
      setup.forThread(threadId).pipe(Effect.map((s) => s.mcpServers.map((m) => m.name)));
    expect(yield* names("a")).toEqual([]);
    expect(yield* names("b")).toEqual(["docs", "billing", "crm"]);
    expect(yield* names("c")).toEqual(["docs"]);
    const business = yield* setup.forThread("b");
    expect(business.mcpServers[0]).toEqual({
      name: "docs",
      transport: "http",
      url: "https://docs.example/mcp",
      headers: { Authorization: "Bearer s3cret" },
    });
    expect(business.environment).toEqual({});

    yield* store.mutate({
      type: "save_space_agent",
      projectId,
      spaceId: "business",
      githubToken: "ghp_x",
      gitName: "Work Bot",
      blockedCommands: [" git push --force ", ""],
    });
    put(SpaceAgentSetup.githubSecretName("business"), "ghp_x");
    const withGithub = yield* setup.forThread("b");
    expect(withGithub.environment.GH_TOKEN).toBe("ghp_x");
    expect(withGithub.environment.GIT_AUTHOR_NAME).toBe("Work Bot");
    expect(withGithub.environment.GIT_CONFIG_VALUE_0).toBe("");
    expect(withGithub.blockedCommands).toEqual(["git push --force"]);
    expect(withGithub.key).not.toBe(business.key);
    // Off Record and other spaces keep your own sign-in.
    expect((yield* setup.forThread("c")).environment).toEqual({});
    expect((yield* store.read).spaceAgents).toEqual([
      {
        spaceId: "business",
        hasGithubToken: true,
        gitName: "Work Bot",
        blockedCommands: ["git push --force"],
      },
    ]);

    yield* store.mutate({ type: "set_tool_default", projectId, tool: "network", enabled: false });
    expect((yield* setup.forThread("c")).networkOff).toBe(true);
    expect(
      yield* store
        .mutate({
          type: "save_mcp_server",
          projectId,
          id: "bad",
          name: "t3-code",
          spaceId: null,
          transport: "http",
          url: "https://x",
          args: [],
          shared: true,
        })
        .pipe(Effect.isFailure),
    ).toBe(true);
    expect(
      yield* store
        .mutate({
          type: "save_mcp_server",
          projectId,
          id: "bad",
          name: "files",
          spaceId: null,
          transport: "http",
          url: "file:///etc",
          args: [],
          shared: true,
        })
        .pipe(Effect.isFailure),
    ).toBe(true);
  }).pipe(Effect.provide(fixture)),
);
