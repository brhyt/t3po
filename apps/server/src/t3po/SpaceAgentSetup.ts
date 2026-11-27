// @effect-diagnostics nodeBuiltinImport:off -- Secret names and setup keys are synchronous SHA-256 digests.
import type { AgentMcpServer } from "@t3tools/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as SpaceTools from "./SpaceTools.ts";

export const mcpSecretName = (serverId: string) =>
  `t3ro-mcp-${NodeCrypto.createHash("sha256").update(serverId).digest("hex").slice(0, 32)}`;
export const githubSecretName = (spaceId: string | null) =>
  `t3ro-github-${NodeCrypto.createHash("sha256")
    .update(spaceId ?? "")
    .digest("hex")
    .slice(0, 32)}`;

/** What a thread's space adds to the agent it starts. */
export interface AgentSetup {
  /** Changes whenever anything below does, so a running session is replaced. */
  readonly key: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly mcpServers: ReadonlyArray<AgentMcpServer>;
  readonly blockedCommands: ReadonlyArray<string>;
  readonly networkOff: boolean;
}

/** A digest of everything the setup adds; empty when it adds nothing. */
const setupKey = (material: Omit<AgentSetup, "key">) => {
  const text = JSON.stringify(material);
  return text ===
    JSON.stringify({ environment: {}, mcpServers: [], blockedCommands: [], networkOff: false })
    ? ""
    : NodeCrypto.createHash("sha256").update(text).digest("hex");
};

const parseStrings = (json: string): string[] => {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
};

/** git asks this helper for github.com credentials; it answers with the space's own token. */
const GIT_CREDENTIAL_HELPER =
  '!f() { test "$1" = get && echo username=x-access-token && echo "password=$GH_TOKEN"; }; f';

/**
 * The space's own GitHub access, when it has one. Without it the agent uses your own sign-in,
 * as everywhere else. `gh` reads GH_TOKEN first; git gets a helper ahead of any configured one.
 */
const githubEnvironment = (input: {
  readonly token: string;
  readonly gitName?: string | undefined;
  readonly gitEmail?: string | undefined;
}): Record<string, string> => ({
  GH_TOKEN: input.token,
  GITHUB_TOKEN: input.token,
  GIT_CONFIG_COUNT: "2",
  // An empty helper first clears helpers from your own git config for github.com.
  GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_0: "",
  GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
  GIT_CONFIG_VALUE_1: GIT_CREDENTIAL_HELPER,
  ...(input.gitName ? { GIT_AUTHOR_NAME: input.gitName, GIT_COMMITTER_NAME: input.gitName } : {}),
  ...(input.gitEmail
    ? { GIT_AUTHOR_EMAIL: input.gitEmail, GIT_COMMITTER_EMAIL: input.gitEmail }
    : {}),
});

export class SpaceAgentSetup extends Context.Service<
  SpaceAgentSetup,
  { readonly forThread: (threadId: string) => Effect.Effect<AgentSetup> }
>()("t3/t3po/SpaceAgentSetup") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* Effect.serviceOption(ServerSecretStore.ServerSecretStore);
  const readSecret = (name: string) =>
    Option.isNone(secrets)
      ? Effect.undefined
      : secrets.value.get(name).pipe(
          Effect.map((value) =>
            Option.isSome(value) ? new TextDecoder().decode(value.value) : undefined,
          ),
          Effect.orElseSucceed(() => undefined),
        );
  const forThread = Effect.fn("SpaceAgentSetup.forThread")(function* (threadId: string) {
    const owner = (yield* sql<{
      projectId: string;
      spaceId: string | null;
    }>`SELECT t.project_id AS projectId, s.id AS spaceId FROM orchestration_v2_projection_threads t LEFT JOIN t3po_project_spaces p ON p.project_id = t.project_id LEFT JOIN t3po_spaces s ON s.id = p.space_id WHERE t.thread_id = ${threadId}`)[0];
    const empty: AgentSetup = {
      key: "",
      environment: {},
      mcpServers: [],
      blockedCommands: [],
      networkOff: false,
    };
    if (!owner) return empty;
    const spaceKey = owner.spaceId ?? "";
    const servers = yield* sql<{
      id: string;
      name: string;
      transport: "http" | "stdio";
      url: string | null;
      command: string | null;
      args: string;
      secretName: string | null;
      hasSecret: number;
    }>`SELECT m.id, m.name, m.transport, m.url, m.command, m.args_json AS args, m.secret_name AS secretName, m.has_secret AS hasSecret FROM t3po_mcp_servers m LEFT JOIN t3po_space_mcp_choices c ON c.server_id = m.id AND c.space_id = ${spaceKey} WHERE (m.space_id IS NULL AND COALESCE(c.enabled, m.shared) = 1) OR (m.space_id IS NOT NULL AND m.space_id = ${spaceKey}) ORDER BY m.rowid`;
    const mcpServers: AgentMcpServer[] = [];
    for (const server of servers) {
      const secret = server.hasSecret ? yield* readSecret(mcpSecretName(server.id)) : undefined;
      const carried: Record<string, string> =
        server.secretName && secret !== undefined ? { [server.secretName]: secret } : {};
      if (server.transport === "http" && server.url)
        mcpServers.push({
          name: server.name,
          transport: "http",
          url: server.url,
          headers: carried,
        });
      if (server.transport === "stdio" && server.command)
        mcpServers.push({
          name: server.name,
          transport: "stdio",
          command: server.command,
          args: parseStrings(server.args),
          env: carried,
        });
    }
    const agent = (yield* sql<{
      hasGithubToken: number;
      gitName: string | null;
      gitEmail: string | null;
      blocked: string;
    }>`SELECT has_github_token AS hasGithubToken, git_name AS gitName, git_email AS gitEmail, blocked_json AS blocked FROM t3po_space_agents WHERE space_id = ${spaceKey}`)[0];
    const token = agent?.hasGithubToken
      ? yield* readSecret(githubSecretName(owner.spaceId))
      : undefined;
    const environment =
      token === undefined
        ? {}
        : githubEnvironment({
            token,
            gitName: agent?.gitName ?? undefined,
            gitEmail: agent?.gitEmail ?? undefined,
          });
    const blockedCommands = agent ? parseStrings(agent.blocked) : [];
    const networkOff = !(yield* SpaceTools.toolAllowed(owner.projectId, "network").pipe(
      Effect.provideService(SqlClient.SqlClient, sql),
    ));
    return {
      key: setupKey({ environment, mcpServers, blockedCommands, networkOff }),
      environment,
      mcpServers,
      blockedCommands,
      networkOff,
    } satisfies AgentSetup;
  });
  const forThreadSafely = Effect.fn("SpaceAgentSetup.forThreadSafely")(function* (
    threadId: string,
  ) {
    return yield* forThread(threadId).pipe(
      Effect.catch((cause) =>
        // Unreadable choices hold the agent back rather than lift its limits.
        Effect.logWarning("Could not read the space's agent setup; network off.", {
          threadId,
          cause,
        }).pipe(
          Effect.as<AgentSetup>({
            key: "unreadable",
            environment: {},
            mcpServers: [],
            blockedCommands: [],
            networkOff: true,
          }),
        ),
      ),
    );
  });
  return SpaceAgentSetup.of({ forThread: forThreadSafely });
});

export const layer = Layer.effect(SpaceAgentSetup, make);
