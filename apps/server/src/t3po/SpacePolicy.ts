import * as SpaceConnections from "./SpaceConnections.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpCapability, McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { DeviceToolkit } from "../mcp/toolkits/device/tools.ts";
import { ExternalActionsToolkit } from "../mcp/toolkits/externalActions/tools.ts";
import { IssuesToolkit } from "../mcp/toolkits/issues/tools.ts";
import { PreviewToolkit } from "../mcp/toolkits/preview/tools.ts";
import { PullRequestsToolkit } from "../mcp/toolkits/pullRequests/tools.ts";

// Unscoped search and remote routing need their own space-aware principals. Browser and device
// tools are offered only when Settings → Tools and the space allow them, and the browser is the
// space's own profile (ServerBrowser enforces it), so they act inside the space.
const scopedTools = new Set([
  "html_preview",
  "html_render",
  "send_to_user",
  "preview_status",
  "preview_open",
  "preview_dialog",
  "preview_navigate",
  "preview_resize",
  "preview_set_appearance",
  "preview_snapshot",
  "preview_act",
  "preview_evaluate",
  "preview_wait_for",
  "preview_recording_start",
  "preview_recording_stop",
  "t3_preview_list",
  "t3_preview_close",
  "device_list",
  "device_open",
  "device_screenshot",
  "device_close",
  "propose_pull_request_draft",
  "orchestrator_capabilities",
  "tool_search",
  "t3_work_route",
  "t3_notes_update",
  "t3_work_schedule",
  "t3_project_icon_set",
  "delegate_task",
  "task_status",
  "task_cancel",
  "t3_background_wait",
  "t3_thread_read",
  "t3_thread_send",
  "t3_thread_wait",
  "t3_thread_interrupt",
  "t3_thread_update",
  "t3_thread_organize",
  "t3_queue",
  "t3_pending_request",
  "t3_thread_configure",
  "t3_worktree_status",
  "t3_worktree_list",
  "t3_project_read",
]);

/** Tools that work only with a capability; Settings → Tools and each space decide which a session gets. */
const toolCapabilities = new Map<string, McpCapability>([
  ...Object.keys(PreviewToolkit.tools).map((name) => [name, "preview"] as const),
  ...Object.keys(DeviceToolkit.tools).map((name) => [name, "device"] as const),
  ...Object.keys(PullRequestsToolkit.tools).map((name) => [name, "pull-requests"] as const),
  ...Object.keys(ExternalActionsToolkit.tools).map((name) => [name, "pull-requests"] as const),
  ...Object.keys(IssuesToolkit.tools).map((name) => [name, "issues"] as const),
]);

/**
 * Inside spaces, pull request and issue tools act on the caller's own thread and project when the
 * space has them on; ids naming another space's work are still refused below.
 */
const allowedInSpaces = (name: string, scope: McpInvocationScope) => {
  if (scopedTools.has(name)) return true;
  const capability = toolCapabilities.get(name);
  return (
    (capability === "pull-requests" || capability === "issues") &&
    scope.capabilities.has(capability)
  );
};

export class SpacePolicy extends Context.Service<
  SpacePolicy,
  {
    readonly allows: (
      name: string,
      payload: unknown,
      scope: McpInvocationScope,
    ) => Effect.Effect<boolean>;
    /** Whether an agent's tool list shows the tool: hidden when every call would be refused. */
    readonly listed: (name: string, scope: McpInvocationScope) => Effect.Effect<boolean>;
  }
>()("t3/t3po/SpacePolicy") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const allows = Effect.fn("SpacePolicy.allows")(
    function* (name: string, payload: unknown, scope: McpInvocationScope) {
      const enabled = yield* sql`SELECT project_id FROM t3po_project_spaces LIMIT 1`;
      if (!enabled.length) return true;
      if (!scope.thread || scope.client?.linked || !allowedInSpaces(name, scope)) return false;
      const caller = yield* sql<{
        projectId: string;
        spaceId: string | null;
      }>`SELECT t.project_id AS projectId, s.space_id AS spaceId FROM orchestration_v2_projection_threads t LEFT JOIN t3po_project_spaces s ON s.project_id = t.project_id WHERE t.thread_id = ${scope.thread.threadId} AND t.deleted_at IS NULL`;
      const owner = caller[0];
      if (!owner) return false;
      const projects = new Set<string>();
      const threads = new Set<string>();
      let remote = false;
      let invalid = false;
      const visit = (value: unknown, key = "") => {
        if (key === "target" && typeof value === "string") {
          try {
            visit(JSON.parse(value));
          } catch {
            invalid = true;
          }
          return;
        }
        if (typeof value === "string") {
          if (/projectId$/i.test(key)) projects.add(value);
          if (/threadId$/i.test(key)) threads.add(value);
          if (key === "environmentId" && value !== scope.environmentId) remote = true;
        } else if (Array.isArray(value)) {
          for (const item of value) visit(item, key.endsWith("Ids") ? key.slice(0, -1) : key);
        } else if (value && typeof value === "object") {
          for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
        }
      };
      visit(payload);
      if (remote || invalid) return false;
      for (const threadId of threads) {
        const target = yield* sql<{
          projectId: string;
        }>`SELECT project_id AS projectId FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId} AND deleted_at IS NULL`;
        if (!target[0]) return false;
        projects.add(target[0].projectId);
      }
      for (const projectId of projects) {
        if (projectId === owner.projectId) continue;
        const target = yield* sql<{
          spaceId: string;
        }>`SELECT space_id AS spaceId FROM t3po_project_spaces WHERE project_id = ${projectId}`;
        if (owner.spaceId === null || target[0]?.spaceId !== owner.spaceId) {
          if (
            name !== "t3_work_route" ||
            threads.size > 0 ||
            !(yield* SpaceConnections.connection(owner.projectId, projectId).pipe(
              Effect.provideService(SqlClient.SqlClient, sql),
            ))
          )
            return false;
        }
      }
      return true;
    },
    Effect.orElseSucceed(() => false),
  );
  const listed = Effect.fn("SpacePolicy.listed")(
    function* (name: string, scope: McpInvocationScope) {
      // Only agents' lists are trimmed; people's own MCP clients keep theirs.
      if (!scope.thread) return true;
      const capability = toolCapabilities.get(name);
      if (capability !== undefined && !scope.capabilities.has(capability)) return false;
      const enabled = yield* sql`SELECT project_id FROM t3po_project_spaces LIMIT 1`;
      return !enabled.length || allowedInSpaces(name, scope);
    },
    Effect.orElseSucceed(() => true),
  );
  return SpacePolicy.of({ allows, listed });
});
export const layer = Layer.effect(SpacePolicy, make);
