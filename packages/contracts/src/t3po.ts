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
export const T3poWorkstream = Schema.Struct({
  id: TrimmedNonEmptyString,
  projectId: ProjectId,
  channelId: Schema.NullOr(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  goal: Schema.String.check(Schema.isMaxLength(12000)),
  state: Schema.Literals(["active", "waiting", "completed", "archived"]),
});
export type T3poWorkstream = typeof T3poWorkstream.Type;
export const T3poWorkRoute = Schema.Struct({
  reportToOrigin: Schema.optional(Schema.Boolean),
  destinationProjectId: Schema.optional(ProjectId),
  requestId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  sourceMessageId: MessageId,
  action: Schema.Literals(["new_job", "follow_up"]),
  workstreamId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  workstreamTitle: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  goal: Schema.String.check(Schema.isMaxLength(12000)),
  jobId: Schema.optional(TrimmedNonEmptyString),
  title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(12000)),
  reviewRequired: Schema.optional(Schema.Boolean),
});
export type T3poWorkRoute = typeof T3poWorkRoute.Type;
export const T3poWorkReceipt = Schema.Struct({
  id: Schema.String,
  jobId: Schema.String,
  workstreamId: Schema.String,
  state: Schema.Literals(["queued", "sent", "blocked"]),
  reason: Schema.String,
});
export type T3poWorkReceipt = typeof T3poWorkReceipt.Type;
const TaskIntentFields = {
  origin: Schema.optional(Schema.Struct({ threadId: ThreadId, messageId: MessageId })),
  desiredOutcome: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(12000))),
  completionPolicy: Schema.optional(Schema.Literal("human_review")),
};
export const T3poTask = Schema.Struct({
  ...TaskIntentFields,
  briefRevision: Schema.optional(NonNegativeInt),
  workstreamId: Schema.optional(TrimmedNonEmptyString),
  reviewRequired: Schema.optional(Schema.Boolean),
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
  briefRevision: Schema.optional(Schema.NullOr(NonNegativeInt)),
  reportDeliveredAt: Schema.optional(Schema.NullOr(Schema.String)),
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
  dispatch: Schema.optional(T3poWorkReceipt),
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
export const T3poSpace = Schema.Struct({
  rules: Schema.optional(Schema.String.check(Schema.isMaxLength(12000))),
  id: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
});
export type T3poSpace = typeof T3poSpace.Type;
export const T3poSpaceConnection = Schema.Struct({
  sourceSpaceId: TrimmedNonEmptyString,
  targetSpaceId: TrimmedNonEmptyString,
  targetProjectId: ProjectId,
});
export const T3poSharedResource = Schema.Struct({
  id: TrimmedNonEmptyString,
  ownerSpaceId: TrimmedNonEmptyString,
  targetSpaceId: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  location: TrimmedNonEmptyString.check(Schema.isMaxLength(2000)),
});
export const T3poProjectSpace = Schema.Struct({
  projectId: ProjectId,
  spaceId: TrimmedNonEmptyString,
});
export const T3poConversation = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  channelId: TrimmedNonEmptyString,
});
export const T3poSnapshot = Schema.Struct({
  spaceConnections: Schema.optional(Schema.Array(T3poSpaceConnection)),
  sharedResources: Schema.optional(Schema.Array(T3poSharedResource)),
  spaces: Schema.optional(Schema.Array(T3poSpace)),
  projectSpaces: Schema.optional(Schema.Array(T3poProjectSpace)),
  conversations: Schema.optional(Schema.Array(T3poConversation)),
  workstreams: Schema.optional(Schema.Array(T3poWorkstream)),
  memory: Schema.Array(T3poMemoryStatus),
  nextCursor: Schema.NullOr(NonNegativeInt),
  leads: Schema.Array(T3poLead),
  channels: Schema.Array(T3poChannel),
  tasks: Schema.Array(T3poTaskView),
});
export const T3poMutation = Schema.Union([
  T3poMemoryControl,
  Schema.Struct({
    type: Schema.Literal("save_space_rules"),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
    rules: Schema.String.check(Schema.isMaxLength(12000)),
  }),
  Schema.Struct({
    type: Schema.Literal("connect_space"),
    projectId: ProjectId,
    ...T3poSpaceConnection.fields,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    type: Schema.Literal("share_resource"),
    projectId: ProjectId,
    ...T3poSharedResource.fields,
  }),
  Schema.Struct({
    type: Schema.Literal("unshare_resource"),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
  }),
  Schema.Struct({ type: Schema.Literal("save_space"), projectId: ProjectId, ...T3poSpace.fields }),
  Schema.Struct({
    type: Schema.Literal("remove_space"),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("assign_space"),
    projectId: ProjectId,
    spaceId: Schema.NullOr(TrimmedNonEmptyString),
  }),
  Schema.Struct({
    type: Schema.Literal("move_conversation"),
    projectId: ProjectId,
    threadId: ThreadId,
    channelId: Schema.NullOr(TrimmedNonEmptyString),
    newChannelName: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
  }),
  Schema.Struct({
    type: Schema.Literal("move_job"),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
    workstreamId: TrimmedNonEmptyString,
  }),
  Schema.Struct({
    type: Schema.Literal("save_workstream"),
    ...T3poWorkstream.fields,
  }),
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
    ...TaskIntentFields,
    workspace: Schema.optional(T3poWorkspace),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
    channelId: Schema.NullOr(TrimmedNonEmptyString),
    title: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    brief: TrimmedNonEmptyString.check(Schema.isMaxLength(12000)),
  }),
  Schema.Struct({
    type: Schema.Literal("edit_task"),
    desiredOutcome: TaskIntentFields.desiredOutcome,
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
    "space_busy",
    "space_nonempty",
    "space_boundary",
    "workspace",
    "budget",
    "approval",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    if (this.operation === "space_busy")
      return "Wait for active runs and background agents on this computer to finish before changing a project’s Space.";
    if (this.operation === "space_nonempty")
      return "Move all projects, including archived projects, out of this Space before removing it.";
    if (this.operation === "space_boundary")
      return "No active Space connection authorizes this operation.";
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
