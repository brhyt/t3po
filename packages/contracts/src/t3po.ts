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
  /** Only the job that runs in this thread, archived or not. */
  threadId: Schema.optional(ThreadId),
  view: Schema.optional(
    Schema.Literals(["all", "open", "active", "up_next", "completed", "archived", "outputs"]),
  ),
  before: Schema.optional(NonNegativeInt),
  metadataOnly: Schema.optional(Schema.Boolean),
});
export type T3poQuery = typeof T3poQuery.Type;

/** Jobs a project runs at once when no limit is saved. */
export const T3PO_DEFAULT_CONCURRENT_JOBS = 3;
/** Jobs run until done without waiting on approvals; supervise a single job from the Work panel. */
export const T3PO_DEFAULT_WORK_ACCESS = "full-access" as const;
/** A project's long-lived lead or channel conversation, as opposed to a job. */
export const isT3poLeadConversation = (threadId: string) =>
  threadId.startsWith("t3po-lead:") || threadId.startsWith("t3po-channel:");
/** Lead conversations compact this early so a long one stays cheap to resume. */
export const T3PO_LEAD_AUTO_COMPACT_WINDOW = 300_000;

const T3poBudget = Schema.Struct({
  /** No longer enforced; jobs run until they finish. Kept for older clients. */
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
  /** The name is a placeholder; the lead names itself after a few conversation turns. */
  autoName: Schema.optional(Schema.Boolean),
  /** Model for jobs the lead and its channels hand off. Unset: the handing-off chat's model. */
  workModel: Schema.optional(ModelSelection),
  /** Most permissive mode jobs, and agents a lead or job starts, may run in. Unset: T3PO_DEFAULT_WORK_ACCESS. */
  workAccess: Schema.optional(RuntimeMode),
  /** The lead was asked to draw the project's icon; cleared to ask again. */
  iconRequested: Schema.optional(Schema.Boolean),
  /** The run whose prompt carried the icon request; re-asked if it never reached the provider. */
  iconRequestRunId: Schema.optional(RunId),
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
/** Longest working record one lead or channel conversation keeps. */
export const T3PO_NOTES_MAX_LENGTH = 8000;
const T3poNotesText = Schema.String.check(Schema.isMaxLength(T3PO_NOTES_MAX_LENGTH));
/** A conversation's working record: decisions, open questions, preferences and key facts. */
export const T3poNotes = Schema.Struct({
  projectId: ProjectId,
  /** Null: the project's lead chat. */
  channelId: Schema.NullOr(TrimmedNonEmptyString),
  text: T3poNotesText,
  revision: NonNegativeInt,
  updatedAt: Schema.String,
  updatedBy: Schema.Literals(["lead", "user"]),
});
export type T3poNotes = typeof T3poNotes.Type;
/** Exactly one of `text` (replace) or `edits` (patch the current notes). */
export const T3poNotesUpdate = Schema.Struct({
  text: Schema.optional(T3poNotesText),
  /** Required with `text`: the revision the replacement is based on (0 before any notes). */
  expectedRevision: Schema.optional(NonNegativeInt),
  edits: Schema.optional(
    Schema.Array(
      Schema.Struct({
        oldText: Schema.String.check(Schema.isMinLength(1)),
        newText: Schema.String,
      }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
  ),
});
export type T3poNotesUpdate = typeof T3poNotesUpdate.Type;
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
export const T3poProjectIconInput = Schema.Struct({
  svg: TrimmedNonEmptyString.check(Schema.isMaxLength(8192)),
});
export type T3poProjectIconInput = typeof T3poProjectIconInput.Type;
export const T3poProjectIconResult = Schema.Struct({ projectId: ProjectId });
export type T3poProjectIconResult = typeof T3poProjectIconResult.Type;
const TaskIntentFields = {
  origin: Schema.optional(Schema.Struct({ threadId: ThreadId, messageId: MessageId })),
  desiredOutcome: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(12000))),
  completionPolicy: Schema.optional(Schema.Literal("human_review")),
};
const T3poJobGrant = Schema.Struct({
  version: NonNegativeInt,
  briefRevision: NonNegativeInt,
  spaceId: Schema.NullOr(Schema.String),
  workspace: T3poWorkspace,
  route: Schema.Literal("local"),
  workspaceRoot: Schema.NullOr(Schema.String),
  expiresAt: Schema.String,
  revoked: Schema.Boolean,
  maxRuns: NonNegativeInt,
  maxConcurrent: NonNegativeInt,
});
export const T3poTask = Schema.Struct({
  grant: Schema.optional(T3poJobGrant),
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
  action: Schema.Literals([
    "refresh",
    "pause",
    "resume",
    "retry",
    "stop_delivery",
    "resume_delivery",
    "release_backlog",
  ]),
  expectedDeliveryRevision: Schema.optional(NonNegativeInt),
  expectedHeldRecords: Schema.optional(NonNegativeInt),
});
export type T3poMemoryControl = typeof T3poMemoryControl.Type;
export const T3poMemoryStatus = Schema.Struct({
  projectId: ProjectId,
  configured: Schema.Boolean,
  processing: Schema.optional(T3poMemoryProcessing),
  delivery: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      environmentAllowed: Schema.Boolean,
      held: NonNegativeInt,
      revision: NonNegativeInt,
    }),
  ),
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
/** Tools a space can turn on or off; `spaceId` null is every project in no space. */
export const T3poSpaceToolName = Schema.Literals(["browser", "device"]);
export type T3poSpaceToolName = typeof T3poSpaceToolName.Type;
export const T3poSpaceTool = Schema.Struct({
  spaceId: Schema.NullOr(TrimmedNonEmptyString),
  tool: T3poSpaceToolName,
  enabled: Schema.Boolean,
});
export type T3poSpaceTool = typeof T3poSpaceTool.Type;
export const T3poProjectSpace = Schema.Struct({
  projectId: ProjectId,
  spaceId: TrimmedNonEmptyString,
});
export const T3poConversation = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  channelId: TrimmedNonEmptyString,
});
export const T3poExternalBinding = Schema.Struct({
  projectId: ProjectId,
  version: NonNegativeInt,
  accountId: TrimmedNonEmptyString,
  host: Schema.Literal("github.com"),
  repository: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export const T3poSnapshot = Schema.Struct({
  externalBindings: Schema.optional(Schema.Array(T3poExternalBinding)),
  spaceConnections: Schema.optional(Schema.Array(T3poSpaceConnection)),
  sharedResources: Schema.optional(Schema.Array(T3poSharedResource)),
  spaceTools: Schema.optional(Schema.Array(T3poSpaceTool)),
  spaces: Schema.optional(Schema.Array(T3poSpace)),
  projectSpaces: Schema.optional(Schema.Array(T3poProjectSpace)),
  conversations: Schema.optional(Schema.Array(T3poConversation)),
  workstreams: Schema.optional(Schema.Array(T3poWorkstream)),
  notes: Schema.optional(Schema.Array(T3poNotes)),
  memory: Schema.Array(T3poMemoryStatus),
  nextCursor: Schema.NullOr(NonNegativeInt),
  leads: Schema.Array(T3poLead),
  channels: Schema.Array(T3poChannel),
  tasks: Schema.Array(T3poTaskView),
});
export const T3poMutation = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("save_external_binding"),
    projectId: ProjectId,
    expectedVersion: NonNegativeInt,
    accountId: TrimmedNonEmptyString,
    host: Schema.Literal("github.com"),
    repository: TrimmedNonEmptyString,
    enabled: Schema.Boolean,
  }),
  T3poMemoryControl,
  Schema.Struct({
    type: Schema.Literal("save_job_grant"),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
    briefRevision: NonNegativeInt,
    expectedVersion: NonNegativeInt,
    expiresAt: Schema.String,
    maxRuns: Schema.optional(NonNegativeInt),
    maxConcurrent: Schema.optional(NonNegativeInt),
  }),
  Schema.Struct({
    type: Schema.Literal("revoke_job_grant"),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
    expectedVersion: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("save_space_rules"),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
    rules: Schema.String.check(Schema.isMaxLength(12000)),
  }),
  Schema.Struct({
    type: Schema.Literal("set_space_tool"),
    projectId: ProjectId,
    spaceId: Schema.NullOr(TrimmedNonEmptyString),
    tool: T3poSpaceToolName,
    /** Null follows the default in Settings → Tools. */
    enabled: Schema.NullOr(Schema.Boolean),
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
  /**
   * Moves an ordinary conversation from `projectId` to another project on this machine, or to
   * its No project. Only the user interface sends this, so it may cross Spaces.
   */
  Schema.Struct({
    type: Schema.Literal("move_conversation_project"),
    projectId: ProjectId,
    threadId: ThreadId,
    targetProjectId: ProjectId,
  }),
  Schema.Struct({
    type: Schema.Literal("save_notes"),
    projectId: ProjectId,
    channelId: Schema.NullOr(TrimmedNonEmptyString),
    text: T3poNotesText,
    /** Revision the edit started from; a newer save fails with notes_stale. */
    expectedRevision: NonNegativeInt,
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
    /** Ignored; jobs are limited only by how many run at once. */
    maxRuns: Schema.optional(NonNegativeInt),
    maxConcurrent: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("save_work_model"),
    projectId: ProjectId,
    /** Null: jobs use the model of the chat that hands them off. */
    modelSelection: Schema.NullOr(ModelSelection),
  }),
  Schema.Struct({
    type: Schema.Literal("save_work_access"),
    projectId: ProjectId,
    runtimeMode: RuntimeMode,
  }),
  /** Asks the lead to draw a new project icon on its next turn. */
  Schema.Struct({ type: Schema.Literal("redraw_project_icon"), projectId: ProjectId }),
  Schema.Struct({
    type: Schema.Literal("save_lead"),
    projectId: ProjectId,
    /** Omitted: the lead keeps or gets a placeholder name and names itself later. */
    name: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
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
    /** Jobs, workstreams and conversations move back to the project; the channel chat is deleted. */
    type: Schema.Literal("delete_channel"),
    projectId: ProjectId,
    id: TrimmedNonEmptyString,
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
    "conversation_busy",
    "space_busy",
    "channel_busy",
    "space_nonempty",
    "space_boundary",
    "workspace",
    "budget",
    "approval",
    "notes_stale",
    "grant_invalid",
    "grant_stale",
    "grant_revoked",
    "grant_expired",
    "grant_exhausted",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    if (this.operation === "grant_invalid")
      return "The job grant or its execution binding is unavailable or invalid.";
    if (this.operation === "grant_stale")
      return "The job grant changed. Review the current brief and grant before starting again.";
    if (this.operation === "grant_revoked") return "This job grant has been revoked.";
    if (this.operation === "grant_expired")
      return "This job grant has expired. Review and renew it before starting again.";
    if (this.operation === "grant_exhausted")
      return "This job grant has reached its run or concurrency limit.";
    if (this.operation === "space_busy")
      return "Wait for active runs and background agents on this computer to finish before changing a project’s Space.";
    if (this.operation === "channel_busy")
      return "Wait for the work running in this channel to finish before deleting it.";
    if (this.operation === "space_nonempty")
      return "Move all projects, including archived projects, out of this Space before removing it.";
    if (this.operation === "space_boundary")
      return "No active Space connection authorizes this operation.";
    if (this.operation === "budget")
      return "Every agent slot in this project is in use or set to zero. Wait for a job to finish or raise how many run at once.";
    if (this.operation === "approval")
      return "This project's job permissions don't allow that mode. Change Job permissions in the Work panel.";
    if (this.operation === "notes_stale")
      return "These notes changed while you were editing. Review the latest notes and save again.";
    if (this.operation === "busy") return "Stop the running task before archiving it.";
    if (this.operation === "conversation_busy")
      return "This conversation is still working. Wait for it and its background agents to finish, or stop them, before moving it to another project.";
    if (this.operation === "workspace")
      return "Choose an existing Git base branch for the worktree, or use the project folder.";
    return this.operation === "invalid"
      ? "This project, channel or task is unavailable, or the task is not ready for review."
      : `Could not ${this.operation} project work. Try again; existing work is preserved.`;
  }
}

export const isT3poError = Schema.is(T3poError);
