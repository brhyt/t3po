import * as Schema from "effect/Schema";
import { NonNegativeInt, ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const Id = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export const T3poMemoryQuery = Schema.Struct({
  projectId: ProjectId,
  before: Schema.optional(NonNegativeInt),
});
export type T3poMemoryQuery = typeof T3poMemoryQuery.Type;
export const T3poMemoryCorrection = Schema.Struct({
  projectId: ProjectId,
  operationId: Id,
  targetId: Id,
  expectedRevision: NonNegativeInt,
  text: TrimmedNonEmptyString.check(Schema.isMaxLength(12000)),
});
export type T3poMemoryCorrection = typeof T3poMemoryCorrection.Type;
export const T3poMemoryEntry = Schema.Struct({
  id: Schema.String,
  sequence: NonNegativeInt,
  kind: Schema.String,
  source: Schema.String,
  occurredAt: Schema.String,
  text: Schema.String,
  revision: NonNegativeInt,
  supersededBy: Schema.NullOr(Schema.String),
  targetId: Schema.NullOr(Schema.String),
  receiptAcceptedAt: Schema.NullOr(Schema.String),
  stage: Schema.Literals(["pending_receipt", "receipt_accepted", "local_only", "held_locally"]),
  honchoDelivery: Schema.Literal("unknown"),
  honchoProcessing: Schema.Literal("unknown"),
});
export type T3poMemoryEntry = typeof T3poMemoryEntry.Type;
export const T3poMemoryPage = Schema.Struct({
  entries: Schema.Array(T3poMemoryEntry),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type T3poMemoryPage = typeof T3poMemoryPage.Type;
export class T3poMemoryError extends Schema.TaggedError<T3poMemoryError>()("T3poMemoryError", {
  reason: Schema.Literals(["forbidden", "stale", "conflict", "invalid", "storage"]),
}) {
  override get message() {
    return `Memory operation failed (${this.reason}). Refresh before trying again.`;
  }
}
