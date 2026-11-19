import * as Schema from "effect/Schema";
import { ProjectId, RunId, NonNegativeInt } from "./baseSchemas.ts";
export const AttentionQuery = Schema.Struct({
  projectId: ProjectId,
  before: Schema.optional(NonNegativeInt),
});
export type AttentionQuery = typeof AttentionQuery.Type;
export const AttentionItem = Schema.Struct({
  key: Schema.String,
  taskId: Schema.String,
  threadId: Schema.String,
  title: Schema.String,
  runId: Schema.NullOr(RunId),
  reason: Schema.Literals(["request", "plan", "failed", "review"]),
});
export type AttentionItem = typeof AttentionItem.Type;
export const AttentionPage = Schema.Struct({
  items: Schema.Array(AttentionItem),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type AttentionPage = typeof AttentionPage.Type;
