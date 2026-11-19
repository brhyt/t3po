import * as Schema from "effect/Schema";
import { ProjectId, RunId, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { T3poResult } from "./t3po.ts";
export const ArtifactQuery = Schema.Struct({
  projectId: ProjectId,
  taskId: TrimmedNonEmptyString,
  before: Schema.optional(NonNegativeInt),
});
export type ArtifactQuery = typeof ArtifactQuery.Type;
export const ArtifactSave = Schema.Struct({
  ...ArtifactQuery.fields,
  runId: RunId,
  paths: Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(1024))).check(
    Schema.isMaxLength(20),
  ),
});
export type ArtifactSave = typeof ArtifactSave.Type;
export const ArtifactFile = Schema.Struct({
  path: Schema.String,
  sha256: Schema.String,
  bytes: NonNegativeInt,
});
export const ArtifactVersion = Schema.Struct({
  sequence: NonNegativeInt,
  id: Schema.String,
  projectId: ProjectId,
  taskId: Schema.String,
  threadId: Schema.String,
  savedAt: Schema.String,
  result: T3poResult,
  resultSha256: Schema.String,
  files: Schema.Array(ArtifactFile),
});
export type ArtifactVersion = typeof ArtifactVersion.Type;
export const ArtifactPage = Schema.Struct({
  versions: Schema.Array(ArtifactVersion),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type ArtifactPage = typeof ArtifactPage.Type;
export const ArtifactRead = Schema.Struct({
  projectId: ProjectId,
  versionId: TrimmedNonEmptyString,
  path: Schema.String,
});
export type ArtifactRead = typeof ArtifactRead.Type;
export const ArtifactContent = Schema.Struct({ base64: Schema.String, sha256: Schema.String });
export class ArtifactError extends Schema.TaggedError<ArtifactError>()("ArtifactError", {
  reason: Schema.Literals(["unauthorized", "unavailable", "path", "limit", "storage"]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `Could not access saved version (${this.reason}). Existing versions are preserved.`;
  }
}
