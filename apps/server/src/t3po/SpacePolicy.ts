import * as SpaceConnections from "./SpaceConnections.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";

// Unscoped search, remote routing and device/browser tools need their own space-aware principals.
const scopedTools = new Set([
  "propose_pull_request_draft",
  "orchestrator_capabilities",
  "tool_search",
  "t3_work_route",
  "t3_work_schedule",
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

export class SpacePolicy extends Context.Service<
  SpacePolicy,
  {
    readonly allows: (
      name: string,
      payload: unknown,
      scope: McpInvocationScope,
    ) => Effect.Effect<boolean>;
  }
>()("t3/t3po/SpacePolicy") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const allows = Effect.fn("SpacePolicy.allows")(
    function* (name: string, payload: unknown, scope: McpInvocationScope) {
      const enabled = yield* sql`SELECT project_id FROM t3po_project_spaces LIMIT 1`;
      if (!enabled.length) return true;
      if (!scope.thread || scope.client?.linked || !scopedTools.has(name)) return false;
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
  return SpacePolicy.of({ allows });
});
export const layer = Layer.effect(SpacePolicy, make);
