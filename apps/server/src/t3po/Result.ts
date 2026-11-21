import type * as SqlClient from "effect/sql/SqlClient";

export const finalAnswers = (sql: SqlClient.SqlClient, threadId: string, runId?: string) => sql`
  SELECT i.run_id, i.thread_id, json_extract(i.payload_json, '$.messageId') AS message_id,
    COALESCE(json_extract(m.payload_json, '$.text'), json_extract(i.payload_json, '$.text'), '') AS text,
    ROW_NUMBER() OVER (PARTITION BY i.run_id, i.thread_id ORDER BY
      CASE WHEN json_extract(i.payload_json, '$.phase') = 'final_answer' THEN 0 ELSE 1 END,
      i.ordinal DESC, i.turn_item_id DESC) AS rank
  FROM orchestration_v2_projection_turn_items i
  LEFT JOIN orchestration_v2_projection_messages m
    ON m.message_id = json_extract(i.payload_json, '$.messageId') AND m.thread_id = i.thread_id
  WHERE i.thread_id = ${threadId} ${runId === undefined ? sql`` : sql`AND i.run_id = ${runId}`}
    AND i.type = 'assistant_message' AND i.status = 'completed'
    AND COALESCE(json_extract(i.payload_json, '$.streaming'), 0) = 0
    AND (json_extract(i.payload_json, '$.phase') IS NULL OR json_extract(i.payload_json, '$.phase') = 'final_answer')`;
