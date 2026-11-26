import type { T3poSpaceToolName } from "@t3tools/contracts";
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** A space's own browser keeps its logins apart from every other space's. */
const SPACE_BROWSER_PROFILE_PREFIX = "space:";

/** The space's choice for a tool, or undefined to follow Settings → Tools. */
export const spaceToolChoice = Effect.fn("SpaceTools.spaceToolChoice")(
  function* (projectId: string, tool: T3poSpaceToolName) {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{
      enabled: number;
    }>`SELECT enabled FROM t3po_space_tools WHERE tool = ${tool} AND space_id = COALESCE((SELECT p.space_id FROM t3po_project_spaces p JOIN t3po_spaces s ON s.id = p.space_id WHERE p.project_id = ${projectId}), '')`;
    return rows[0] === undefined ? undefined : rows[0].enabled === 1;
  },
  Effect.orElseSucceed(() => undefined),
);

/**
 * Once spaces exist, an agent's browser is its space's own profile; a project in no space gets a
 * scratch browser that keeps nothing. Undefined leaves the profile to the agent and the user.
 */
export const browserProfileFor = Effect.fn("SpaceTools.browserProfileFor")(
  function* (threadId: string) {
    const sql = yield* SqlClient.SqlClient;
    const enabled = yield* sql`SELECT project_id FROM t3po_project_spaces LIMIT 1`;
    if (!enabled.length) return undefined;
    const rows = yield* sql<{
      spaceId: string | null;
    }>`SELECT p.space_id AS spaceId FROM orchestration_v2_projection_threads t LEFT JOIN t3po_project_spaces p ON p.project_id = t.project_id WHERE t.thread_id = ${threadId}`;
    const spaceId = rows[0]?.spaceId;
    return spaceId ? `${SPACE_BROWSER_PROFILE_PREFIX}${spaceId}` : INCOGNITO_BROWSER_PROFILE_ID;
  },
  Effect.orElseSucceed((): string | undefined => INCOGNITO_BROWSER_PROFILE_ID),
);
