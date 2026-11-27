import type {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  RunAttemptId,
  ProviderSessionId,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";

/**
 * Sent by MCP clients that cannot defer tools themselves. The T3 MCP server then
 * lists only a core set plus `tool_search`, which lists the rest on demand.
 */
export const MCP_TOOL_EXPOSURE_HEADER = "t3-tool-exposure";

/** A space's own or shared MCP server, added beside T3's (t3ro). */
export type AgentMcpServer =
  | {
      readonly name: string;
      readonly transport: "http";
      readonly url: string;
      readonly headers: Readonly<Record<string, string>>;
    }
  | {
      readonly name: string;
      readonly transport: "stdio";
      readonly command: string;
      readonly args: ReadonlyArray<string>;
      readonly env: Readonly<Record<string, string>>;
    };

export interface McpProviderSessionConfig {
  readonly proposalExecution?: {
    readonly runId: RunId;
    readonly attemptId: RunAttemptId;
    readonly providerSessionId: ProviderSessionId;
    readonly capability: "propose-external-action";
  };
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /** Omit preview_* instructions when the user withholds agent browser access. */
  readonly browserToolsAvailable: boolean;
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
  /** True while a delegated task this thread started will wake it with its result. */
  readonly hasPendingWake?: Effect.Effect<boolean>;
  /** t3ro: what the thread's space adds to its agent; `agentSetupKey` changes when any of it does. */
  readonly agentSetupKey?: string;
  readonly agentEnvironment?: Readonly<Record<string, string>>;
  readonly extraMcpServers?: ReadonlyArray<AgentMcpServer>;
  /** Shell commands starting with any of these are refused. */
  readonly blockedCommands?: ReadonlyArray<string>;
  /** The space turned network access off. */
  readonly networkOff?: boolean;
}

/**
 * The blocked command a shell command contains, word for word anywhere in it, so wrappers such as
 * `bash -c "…"`, `sudo` or `/usr/bin/git` do not slip past. Quoting a command in text matches too.
 */
export function blockedCommandMatch(
  command: string,
  blocked: ReadonlyArray<string> | undefined,
): string | undefined {
  if (!blocked?.length) return undefined;
  const words = (text: string) =>
    text
      .split(/[\s;|&()'"`]+/)
      .filter(Boolean)
      .map((word) => word.slice(word.lastIndexOf("/") + 1))
      .join(" ");
  const haystack = ` ${words(command)} `;
  return blocked.find((rule) => {
    const wanted = words(rule);
    return wanted.length > 0 && haystack.includes(` ${wanted} `);
  });
}
export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}

/** The thread's space environment (t3ro) laid over the agent's own. */
export function withAgentEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentEnvironment;
  return extra === undefined || Object.keys(extra).length === 0 ? base : { ...base, ...extra };
}
