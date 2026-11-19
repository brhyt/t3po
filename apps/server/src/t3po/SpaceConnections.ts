import { T3poError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const connection = Effect.fn("SpaceConnections.connection")(function* (
  sourceProjectId: string,
  targetProjectId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ sourceSpaceId: string; targetSpaceId: string }>`
    SELECT c.source_space_id AS sourceSpaceId, c.target_space_id AS targetSpaceId
    FROM t3po_space_connections c
    JOIN t3po_project_spaces s ON s.project_id = ${sourceProjectId} AND s.space_id = c.source_space_id
    JOIN t3po_project_spaces t ON t.project_id = c.target_project_id AND t.space_id = c.target_space_id
    WHERE c.target_project_id = ${targetProjectId}`;
  return rows[0];
});

export const checkHandoff = Effect.fn("SpaceConnections.checkHandoff")(function* (jobId: string) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{
    sourceProjectId: string;
    targetProjectId: string;
    sourceSpaceId: string;
    targetSpaceId: string;
    revoked: number;
  }>`SELECT source_project_id AS sourceProjectId, target_project_id AS targetProjectId, source_space_id AS sourceSpaceId, target_space_id AS targetSpaceId, revoked FROM t3po_space_handoffs WHERE job_id = ${jobId}`;
  const handoff = rows[0];
  if (!handoff) return;
  const current = yield* connection(handoff.sourceProjectId, handoff.targetProjectId);
  if (
    handoff.revoked ||
    !current ||
    current.sourceSpaceId !== handoff.sourceSpaceId ||
    current.targetSpaceId !== handoff.targetSpaceId
  )
    return yield* new T3poError({ operation: "space_boundary" });
});
