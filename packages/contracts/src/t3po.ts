import * as Schema from "effect/Schema";
import {
  ProjectId,
  RunId,
  ThreadId,
  MessageId,
  CheckpointId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";
import { NonNegativeInt } from "./baseSchemas.ts";
import { RuntimeMode } from "./providerPolicy.ts";

export const T3poWorkspace = Schema.Union([
  Schema.Struct({ type: Schema.Literal("root") }),
  Schema.Struct({
    type: Schema.Literal("worktree"),
    baseRef: Schema.optional(TrimmedNonEmptyString),
    startFromOrigin: Schema.optional(Schema.Boolean),
  }),
]);
export type T3poWorkspace = typeof T3poWorkspace.Type;
export const T3poQuery = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  channelId: Schema.optional(TrimmedNonEmptyString),
  view: Schema.optional(
    Schema.Literals(["all", "open", "active", "up_next", "completed", "archived", "outputs"]),
  ),
  before: Schema.optional(NonNegativeInt),
  metadataOnly: Schema.optional(Schema.Boolean),
});
export type T3poQuery = typeof T3poQuery.Type;

const T3poBudget = Schema.Struct({
  maxRuns: NonNegativeInt,
  maxConcurrent: NonNegativeInt,
  usedRuns: NonNegativeInt,
  activeRuns: NonNegativeInt,
});
export const T3poLead = Schema.Struct({
  projectId: ProjectId,
  budget: Schema.optional(T3poBudget),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  brief: Schema.String.check(Schema.isMaxLength(12000)),
  threadId: ThreadId,
});
export type T3poLead = typeof T3poLead.Type;
export const T3poChannel = Schema.Struct({
  archived: Schema.optional(Schema.Boolean),
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export const T3poTask = Schema.Struct({
  archived: Schema.optional(Schema.Boolean),
  workspace: Schema.optional(T3poWorkspace),
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  channelId: Schema.NullOr(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  brief: TrimmedNonEmptyString.check(Schema.isMaxLength(12000)),
  threadId: ThreadId,
  completed: Schema.Boolean,
  reviewedRunId: Schema.NullOr(RunId),
  createdAt: Schema.String,
});
export type T3poTask = typeof T3poTask.Type;
export const T3poTaskStatus = Schema.Literals([
  "up_next",
  "active",
  "needs_you",
  "ready_for_review",
  "completed",
]);
export const T3poResult = Schema.Struct({
  runId: RunId,
  runOrdinal: NonNegativeInt,
  messageId: MessageId,
  completedAt: Schema.String,
  checkpointId: Schema.NullOr(CheckpointId),
  text: Schema.String,
  truncated: Schema.Boolean,
});
export type T3poResult = typeof T3poResult.Type;
export const T3poResultsQuery = Schema.Struct({
  projectId: ProjectId,
  taskId: TrimmedNonEmptyString,
  before: Schema.optional(NonNegativeInt),
});
export type T3poResultsQuery = typeof T3poResultsQuery.Type;
export const T3poResultsPage = Schema.Struct({
  results: Schema.Array(T3poResult),
  nextCursor: Schema.NullOr(NonNegativeInt),
});
export type T3poResultsPage = typeof T3poResultsPage.Type;
export const T3poTaskView = Schema.Struct({
  ...T3poTask.fields,
  status: T3poTaskStatus,
  latestResult: Schema.NullOr(T3poResult),
  executionExists: Schema.Boolean,
  workspaceLocked: Schema.Boolean,
  workspacePath: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
});
export type T3poTaskView = typeof T3poTaskView.Type;
export const T3poMemoryProcessing = Schema.Struct({
  ready: Schema.Boolean,
  paused: Schema.Boolean,
  reason: Schema.String,
  counts: Schema.Struct({
    queued: Schema.optional(NonNegativeInt),
    processing: Schema.optional(NonNegativeInt),
    done: Schema.optional(NonNegativeInt),
    failed: Schema.optional(NonNegativeInt),
  }),
});
export const T3poMemoryControl = Schema.Struct({
  type: Schema.Literal("memory_control"),
  projectId: ProjectId,
  action: Schema.Literals(["refresh", "pause", "resume", "retry"]),
});
export type T3poMemoryControl = typeof T3poMemoryControl.Type;
export const T3poMemoryStatus = Schema.Struct({
  projectId: ProjectId,
  configured: Schema.Boolean,
  processing: Schema.optional(T3poMemoryProcessing),
  available: Schema.Boolean,
  pending: NonNegativeInt,
  lastCheckedAt: Schema.NullOr(Schema.String),
});
export const T3poSnapshot = Schema.Struct({
  memory: Schema.Array(T3poMemoryStatus),
  nextCursor: Schema.NullOr(NonNegativeInt),
  leads: Schema.Array(T3poLead),
  channels: Schema.Array(T3poChannel),
  tasks: Schema.Array(T3poTaskView),
});
export const T3poMutation = Schema.Union([
  T3poMemoryControl,
  Schema.Struct({
    type: Schema.Literal("save_budget"),
    projectId: ProjectId,
    maxRuns: NonNegativeInt,
    maxConcurrent: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("save_lead"),
    projectId: ProjectId,
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    brief: Schema.String.check(Schema.isMaxLength(12000)),
  }),
  Schema.Struct({
    type: Schema.Literal("create_channel"),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  }),
  Schema.Struct({
    type: Schema.Literal("create_task"),
    workspace: Schema.optional(T3poWorkspace),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
    channelId: Schema.NullOr(TrimmedNonEmptyString),
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    brief: TrimmedNonEmptyString.check(Schema.isMaxLength(12000)),
  }),
  Schema.Struct({
    type: Schema.Literal("edit_task"),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    brief: TrimmedNonEmptyString.check(Schema.isMaxLength(12000)),
    channelId: Schema.NullOr(TrimmedNonEmptyString),
    workspace: Schema.optional(T3poWorkspace),
  }),
  Schema.Struct({
    type: Schema.Literal("edit_channel"),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  }),
  Schema.Struct({
    type: Schema.Literals(["archive_task", "archive_channel"]),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
    archived: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("review_task"),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
    completed: Schema.Boolean,
  }),
]);
export type T3poMutation = typeof T3poMutation.Type;
export const T3poLaunchInput = Schema.Struct({
  projectId: ProjectId,
  taskId: Schema.optional(TrimmedNonEmptyString),
  channelId: Schema.optional(TrimmedNonEmptyString),
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
});
export type T3poLaunchInput = typeof T3poLaunchInput.Type;
export const T3poLaunchResult = Schema.Struct({ threadId: ThreadId });
export class T3poError extends Schema.TaggedError<T3poError>()("T3poError", {
  operation: Schema.Literals([
    "read",
    "save",
    "launch",
    "invalid",
    "busy",
    "workspace",
    "budget",
    "approval",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    if (this.operation === "budget")
      return "Configure or increase the project run budget before starting task work.";
    if (this.operation === "approval")
      return "Project task work requires the approval-required runtime mode.";
    if (this.operation === "busy") return "Stop the running task before archiving it.";
    if (this.operation === "workspace")
      return "Choose an existing Git base branch for the worktree, or use the project folder.";
    return this.operation === "invalid"
      ? "This project, channel or task is unavailable, or the task is not ready for review."
      : `Could not ${this.operation} project work. Try again; existing work is preserved.`;
  }
}

export const isT3poError = Schema.is(T3poError);
