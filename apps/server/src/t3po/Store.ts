import * as ExternalActionStore from "./ExternalActionStore.ts";
import * as Authority from "./Authority.ts";
import { finalAnswers } from "./Result.ts";
import * as Changes from "./Changes.ts";
import * as ScheduledTurn from "./ScheduledTurn.ts";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as MemoryBridge from "./MemoryBridge.ts";
import {
  T3poSpace,
  T3poExternalBinding,
  T3poSharedResource,
  type T3poSpaceTool,
  T3poSpaceConnection,
  T3poProjectSpace,
  T3poConversation,
  ProjectId,
  type T3poMemoryStatus,
  type T3poMemoryControl,
  T3poResult,
  type T3poResultsQuery,
  type T3poResultsPage,
  type RunId,
  type ScheduledTaskId,
  ThreadId,
  MessageId,
  T3poLead,
  T3poWorkstream,
  type T3poNotes,
  type T3poNotesUpdate,
  T3PO_NOTES_MAX_LENGTH,
  type T3poWorkReceipt,
  T3poChannel,
  T3poTask,
  T3poError,
  isT3poError,
  type T3poMutation,
  T3poLaunchInput,
  type T3poQuery,
  type T3poWorkspace,
  OrchestrationV2ThreadLaunchWorkspaceStrategy,
  T3PO_DEFAULT_CONCURRENT_JOBS,
  T3PO_DEFAULT_WORK_ACCESS,
  isT3poLeadConversation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const decodeWorkstream = Schema.decodeEffect(Schema.fromJsonString(T3poWorkstream));
const decodeT3poLeadJson = Schema.decodeEffect(Schema.fromJsonString(T3poLead));
const decodeT3poChannelJson = Schema.decodeEffect(Schema.fromJsonString(T3poChannel));
const decodeT3poTaskJson = Schema.decodeEffect(Schema.fromJsonString(T3poTask));
const encodeT3poLeadJson = Schema.encodeEffect(Schema.fromJsonString(T3poLead));
const encodeT3poChannelJson = Schema.encodeEffect(Schema.fromJsonString(T3poChannel));
const encodeT3poTaskJson = Schema.encodeEffect(Schema.fromJsonString(T3poTask));
/** Stored name of a lead that has not named itself yet; clients show their own label for it. */
const T3PO_LEAD_PLACEHOLDER_NAME = "Lead";
const LaunchReservation = Schema.Struct({
  ...T3poLaunchInput.fields,
  briefRevision: Schema.optional(Schema.Number),
  messageId: Schema.optional(MessageId),
  title: Schema.optional(Schema.String),
  brief: Schema.optional(Schema.String),
  workspaceStrategy: Schema.optional(OrchestrationV2ThreadLaunchWorkspaceStrategy),
});
const encodeT3poLaunchInputJson = Schema.encodeEffect(Schema.fromJsonString(LaunchReservation));
const decodeT3poLaunchInputJson = Schema.decodeEffect(Schema.fromJsonString(LaunchReservation));
type TaskRecord = T3poTask & {
  readonly workspaceLocked: boolean;
  readonly dispatch?: T3poWorkReceipt;
};
type Page = {
  externalBindings: readonly (typeof T3poExternalBinding.Type)[];
  spaceConnections: readonly (typeof T3poSpaceConnection.Type)[];
  sharedResources: readonly (typeof T3poSharedResource.Type)[];
  spaceTools: readonly T3poSpaceTool[];
  spaces: readonly T3poSpace[];
  projectSpaces: readonly (typeof T3poProjectSpace.Type)[];
  conversations: readonly (typeof T3poConversation.Type)[];
  workstreams: readonly T3poWorkstream[];
  notes: readonly T3poNotes[];
  memory: readonly (typeof T3poMemoryStatus.Type)[];
  leads: readonly T3poLead[];
  channels: readonly (typeof T3poChannel.Type)[];
  tasks: readonly TaskRecord[];
  nextCursor: number | null;
};
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
type NotesRow = Omit<T3poNotes, "projectId"> & {
  readonly projectId: string;
  readonly memoryEventId: string | null;
};
type NotesWrite = T3poNotesUpdate & {
  readonly projectId: ProjectId;
  readonly channelId: string | null;
  readonly updatedBy: T3poNotes["updatedBy"];
  readonly expectedRevision?: number;
};
const notesThread = (projectId: ProjectId, channelId: string | null) =>
  channelId === null ? `t3po-lead:${projectId}` : `t3po-channel:${channelId}`;
const toNotes = ({ memoryEventId: _event, ...row }: NotesRow): T3poNotes => ({
  ...row,
  projectId: ProjectId.make(row.projectId),
});
/** Replaces the one place each oldText appears; null when one is missing or ambiguous. */
const applyNotesEdits = (
  text: string,
  edits: NonNullable<T3poNotesUpdate["edits"]>,
): string | null => {
  let next = text;
  for (const edit of edits) {
    const at = next.indexOf(edit.oldText);
    if (at === -1 || next.includes(edit.oldText, at + 1)) return null;
    next = next.slice(0, at) + edit.newText + next.slice(at + edit.oldText.length);
  }
  return next;
};
const decodeResults = Schema.decodeEffect(Schema.Array(T3poResult));

export class Store extends Context.Service<
  Store,
  {
    readonly proposalEnabled: (threadId: ThreadId) => Effect.Effect<boolean, T3poError>;
    readonly memoryDeliveryLock: Effect.Effect<Semaphore.Semaphore>;
    readonly runMemoryWorker: Effect.Effect<never>;
    /** The stable project block, plus this message's memory recall; both are "" when absent. */
    readonly context: (
      projectId: ProjectId,
      threadId: ThreadId,
      query?: string,
      runId?: RunId,
    ) => Effect.Effect<{ readonly context: string; readonly recall: string }, T3poError>;
    /**
     * Whether a lead or channel turn must resend `context`: its provider has not seen this block
     * since its session started, last compacted, or the block changed. Records the send.
     */
    readonly claimContextDelivery: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly providerThreadId: string;
      readonly context: string;
    }) => Effect.Effect<boolean, T3poError>;
    readonly read: Effect.Effect<Page, T3poError>;
    readonly notes: (
      projectId: ProjectId,
      channelId: string | null,
    ) => Effect.Effect<T3poNotes | null, T3poError>;
    readonly saveNotes: (input: NotesWrite) => Effect.Effect<T3poNotes, T3poError>;
    readonly list: (input: T3poQuery) => Effect.Effect<Page, T3poError>;
    readonly results: (
      input: T3poResultsQuery,
      pageSize?: 1 | 10,
    ) => Effect.Effect<T3poResultsPage, T3poError>;
    readonly checkStart: (
      threadId: string,
      runId: string,
      binding?: {
        readonly cwd: string;
        readonly worktreePath: string | null;
        readonly branch: string | null;
      },
    ) => Effect.Effect<void, T3poError>;
    readonly getTask: (id: string, projectId: ProjectId) => Effect.Effect<TaskRecord, T3poError>;
    readonly getTaskProject: (threadId: ThreadId) => Effect.Effect<ProjectId | null, T3poError>;
    readonly scheduledTurnNote: (taskId: ScheduledTaskId) => Effect.Effect<string, T3poError>;
    readonly controlMemory: (input: T3poMemoryControl) => Effect.Effect<void, T3poError>;
    readonly mutate: (input: T3poMutation, reviewedRunId?: RunId) => Effect.Effect<void, T3poError>;
    /** Marks the lead as asked to draw the project icon; true only for the call that marked it. */
    readonly requestProjectIcon: (
      projectId: ProjectId,
      runId: RunId,
    ) => Effect.Effect<boolean, T3poError>;
    readonly reserveLaunch: (
      taskId: string,
      projectId: ProjectId,
      input: typeof LaunchReservation.Type,
      expectedWorkspace?: T3poWorkspace,
    ) => Effect.Effect<typeof LaunchReservation.Type, T3poError>;
  }
>()("t3/t3po/Store") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const memory = yield* MemoryBridge.MemoryBridge;
  const changes = yield* Changes.Changes;
  const sends = yield* Semaphore.make(1);
  const wake = yield* Queue.make<void>({ capacity: 1, strategy: "dropping" });
  const notesColumns = sql`project_id AS projectId, channel_id AS channelId, text, revision, updated_at AS updatedAt, updated_by AS updatedBy, memory_event_id AS memoryEventId`;
  // Persist holds before any worker can send records captured while exchange was disabled.
  const queuedProjects = yield* sql<{
    projectId: string;
  }>`SELECT DISTINCT project_id AS projectId FROM t3po_memory_events_v2 WHERE synced_at IS NULL`;
  for (const row of queuedProjects) {
    if (!memory.exchangeAllowed(row.projectId))
      yield* sql`UPDATE t3po_memory_events_v2 SET delivery_held = 1 WHERE project_id = ${row.projectId} AND synced_at IS NULL`;
  }
  // Only projects in a space are remembered; the others are off the record and never sent.
  const inSpace = (projectId: string) =>
    sql`EXISTS (SELECT 1 FROM t3po_project_spaces ps JOIN t3po_spaces sp ON sp.id = ps.space_id WHERE ps.project_id = ${projectId})`;
  const remembered = (projectId: string) =>
    sql<{ inSpace: number }>`SELECT ${inSpace(projectId)} AS inSpace`.pipe(
      Effect.map((rows) => rows[0]?.inSpace === 1),
    );
  const exchangeMemory = Effect.fn("T3poStore.exchangeMemory")(function* (
    projectId: ProjectId,
    query: string,
    background = false,
  ) {
    const policies = yield* sql<{
      enabled: number;
    }>`SELECT enabled FROM t3po_memory_delivery_policy WHERE project_id = ${projectId}`;
    if (
      policies[0]?.enabled === 0 ||
      !memory.exchangeAllowed(projectId) ||
      !(yield* remembered(projectId))
    )
      return { acceptedIds: [], context: "", available: false };
    const pending =
      yield* sql<MemoryBridge.MemoryEvent>`SELECT event_id AS id, kind, text, occurred_at AS occurredAt FROM t3po_memory_events_v2 WHERE project_id = ${projectId} AND synced_at IS NULL AND superseded_by IS NULL AND kind != 'local_correction' AND delivery_held = 0 ORDER BY sequence LIMIT 20`;
    const status = yield* sql<{
      failures: number;
      nextAttempt: number;
    }>`SELECT failures, next_attempt AS nextAttempt FROM t3po_memory_status WHERE project_id = ${projectId}`;
    const started = DateTime.toEpochMillis(yield* DateTime.now);
    const eligible = (status[0]?.nextAttempt ?? 0) <= started;
    if (background && (!pending.length || !eligible)) return null;
    const sent = eligible ? pending : [];
    const result = yield* memory.exchange({ projectId, query, events: sent });
    const ids = new Set(sent.map((event) => event.id));
    const accepted = [...new Set(result.acceptedIds.filter((id) => ids.has(id)))];
    const now = yield* DateTime.now;
    const stamp = DateTime.formatIso(now);
    const complete = sent.length > 0 && accepted.length === sent.length;
    const failures = sent.length
      ? complete
        ? 0
        : Math.min(7, (status[0]?.failures ?? 0) + 1)
      : (status[0]?.failures ?? 0);
    const nextAttempt = sent.length
      ? DateTime.toEpochMillis(now) + (complete ? 1000 : Math.min(60000, 1000 * 2 ** failures))
      : (status[0]?.nextAttempt ?? 0);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        if (accepted.length)
          yield* sql`UPDATE t3po_memory_events_v2 SET synced_at = ${stamp} WHERE project_id = ${projectId} AND synced_at IS NULL AND event_id IN ${sql.in(accepted)}`;
        yield* sql`INSERT INTO t3po_memory_status (project_id, last_sync_at, available, failures, next_attempt) VALUES (${projectId}, ${stamp}, ${result.available ? 1 : 0}, ${failures}, ${nextAttempt}) ON CONFLICT(project_id) DO UPDATE SET last_sync_at = excluded.last_sync_at, available = CASE WHEN ${background ? 1 : 0} THEN t3po_memory_status.available ELSE excluded.available END, failures = excluded.failures, next_attempt = excluded.next_attempt`;
      }),
    );
    yield* PubSub.publish(changes, { projectId, metadata: true });
    yield* Queue.offer(wake, undefined);
    return result;
  }, sends.withPermit);
  const memoryStep = Effect.fn("T3poStore.memoryStep")(function* () {
    const rows = yield* sql<{
      projectId: string;
      nextAttempt: number;
    }>`SELECT e.project_id AS projectId, COALESCE(s.next_attempt, 0) AS nextAttempt FROM t3po_memory_events_v2 e LEFT JOIN t3po_memory_status s ON s.project_id = e.project_id WHERE e.synced_at IS NULL AND e.superseded_by IS NULL AND e.kind != 'local_correction' AND e.delivery_held = 0 AND NOT EXISTS (SELECT 1 FROM t3po_memory_delivery_policy p WHERE p.project_id = e.project_id AND p.enabled = 0) AND EXISTS (SELECT 1 FROM t3po_project_spaces ps JOIN t3po_spaces sp ON sp.id = ps.space_id WHERE ps.project_id = e.project_id) GROUP BY e.project_id ORDER BY nextAttempt, e.project_id LIMIT 1`;
    const row = rows[0];
    if (!row) {
      yield* Queue.take(wake);
      return;
    }
    const delay = row.nextAttempt - DateTime.toEpochMillis(yield* DateTime.now);
    if (delay > 0) {
      yield* Queue.take(wake).pipe(
        Effect.timeoutOrElse({ duration: delay, orElse: () => Effect.void }),
      );
      return;
    }
    yield* exchangeMemory(ProjectId.make(row.projectId), "", true);
  });
  const runMemoryWorker = memory.configured
    ? memoryStep().pipe(
        Effect.catch(() => Effect.sleep("5 seconds")),
        Effect.forever,
      )
    : Effect.never;
  const enqueueMemory = Effect.fn("T3poStore.enqueueMemory")(function* (
    projectId: ProjectId,
    kind: MemoryBridge.MemoryEvent["kind"],
    text: string,
  ) {
    // Off the record: nothing about this project is journaled for memory.
    if (!(yield* remembered(projectId))) return null;
    const now = DateTime.formatIso(yield* DateTime.now);
    const rows = yield* sql<{
      id: string;
    }>`INSERT INTO t3po_memory_events_v2 (event_id, project_id, kind, text, occurred_at, delivery_held) VALUES (lower(hex(randomblob(16))), ${projectId}, ${kind}, ${text.slice(0, 12000)}, ${now}, CASE WHEN ${memory.exchangeAllowed(projectId) ? 1 : 0} = 0 OR EXISTS (SELECT 1 FROM t3po_memory_delivery_policy WHERE project_id = ${projectId} AND enabled = 0) THEN 1 ELSE 0 END) RETURNING event_id AS id`;
    return rows[0]!.id;
  });
  const getTask = Effect.fn("T3poStore.getTask")(
    function* (id: string, projectId: ProjectId) {
      const rows = yield* sql<{
        data: string;
        launch: string | null;
      }>`SELECT data, launch FROM t3po_tasks WHERE id = ${id} AND project_id = ${projectId}`;
      if (!rows[0]) return yield* new T3poError({ operation: "invalid" });
      return {
        ...(yield* decodeT3poTaskJson(rows[0].data)),
        workspaceLocked: rows[0].launch !== null,
      };
    },
    Effect.mapError((cause) =>
      isT3poError(cause) ? cause : new T3poError({ operation: "read", cause }),
    ),
  );
  const getTaskProject = Effect.fn("T3poStore.getTaskProject")(
    function* (threadId: ThreadId) {
      const rows = yield* sql<{
        project_id: string;
      }>`SELECT project_id FROM t3po_tasks WHERE json_extract(data, '$.threadId') = ${threadId} UNION SELECT project_id FROM t3po_leads WHERE json_extract(data, '$.threadId') = ${threadId} UNION SELECT project_id FROM t3po_channels WHERE 't3po-channel:' || id = ${threadId} LIMIT 1`;
      return rows[0] ? ProjectId.make(rows[0].project_id) : null;
    },
    Effect.mapError((cause) => new T3poError({ operation: "read", cause })),
  );
  const results = Effect.fn("T3poStore.results")(
    function* (input: T3poResultsQuery, pageSize: 1 | 10 = 10) {
      const task = yield* getTask(input.taskId, input.projectId);
      const rows = yield* sql<{
        runId: string;
        runOrdinal: number;
        messageId: string;
        completedAt: string;
        checkpointId: string | null;
        text: string;
        textLength: number;
        briefRevision: number | null;
        reportDeliveredAt: string | null;
      }>`WITH answers AS (${finalAnswers(sql, task.threadId)}), history AS (
        SELECT e.run_id AS runId, json_extract(e.result_json, '$.runOrdinal') AS runOrdinal,
          json_extract(e.result_json, '$.messageId') AS messageId,
          json_extract(e.result_json, '$.completedAt') AS completedAt,
          json_extract(e.result_json, '$.checkpointId') AS checkpointId,
          json_extract(e.result_json, '$.text') AS text,
          e.revision AS briefRevision, e.delivered_at AS reportDeliveredAt
        FROM t3po_task_executions e WHERE e.task_id = ${task.id}
          AND json_extract(e.result_json, '$.status') = 'completed'
          AND json_extract(e.result_json, '$.messageId') IS NOT NULL
          AND json_extract(e.result_json, '$.runOrdinal') IS NOT NULL
        UNION ALL
        SELECT r.run_id, r.ordinal, a.message_id, r.completed_at,
          json_extract(r.payload_json, '$.checkpointId'), a.text, e.revision, e.delivered_at
        FROM orchestration_v2_projection_runs r
        JOIN answers a ON a.run_id = r.run_id AND a.thread_id = r.thread_id AND a.rank = 1
        LEFT JOIN t3po_task_executions e ON e.run_id = r.run_id
        WHERE r.thread_id = ${task.threadId} AND r.status = 'completed' AND r.completed_at IS NOT NULL
          AND (e.result_json IS NULL OR json_extract(e.result_json, '$.runOrdinal') IS NULL)
      ) SELECT runId, runOrdinal, messageId, completedAt, checkpointId,
        substr(text, 1, 12000) AS text, length(text) AS textLength, briefRevision, reportDeliveredAt
        FROM history WHERE 1 = 1 ${input.before === undefined ? sql`` : sql`AND runOrdinal < ${input.before}`}
        ORDER BY runOrdinal DESC LIMIT ${pageSize + 1}`;
      return {
        results: yield* decodeResults(
          rows
            .slice(0, pageSize)
            .map(({ textLength, ...result }) => ({ ...result, truncated: textLength > 12000 })),
        ),
        nextCursor: rows.length > pageSize ? rows[pageSize - 1]!.runOrdinal : null,
      };
    },
    Effect.mapError((cause) =>
      isT3poError(cause) ? cause : new T3poError({ operation: "read", cause }),
    ),
  );
  const list = Effect.fn("T3poStore.list")(
    function* (input: T3poQuery) {
      const projectFilter = input.projectId ? sql`project_id = ${input.projectId}` : sql`1 = 1`;
      const leads = yield* sql<{
        data: string;
      }>`SELECT data FROM t3po_leads WHERE ${projectFilter}`;
      const workstreams = yield* sql<{
        data: string;
      }>`SELECT data FROM t3po_workstreams WHERE ${projectFilter} AND ${input.channelId ? sql`channel_id = ${input.channelId}` : sql`1 = 1`} ORDER BY rowid DESC LIMIT 100`;
      const channels = yield* sql<{
        data: string;
      }>`SELECT data FROM t3po_channels WHERE ${projectFilter} ORDER BY rowid`;
      const notes = input.projectId
        ? yield* sql<NotesRow>`SELECT ${notesColumns} FROM t3po_notes WHERE project_id = ${input.projectId} AND ${input.channelId ? sql`channel_id = ${input.channelId}` : sql`1 = 1`} ORDER BY rowid LIMIT 100`
        : [];
      const filters = [projectFilter];
      if (input.threadId) filters.push(sql`json_extract(data, '$.threadId') = ${input.threadId}`);
      else
        filters.push(
          sql`COALESCE(json_extract(data, '$.archived'), 0) = ${input.view === "archived" ? 1 : 0}`,
        );
      if (
        !input.threadId &&
        input.view !== "archived" &&
        input.view !== "outputs" &&
        input.view !== "all"
      )
        filters.push(
          sql`json_extract(data, '$.completed') = ${input.view === "completed" ? 1 : 0}`,
        );
      if (
        !input.threadId &&
        (input.view === "active" || input.view === "up_next" || input.view === "outputs")
      ) {
        const exists = sql`EXISTS (SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = json_extract(t3po_tasks.data, '$.threadId'))`;
        filters.push(input.view === "up_next" ? sql`NOT ${exists}` : exists);
      }
      if (input.channelId)
        filters.push(sql`json_extract(data, '$.channelId') = ${input.channelId}`);
      if (input.before !== undefined) filters.push(sql`rowid < ${input.before}`);
      const tasks = input.metadataOnly
        ? []
        : yield* sql<{
            data: string;
            launch: string | null;
            cursor: number;
          }>`SELECT data, launch, rowid AS cursor FROM t3po_tasks WHERE ${sql.and(filters)} ORDER BY rowid DESC LIMIT 51`;
      const memoryRows = yield* sql<{
        projectId: string;
        pending: number;
        held: number;
        deliveryEnabled: number;
        deliveryRevision: number;
        available: number | null;
        lastCheckedAt: string | null;
      }>`SELECT l.project_id AS projectId, s.available, s.last_sync_at AS lastCheckedAt, COALESCE(p.enabled, 1) AS deliveryEnabled, COALESCE(p.revision, 0) AS deliveryRevision, (SELECT count(*) FROM t3po_memory_events_v2 e WHERE e.project_id = l.project_id AND e.synced_at IS NULL AND e.superseded_by IS NULL AND e.kind != 'local_correction' AND e.delivery_held = 1) AS held, (SELECT count(*) FROM t3po_memory_events_v2 e WHERE e.project_id = l.project_id AND e.synced_at IS NULL AND e.superseded_by IS NULL AND e.kind != 'local_correction') AS pending FROM t3po_leads l LEFT JOIN t3po_memory_status s ON s.project_id = l.project_id LEFT JOIN t3po_memory_delivery_policy p ON p.project_id = l.project_id WHERE ${input.projectId ? sql`l.project_id = ${input.projectId}` : sql`1 = 1`}`;
      const processing = yield* memory.statuses;
      return {
        externalBindings: (yield* sql<{
          projectId: string;
          version: number;
          accountId: string;
          host: "github.com";
          repository: string;
          enabled: number;
        }>`SELECT project_id AS projectId, version, account_id AS accountId, host, repository, enabled FROM t3po_external_bindings WHERE ${projectFilter}`).map(
          (row) => ({
            ...row,
            projectId: ProjectId.make(row.projectId),
            enabled: row.enabled === 1,
          }),
        ),
        spaceConnections: yield* sql<
          typeof T3poSpaceConnection.Type
        >`SELECT source_space_id AS sourceSpaceId, target_space_id AS targetSpaceId, target_project_id AS targetProjectId FROM t3po_space_connections`,
        sharedResources: yield* sql<
          typeof T3poSharedResource.Type
        >`SELECT id, owner_space_id AS ownerSpaceId, target_space_id AS targetSpaceId, name, location FROM t3po_shared_resources`,
        spaceTools: (yield* sql<{
          spaceId: string;
          tool: T3poSpaceTool["tool"];
          enabled: number;
        }>`SELECT space_id AS spaceId, tool, enabled FROM t3po_space_tools`).map((row) => ({
          spaceId: row.spaceId === "" ? null : row.spaceId,
          tool: row.tool,
          enabled: row.enabled === 1,
        })),
        spaces: yield* sql<T3poSpace>`SELECT id, name, rules FROM t3po_spaces ORDER BY rowid`,
        projectSpaces: yield* sql<
          typeof T3poProjectSpace.Type
        >`SELECT project_id AS projectId, space_id AS spaceId FROM t3po_project_spaces WHERE ${projectFilter}`,
        conversations: yield* sql<
          typeof T3poConversation.Type
        >`SELECT project_id AS projectId, thread_id AS threadId, channel_id AS channelId FROM t3po_conversations WHERE ${projectFilter}`,
        workstreams: yield* Effect.forEach(workstreams, (row) => decodeWorkstream(row.data)),
        notes: notes.map(toNotes),
        memory: memoryRows.map((row) => ({
          ...row,
          projectId: ProjectId.make(row.projectId),
          processing: processing[row.projectId],
          configured: memory.configured,
          available:
            memory.configured &&
            memory.exchangeAllowed(row.projectId) &&
            row.deliveryEnabled === 1 &&
            row.available === 1,
          delivery: {
            enabled: row.deliveryEnabled === 1,
            environmentAllowed: memory.exchangeAllowed(row.projectId),
            held: row.held,
            revision: row.deliveryRevision,
          },
        })),
        leads: yield* Effect.forEach(leads, (row) =>
          Effect.gen(function* () {
            const lead = yield* decodeT3poLeadJson(row.data);
            const budgets = yield* sql<{
              maxRuns: number;
              maxConcurrent: number;
              usedRuns: number;
              activeRuns: number;
            }>`SELECT max_runs AS maxRuns, max_concurrent AS maxConcurrent,
            (SELECT count(*) FROM t3po_admissions WHERE project_id = b.project_id) AS usedRuns,
            (SELECT count(*) FROM t3po_admissions WHERE project_id = b.project_id AND active = 1) AS activeRuns
            FROM t3po_budgets b WHERE project_id = ${lead.projectId}`;
            return { ...lead, ...(budgets[0] ? { budget: budgets[0] } : {}) };
          }),
        ),
        channels: yield* Effect.forEach(channels, (row) => decodeT3poChannelJson(row.data)),
        tasks: yield* Effect.forEach(tasks.slice(0, 50), (row) =>
          Effect.gen(function* () {
            const task = yield* decodeT3poTaskJson(row.data);
            const routes =
              yield* sql<T3poWorkReceipt>`SELECT id, job_id AS jobId, workstream_id AS workstreamId, state, reason FROM t3po_work_routes WHERE job_id = ${task.id} ORDER BY sequence DESC LIMIT 1`;
            return {
              ...task,
              workspaceLocked: row.launch !== null,
              ...(routes[0] ? { dispatch: routes[0] } : {}),
            };
          }),
        ),
        nextCursor: tasks.length > 50 ? tasks[49]!.cursor : null,
      };
    },
    Effect.mapError((cause) => new T3poError({ operation: "read", cause })),
  );
  const read = list({ view: "all" });
  const requireChannel = Effect.fn("T3poStore.requireChannel")(function* (
    id: string,
    projectId: ProjectId,
  ) {
    const rows =
      yield* sql`SELECT id FROM t3po_channels WHERE id = ${id} AND project_id = ${projectId} AND COALESCE(json_extract(data, '$.archived'), 0) = 0`;
    if (rows.length === 0) return yield* new T3poError({ operation: "invalid" });
  });
  const readNotes = (projectId: ProjectId, channelId: string | null) =>
    sql<NotesRow>`SELECT ${notesColumns} FROM t3po_notes WHERE thread_id = ${notesThread(projectId, channelId)} AND project_id = ${projectId}`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    );
  const writeNotes = Effect.fn("T3poStore.writeNotes")(function* (input: NotesWrite) {
    const owner =
      input.channelId === null
        ? yield* sql<{
            name: string;
          }>`SELECT 'lead chat' AS name FROM t3po_leads WHERE project_id = ${input.projectId}`
        : yield* sql<{
            name: string;
          }>`SELECT 'channel #' || json_extract(data, '$.name') AS name FROM t3po_channels WHERE id = ${input.channelId} AND project_id = ${input.projectId} AND COALESCE(json_extract(data, '$.archived'), 0) = 0`;
    if (!owner[0] || (input.text === undefined) === (input.edits === undefined))
      return yield* new T3poError({ operation: "invalid" });
    const current = yield* readNotes(input.projectId, input.channelId);
    if (input.expectedRevision !== undefined && input.expectedRevision !== (current?.revision ?? 0))
      return yield* new T3poError({ operation: "notes_stale" });
    const text = input.edits ? applyNotesEdits(current?.text ?? "", input.edits) : input.text;
    if (text == null || text.length > T3PO_NOTES_MAX_LENGTH)
      return yield* new T3poError({ operation: "invalid" });
    const now = DateTime.formatIso(yield* DateTime.now);
    const saved = {
      projectId: input.projectId,
      channelId: input.channelId,
      text,
      revision: (current?.revision ?? 0) + 1,
      updatedAt: now,
      updatedBy: input.updatedBy,
    } satisfies T3poNotes;
    if (text === (current?.text ?? ""))
      return current ? toNotes(current) : { ...saved, revision: 0 };
    const eventId = yield* enqueueMemory(
      input.projectId,
      "conversation_notes",
      `Working notes for the ${owner[0].name}, saved by the ${input.updatedBy}. They replace earlier notes for this conversation.\n\n${text}`,
    );
    if (eventId && current?.memoryEventId)
      yield* sql`UPDATE t3po_memory_events_v2 SET superseded_by = ${eventId}, revision = revision + 1 WHERE project_id = ${input.projectId} AND event_id = ${current.memoryEventId} AND superseded_by IS NULL`;
    yield* sql`INSERT INTO t3po_notes (thread_id, project_id, channel_id, text, revision, updated_at, updated_by, memory_event_id) VALUES (${notesThread(input.projectId, input.channelId)}, ${input.projectId}, ${input.channelId}, ${text}, ${saved.revision}, ${now}, ${input.updatedBy}, ${eventId}) ON CONFLICT(thread_id) DO UPDATE SET text = excluded.text, revision = excluded.revision, updated_at = excluded.updated_at, updated_by = excluded.updated_by, memory_event_id = excluded.memory_event_id`;
    return saved;
  });
  const mutate = Effect.fn("T3poStore.mutate")(
    function* (input: T3poMutation, reviewedRunId?: RunId) {
      if (input.type === "save_external_binding") {
        yield* ExternalActionStore.setBinding(input).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        return;
      }
      if (input.type === "memory_control") return yield* new T3poError({ operation: "invalid" });
      const now = DateTime.formatIso(yield* DateTime.now);
      if (input.type === "save_job_grant" || input.type === "revoke_job_grant") {
        const task = yield* getTask(input.id, input.projectId);
        if ((task.grant?.version ?? 0) !== input.expectedVersion)
          return yield* new T3poError({ operation: "grant_stale" });
        let grant = task.grant;
        if (input.type === "save_job_grant") {
          const budgets = yield* sql<{
            maxConcurrent: number;
          }>`SELECT max_concurrent AS maxConcurrent FROM t3po_budgets WHERE project_id = ${input.projectId}`;
          const maxConcurrent = budgets[0]?.maxConcurrent ?? T3PO_DEFAULT_CONCURRENT_JOBS;
          const expiry = Date.parse(input.expiresAt);
          if (input.briefRevision !== (task.briefRevision ?? 1))
            return yield* new T3poError({ operation: "grant_stale" });
          if (Number.isFinite(expiry) && expiry <= Date.parse(now))
            return yield* new T3poError({ operation: "grant_expired" });
          if (!Number.isFinite(expiry)) return yield* new T3poError({ operation: "grant_invalid" });
          const spaces = yield* sql<{
            spaceId: string;
          }>`SELECT space_id AS spaceId FROM t3po_project_spaces WHERE project_id = ${input.projectId}`;
          const projects = yield* sql<{
            root: string;
          }>`SELECT workspace_root AS root FROM projection_projects WHERE project_id = ${task.projectId}`;
          grant = {
            workspaceRoot: projects[0]?.root ?? null,
            version: input.expectedVersion + 1,
            briefRevision: input.briefRevision,
            spaceId: spaces[0]?.spaceId ?? null,
            workspace: task.workspace ?? { type: "root" },
            route: "local",
            expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expiry)),
            revoked: false,
            maxRuns: input.maxRuns ?? 1,
            maxConcurrent: Math.min(input.maxConcurrent ?? maxConcurrent, maxConcurrent),
          };
        } else {
          if (!grant) return yield* new T3poError({ operation: "grant_invalid" });
          grant = { ...grant, version: grant.version + 1, revoked: true };
        }
        yield* sql`INSERT INTO t3po_job_grants (task_id, version, project_id, data) VALUES (${task.id}, ${grant.version}, ${task.projectId}, ${yield* encodeUnknownJson(grant)})`;
        yield* sql`UPDATE t3po_tasks SET data = ${yield* encodeT3poTaskJson({ ...task, grant })} WHERE id = ${task.id}`;
      } else if (input.type === "save_space_rules") {
        const existing = yield* sql`SELECT id FROM t3po_spaces WHERE id = ${input.id}`;
        if (!existing.length) return yield* new T3poError({ operation: "invalid" });
        yield* sql`UPDATE t3po_spaces SET rules = ${input.rules} WHERE id = ${input.id}`;
      } else if (input.type === "set_space_tool") {
        if (input.spaceId !== null) {
          const space = yield* sql`SELECT id FROM t3po_spaces WHERE id = ${input.spaceId}`;
          if (!space.length) return yield* new T3poError({ operation: "invalid" });
        }
        const spaceKey = input.spaceId ?? "";
        if (input.enabled === null)
          yield* sql`DELETE FROM t3po_space_tools WHERE space_id = ${spaceKey} AND tool = ${input.tool}`;
        else
          yield* sql`INSERT INTO t3po_space_tools (space_id, tool, enabled) VALUES (${spaceKey}, ${input.tool}, ${input.enabled ? 1 : 0}) ON CONFLICT(space_id, tool) DO UPDATE SET enabled = excluded.enabled`;
      } else if (input.type === "connect_space") {
        const source = yield* sql`SELECT id FROM t3po_spaces WHERE id = ${input.sourceSpaceId}`;
        const target =
          yield* sql`SELECT project_id FROM t3po_project_spaces WHERE project_id = ${input.targetProjectId} AND space_id = ${input.targetSpaceId}`;
        if (!source.length || !target.length || input.sourceSpaceId === input.targetSpaceId)
          return yield* new T3poError({ operation: "invalid" });
        if (input.enabled)
          yield* sql`INSERT INTO t3po_space_connections (source_space_id, target_space_id, target_project_id) VALUES (${input.sourceSpaceId}, ${input.targetSpaceId}, ${input.targetProjectId}) ON CONFLICT(source_space_id, target_project_id) DO UPDATE SET target_space_id = excluded.target_space_id`;
        else {
          yield* sql`UPDATE t3po_space_handoffs SET revoked = 1 WHERE source_space_id = ${input.sourceSpaceId} AND target_project_id = ${input.targetProjectId}`;
          yield* sql`DELETE FROM t3po_space_connections WHERE source_space_id = ${input.sourceSpaceId} AND target_project_id = ${input.targetProjectId}`;
        }
      } else if (input.type === "share_resource") {
        const spaces =
          yield* sql`SELECT id FROM t3po_spaces WHERE id IN (${input.ownerSpaceId}, ${input.targetSpaceId})`;
        // References never store URL credentials, query tokens, or executable schemes.
        let valid = input.location.startsWith("/") || input.location.startsWith("~/");
        if (input.location.startsWith("https://")) {
          const url = new URL(input.location);
          valid = !url.username && !url.password && !url.search && !url.hash;
        }
        if (spaces.length !== 2 || !valid) return yield* new T3poError({ operation: "invalid" });
        yield* sql`INSERT INTO t3po_shared_resources (id, owner_space_id, target_space_id, name, location) VALUES (${input.id}, ${input.ownerSpaceId}, ${input.targetSpaceId}, ${input.name}, ${input.location}) ON CONFLICT(id) DO UPDATE SET owner_space_id = excluded.owner_space_id, target_space_id = excluded.target_space_id, name = excluded.name, location = excluded.location`;
      } else if (input.type === "unshare_resource") {
        yield* sql`DELETE FROM t3po_shared_resources WHERE id = ${input.id}`;
      } else if (input.type === "save_space") {
        yield* sql`INSERT INTO t3po_spaces (id, name) VALUES (${input.id}, ${input.name}) ON CONFLICT(id) DO UPDATE SET name = excluded.name`;
      } else if (input.type === "remove_space") {
        const members =
          yield* sql`SELECT project_id FROM t3po_project_spaces WHERE space_id = ${input.id} LIMIT 1`;
        if (members.length) return yield* new T3poError({ operation: "space_nonempty" });
        yield* sql`DELETE FROM t3po_space_tools WHERE space_id = ${input.id}`;
        yield* sql`DELETE FROM t3po_spaces WHERE id = ${input.id}`;
      } else if (input.type === "assign_space") {
        const previous = yield* sql<{
          id: string;
        }>`SELECT space_id AS id FROM t3po_project_spaces WHERE project_id = ${input.projectId}`;
        if ((previous[0]?.id ?? null) === input.spaceId) return;
        // Any live caller could retain data from a project whose boundary is being changed.
        const active =
          yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE json_extract(payload_json, '$.activeRunId') IS NOT NULL OR json_array_length(json_extract(payload_json, '$.pendingBackgroundTasks')) > 0 UNION SELECT thread_id FROM orchestration_v2_projection_runs WHERE status IN ('preparing', 'queued', 'starting', 'running', 'waiting') LIMIT 1`;
        if (active.length) return yield* new T3poError({ operation: "space_busy" });
        const bound = yield* sql<{
          data: string;
        }>`SELECT data FROM t3po_tasks WHERE project_id = ${input.projectId} AND json_extract(data, '$.grant') IS NOT NULL`;
        for (const row of bound) {
          const task = yield* decodeT3poTaskJson(row.data);
          const grant = { ...task.grant!, version: task.grant!.version + 1, revoked: true };
          yield* sql`INSERT INTO t3po_job_grants (task_id, version, project_id, data) VALUES (${task.id}, ${grant.version}, ${task.projectId}, ${yield* encodeUnknownJson(grant)})`;
          yield* sql`UPDATE t3po_tasks SET data = ${yield* encodeT3poTaskJson({ ...task, grant })} WHERE id = ${task.id}`;
        }
        yield* sql`UPDATE t3po_space_handoffs SET revoked = 1 WHERE source_project_id = ${input.projectId} OR target_project_id = ${input.projectId}`;
        yield* sql`DELETE FROM t3po_space_connections WHERE target_project_id = ${input.projectId}`;

        if (input.spaceId !== null) {
          const space = yield* sql`SELECT id FROM t3po_spaces WHERE id = ${input.spaceId}`;
          if (!space.length) return yield* new T3poError({ operation: "invalid" });
          yield* sql`INSERT INTO t3po_project_spaces (project_id, space_id) VALUES (${input.projectId}, ${input.spaceId}) ON CONFLICT(project_id) DO UPDATE SET space_id = excluded.space_id`;
        } else yield* sql`DELETE FROM t3po_project_spaces WHERE project_id = ${input.projectId}`;
      } else if (input.type === "move_conversation") {
        const ordinary =
          yield* sql`SELECT thread_id FROM orchestration_v2_projection_threads WHERE thread_id = ${input.threadId} AND project_id = ${input.projectId} AND deleted_at IS NULL AND archived_at IS NULL AND json_extract(payload_json, '$.lineage.parentThreadId') IS NULL AND json_extract(payload_json, '$.delegatedFrom') IS NULL`;
        const managed =
          yield* sql`SELECT project_id FROM t3po_tasks WHERE json_extract(data, '$.threadId') = ${input.threadId} UNION SELECT project_id FROM t3po_leads WHERE json_extract(data, '$.threadId') = ${input.threadId}`;
        if (
          !ordinary.length ||
          managed.length ||
          /^t3po-(?:lead|task|channel):/.test(input.threadId)
        )
          return yield* new T3poError({ operation: "invalid" });
        if (input.channelId === null) {
          if (input.newChannelName) return yield* new T3poError({ operation: "invalid" });
          yield* sql`DELETE FROM t3po_conversations WHERE thread_id = ${input.threadId} AND project_id = ${input.projectId}`;
        } else {
          if (input.newChannelName) {
            const existing = yield* sql<{
              data: string;
            }>`SELECT data FROM t3po_channels WHERE id = ${input.channelId}`;
            if (
              existing.length &&
              ((yield* decodeT3poChannelJson(existing[0]!.data)).name !== input.newChannelName ||
                (yield* decodeT3poChannelJson(existing[0]!.data)).projectId !== input.projectId)
            )
              return yield* new T3poError({ operation: "invalid" });
            const channel = {
              id: input.channelId,
              projectId: input.projectId,
              name: input.newChannelName,
              archived: false,
            };
            yield* sql`INSERT INTO t3po_channels (id, project_id, data) VALUES (${input.channelId}, ${input.projectId}, ${yield* encodeT3poChannelJson(channel)}) ON CONFLICT(id) DO NOTHING`;
          }
          yield* requireChannel(input.channelId, input.projectId);
          yield* sql`INSERT INTO t3po_conversations (thread_id, project_id, channel_id) VALUES (${input.threadId}, ${input.projectId}, ${input.channelId}) ON CONFLICT(thread_id) DO UPDATE SET channel_id = excluded.channel_id`;
        }
      } else if (input.type === "save_workstream") {
        const rows = yield* sql<{
          data: string;
        }>`SELECT data FROM t3po_workstreams WHERE id = ${input.id} AND project_id = ${input.projectId}`;
        if (!rows[0]) return yield* new T3poError({ operation: "invalid" });
        const previous = yield* decodeWorkstream(rows[0].data);
        if (previous.channelId !== input.channelId)
          return yield* new T3poError({ operation: "invalid" });
        yield* sql`UPDATE t3po_workstreams SET data = ${yield* encodeUnknownJson({ ...previous, title: input.title, goal: input.goal, state: input.state })} WHERE id = ${input.id}`;
      } else if (input.type === "save_notes") {
        yield* writeNotes({ ...input, updatedBy: "user" });
      } else if (input.type === "move_job") {
        const task = yield* getTask(input.id, input.projectId);
        const rows =
          yield* sql`SELECT id FROM t3po_workstreams WHERE id = ${input.workstreamId} AND project_id = ${input.projectId} AND channel_id IS ${task.channelId} AND json_extract(data, '$.state') != 'archived'`;
        if (!rows.length) return yield* new T3poError({ operation: "invalid" });
        yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.workstreamId', ${input.workstreamId}) WHERE id = ${task.id}`;
        yield* sql`UPDATE t3po_work_routes SET workstream_id = ${input.workstreamId} WHERE job_id = ${task.id}`;
      } else if (input.type === "save_budget") {
        // max_runs is no longer enforced; only how many jobs run at once is.
        yield* sql`INSERT INTO t3po_budgets (project_id, max_runs, max_concurrent) VALUES (${input.projectId}, 0, ${input.maxConcurrent}) ON CONFLICT(project_id) DO UPDATE SET max_concurrent = excluded.max_concurrent`;
      } else if (input.type === "redraw_project_icon") {
        const rows = yield* sql<{
          data: string;
        }>`SELECT data FROM t3po_leads WHERE project_id = ${input.projectId}`;
        if (!rows[0]) return yield* new T3poError({ operation: "invalid" });
        const {
          iconRequested: _previous,
          iconRequestRunId: _previousRun,
          ...lead
        } = yield* decodeT3poLeadJson(rows[0].data);
        yield* sql`UPDATE t3po_leads SET data = ${yield* encodeT3poLeadJson(lead)} WHERE project_id = ${input.projectId}`;
      } else if (input.type === "save_work_access") {
        const rows = yield* sql<{
          data: string;
        }>`SELECT data FROM t3po_leads WHERE project_id = ${input.projectId}`;
        if (!rows[0]) return yield* new T3poError({ operation: "invalid" });
        const { workAccess: _previous, ...lead } = yield* decodeT3poLeadJson(rows[0].data);
        const data: T3poLead =
          input.runtimeMode === T3PO_DEFAULT_WORK_ACCESS
            ? lead
            : { ...lead, workAccess: input.runtimeMode };
        yield* sql`UPDATE t3po_leads SET data = ${yield* encodeT3poLeadJson(data)} WHERE project_id = ${input.projectId}`;
      } else if (input.type === "save_work_model") {
        const rows = yield* sql<{
          data: string;
        }>`SELECT data FROM t3po_leads WHERE project_id = ${input.projectId}`;
        if (!rows[0]) return yield* new T3poError({ operation: "invalid" });
        const { workModel: _previous, ...lead } = yield* decodeT3poLeadJson(rows[0].data);
        const data: T3poLead =
          input.modelSelection === null ? lead : { ...lead, workModel: input.modelSelection };
        yield* sql`UPDATE t3po_leads SET data = ${yield* encodeT3poLeadJson(data)} WHERE project_id = ${input.projectId}`;
      } else if (input.type === "save_lead") {
        const previous = yield* sql<{
          data: string;
        }>`SELECT data FROM t3po_leads WHERE project_id = ${input.projectId}`;
        const prior = previous[0] ? yield* decodeT3poLeadJson(previous[0].data) : undefined;
        if (prior ? prior.brief !== input.brief : input.brief.trim() !== "")
          yield* enqueueMemory(input.projectId, "project_brief", input.brief);
        const data: T3poLead = {
          projectId: input.projectId,
          // Without a name the lead keeps its placeholder and names itself later (LeadNaming).
          name: input.name ?? (prior?.autoName ? prior.name : T3PO_LEAD_PLACEHOLDER_NAME),
          brief: input.brief,
          threadId: ThreadId.make(`t3po-lead:${input.projectId}`),
          ...(input.name === undefined ? { autoName: true } : {}),
          ...(prior?.workModel ? { workModel: prior.workModel } : {}),
          ...(prior?.workAccess ? { workAccess: prior.workAccess } : {}),
          ...(prior?.iconRequested ? { iconRequested: true } : {}),
          ...(prior?.iconRequestRunId ? { iconRequestRunId: prior.iconRequestRunId } : {}),
        };
        yield* sql`INSERT INTO t3po_leads (project_id, data) VALUES (${input.projectId}, ${yield* encodeT3poLeadJson(data)}) ON CONFLICT(project_id) DO UPDATE SET data = excluded.data`;
      } else if (input.type === "create_channel") {
        const data = {
          id: input.id,
          projectId: input.projectId,
          name: input.name,
          archived: false,
        };
        yield* sql`INSERT INTO t3po_channels (id, project_id, data) VALUES (${input.id}, ${input.projectId}, ${yield* encodeT3poChannelJson(data)}) ON CONFLICT(id) DO NOTHING`;
      } else if (input.type === "create_task") {
        if (input.channelId !== null) yield* requireChannel(input.channelId, input.projectId);
        if (input.origin) {
          const destination =
            yield* sql`SELECT m.message_id FROM orchestration_v2_projection_messages m
            JOIN orchestration_v2_projection_threads t ON t.thread_id = m.thread_id
            WHERE m.message_id = ${input.origin.messageId} AND m.thread_id = ${input.origin.threadId}
              AND t.project_id = ${input.projectId} AND t.deleted_at IS NULL AND t.archived_at IS NULL`;
          if (!destination.length) return yield* new T3poError({ operation: "invalid" });
        }
        const data: T3poTask = {
          id: input.id,
          origin: input.origin,
          desiredOutcome: input.desiredOutcome,
          completionPolicy: input.origin ? "human_review" : input.completionPolicy,
          briefRevision: 1,
          projectId: input.projectId,
          channelId: input.channelId,
          title: input.title,
          brief: input.brief,
          threadId: ThreadId.make(`t3po-task:${input.id}`),
          completed: false,
          reviewedRunId: null,
          createdAt: now,
          archived: false,
          workspace: input.workspace ?? { type: "worktree" },
        };
        yield* sql`INSERT INTO t3po_tasks (id, project_id, data) VALUES (${input.id}, ${input.projectId}, ${yield* encodeT3poTaskJson(data)}) ON CONFLICT(id) DO NOTHING`;
        yield* sql`INSERT INTO t3po_task_revisions (task_id, revision, data, created_at)
          SELECT id, 1, data, ${now} FROM t3po_tasks WHERE id = ${input.id} AND project_id = ${input.projectId}
          ON CONFLICT(task_id, revision) DO NOTHING`;
      } else if (input.type === "delete_channel") {
        const exists =
          yield* sql`SELECT id FROM t3po_channels WHERE id = ${input.id} AND project_id = ${input.projectId}`;
        if (!exists.length) return yield* new T3poError({ operation: "invalid" });
        const channelThread = `t3po-channel:${input.id}`;
        // Work still running in the channel would report back into a chat that no longer exists.
        const busy =
          yield* sql`SELECT r.run_id FROM orchestration_v2_projection_runs r WHERE r.status IN ('preparing', 'queued', 'starting', 'running', 'waiting') AND (r.thread_id = ${channelThread} OR r.thread_id IN (SELECT json_extract(data, '$.threadId') FROM t3po_tasks WHERE project_id = ${input.projectId} AND json_extract(data, '$.channelId') = ${input.id})) LIMIT 1`;
        if (busy.length) return yield* new T3poError({ operation: "channel_busy" });
        yield* sql`DELETE FROM t3po_conversations WHERE project_id = ${input.projectId} AND channel_id = ${input.id}`;
        yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.channelId', json('null')) WHERE project_id = ${input.projectId} AND json_extract(data, '$.channelId') = ${input.id}`;
        yield* sql`UPDATE t3po_workstreams SET channel_id = NULL, data = json_set(data, '$.channelId', json('null')) WHERE project_id = ${input.projectId} AND channel_id = ${input.id}`;
        yield* sql`DELETE FROM t3po_notes WHERE project_id = ${input.projectId} AND channel_id = ${input.id}`;
        yield* sql`DELETE FROM t3po_push_mutes WHERE project_id = ${input.projectId} AND channel_id = ${input.id}`;
        yield* sql`DELETE FROM t3po_channels WHERE id = ${input.id} AND project_id = ${input.projectId}`;
      } else if (input.type === "edit_channel" || input.type === "archive_channel") {
        const rows = yield* sql<{
          data: string;
        }>`SELECT data FROM t3po_channels WHERE id = ${input.id} AND project_id = ${input.projectId}`;
        if (!rows[0]) return yield* new T3poError({ operation: "invalid" });
        const channel = yield* decodeT3poChannelJson(rows[0].data);
        const updated =
          input.type === "edit_channel"
            ? { ...channel, name: input.name }
            : { ...channel, archived: input.archived };
        yield* sql`UPDATE t3po_channels SET data = ${yield* encodeT3poChannelJson(updated)} WHERE id = ${input.id} AND project_id = ${input.projectId}`;
      } else {
        const task = yield* getTask(input.id, input.projectId);
        let updated: T3poTask = task;
        if (input.type === "edit_task") {
          if (input.channelId !== null && input.channelId !== task.channelId)
            yield* requireChannel(input.channelId, input.projectId);
          if (input.workspace && task.workspaceLocked)
            return yield* new T3poError({ operation: "invalid" });
          if (task.completed && input.brief !== task.brief) {
            yield* enqueueMemory(
              input.projectId,
              "review_reopened",
              yield* encodeUnknownJson({
                taskId: task.id,
                title: input.title,
                runId: task.reviewedRunId,
                meaning:
                  "The user changed the brief and reopened this task; the earlier acceptance no longer establishes current completion.",
              }),
            );
          }
          const changed =
            (input.workspace !== undefined &&
              (yield* encodeUnknownJson(input.workspace)) !==
                (yield* encodeUnknownJson(task.workspace ?? { type: "root" }))) ||
            input.brief !== task.brief ||
            input.title !== task.title ||
            (input.desiredOutcome !== undefined && input.desiredOutcome !== task.desiredOutcome);
          yield* sql`INSERT INTO t3po_task_revisions (task_id, revision, data, created_at)
            VALUES (${task.id}, ${task.briefRevision ?? 1}, ${yield* encodeT3poTaskJson(task)}, ${now})
            ON CONFLICT(task_id, revision) DO NOTHING`;
          updated = {
            ...task,
            briefRevision: (task.briefRevision ?? 1) + (changed ? 1 : 0),
            desiredOutcome: input.desiredOutcome ?? task.desiredOutcome,
            title: input.title,
            brief: input.brief,
            channelId: input.channelId,
            ...(input.channelId !== task.channelId ? { workstreamId: undefined } : {}),
            ...(input.workspace ? { workspace: input.workspace } : {}),
            ...(changed ? { completed: false, reviewedRunId: null } : {}),
          };
        } else if (input.type === "archive_task") {
          if (input.archived) {
            const active =
              yield* sql`SELECT run_id FROM orchestration_v2_projection_runs WHERE thread_id = ${task.threadId} AND status IN ('preparing', 'queued', 'starting', 'running', 'waiting') LIMIT 1`;
            if (active.length) return yield* new T3poError({ operation: "busy" });
          }
          updated = { ...task, archived: input.archived };
        } else if (input.type === "review_task") {
          if (
            input.completed !== task.completed ||
            (input.completed && reviewedRunId !== task.reviewedRunId)
          ) {
            const result = input.completed
              ? (yield* results({ projectId: input.projectId, taskId: task.id }, 1)).results[0]
              : undefined;
            yield* enqueueMemory(
              input.projectId,
              input.completed ? "accepted_result" : "review_reopened",
              yield* encodeUnknownJson({
                taskId: task.id,
                threadId: task.threadId,
                title: task.title,
                runId: reviewedRunId ?? task.reviewedRunId,
                result:
                  result && result.runId === reviewedRunId ? result.text.slice(0, 10000) : null,
                meaning: input.completed
                  ? "The user marked this execution reviewed and complete."
                  : "The user reopened this task; its earlier acceptance no longer establishes current completion.",
              }),
            );
          }
          updated = {
            ...task,
            completed: input.completed,
            reviewedRunId: input.completed ? (reviewedRunId ?? null) : null,
          };
        }
        if (input.type === "edit_task")
          yield* sql`INSERT INTO t3po_task_revisions (task_id, revision, data, created_at)
            VALUES (${task.id}, ${updated.briefRevision ?? 1}, ${yield* encodeT3poTaskJson(updated)}, ${now})
            ON CONFLICT(task_id, revision) DO NOTHING`;
        yield* sql`UPDATE t3po_tasks SET data = ${yield* encodeT3poTaskJson(updated)} WHERE id = ${input.id} AND project_id = ${input.projectId}`;
      }
    },
    sql.withTransaction,
    Effect.tap(() => Queue.offer(wake, undefined)),
    Effect.mapError((cause) =>
      isT3poError(cause) ? cause : new T3poError({ operation: "save", cause }),
    ),
  );
  const reserveLaunch = Effect.fn("T3poStore.reserveLaunch")(
    function* (
      taskId: string,
      projectId: ProjectId,
      input: typeof LaunchReservation.Type,
      expectedWorkspace?: T3poWorkspace,
    ) {
      const task = yield* getTask(taskId, projectId);
      if (task.archived) return yield* new T3poError({ operation: "invalid" });
      if (!task.workspaceLocked && expectedWorkspace) {
        const current = task.workspace ?? { type: "root" };
        if (
          current.type !== expectedWorkspace.type ||
          (current.type === "worktree" &&
            expectedWorkspace.type === "worktree" &&
            (current.baseRef !== expectedWorkspace.baseRef ||
              current.startFromOrigin !== expectedWorkspace.startFromOrigin))
        )
          return yield* new T3poError({ operation: "invalid" });
      }
      const reservation = {
        ...input,
        title: task.title,
        brief: task.brief,
        messageId: MessageId.make(`t3po-launch:${task.id}:revision:${task.briefRevision ?? 1}`),
        briefRevision: task.briefRevision ?? 1,
      };
      yield* sql`UPDATE t3po_tasks SET launch = ${yield* encodeT3poLaunchInputJson(reservation)} WHERE id = ${taskId} AND project_id = ${projectId} AND (launch IS NULL OR (
        COALESCE(json_extract(launch, '$.briefRevision'), 1) <> ${task.briefRevision ?? 1}
        AND NOT EXISTS (SELECT 1 FROM t3po_task_executions WHERE task_id = ${taskId})
        AND NOT EXISTS (SELECT 1 FROM t3po_grant_admissions WHERE task_id = ${taskId})
      ))`;
      const rows = yield* sql<{
        launch: string;
      }>`SELECT launch FROM t3po_tasks WHERE id = ${taskId} AND project_id = ${projectId}`;
      if (!rows[0]) return yield* new T3poError({ operation: "invalid" });
      const reserved = yield* decodeT3poLaunchInputJson(rows[0].launch);

      if (reserved.messageId)
        yield* sql`INSERT INTO t3po_launch_revisions (message_id, task_id, revision)
          VALUES (${reserved.messageId}, ${task.id}, ${reserved.briefRevision ?? 1}) ON CONFLICT DO NOTHING`;
      return reserved;
    },
    sql.withTransaction,
    Effect.mapError((cause) =>
      isT3poError(cause) ? cause : new T3poError({ operation: "save", cause }),
    ),
  );
  const context = Effect.fn("T3poStore.context")(
    function* (projectId: ProjectId, threadId: ThreadId, query = "", runId?: RunId) {
      const none = { context: "", recall: "" };
      if (
        !threadId.startsWith("t3po-lead:") &&
        !threadId.startsWith("t3po-task:") &&
        !threadId.startsWith("t3po-channel:")
      ) {
        const linked =
          yield* sql`SELECT id FROM t3po_tasks WHERE project_id = ${projectId} AND json_extract(data, '$.threadId') = ${threadId} LIMIT 1`;
        if (linked.length === 0) return none;
      }
      const leads = yield* sql<{
        data: string;
      }>`SELECT data FROM t3po_leads WHERE project_id = ${projectId}`;
      const lead = leads[0]
        ? yield* decodeT3poLeadJson(leads[0].data)
        : {
            threadId: ThreadId.make(`t3po-lead:${projectId}`),
            name: "",
            brief: "",
          };
      const channelRows = yield* sql<{
        data: string;
      }>`SELECT data FROM t3po_channels WHERE project_id = ${projectId} AND 't3po-channel:' || id = ${threadId} LIMIT 1`;
      const channel = channelRows[0] ? yield* decodeT3poChannelJson(channelRows[0].data) : null;
      const tasks = yield* sql<{
        data: string;
      }>`SELECT data FROM t3po_tasks WHERE project_id = ${projectId} AND COALESCE(json_extract(data, '$.archived'), 0) = 0 AND ${channel ? sql`json_extract(data, '$.channelId') = ${channel.id}` : sql`1 = 1`} ORDER BY rowid DESC LIMIT 30`;
      const records = yield* Effect.forEach(tasks, (row) => decodeT3poTaskJson(row.data));
      const assignments = yield* sql<{
        data: string;
      }>`SELECT data FROM t3po_tasks WHERE project_id = ${projectId} AND json_extract(data, '$.threadId') = ${threadId} LIMIT 1`;
      let assignment = assignments[0] ? yield* decodeT3poTaskJson(assignments[0].data) : null;
      if (!leads[0] && !assignment) return none;
      if (assignment && runId) {
        const rows = yield* sql<{ data: string }>`SELECT r.data FROM t3po_task_executions e
          JOIN t3po_task_revisions r ON r.task_id = e.task_id AND r.revision = e.revision WHERE e.run_id = ${runId}`;
        if (rows[0]) assignment = yield* decodeT3poTaskJson(rows[0].data);
      }
      if (threadId !== lead.threadId && !assignment && !channel) return none;
      let recall = "";
      let memoryAvailable = false;
      if ((threadId === lead.threadId || channel) && memory.configured) {
        const recalled = yield* exchangeMemory(projectId, query.slice(0, 2000));
        if (!recalled) return none;
        recall = recalled.context;
        memoryAvailable = recalled.available;
      }
      const recentRecords = yield* sql<{
        kind: string;
        text: string;
      }>`SELECT kind, substr(text, 1, 2000) AS text FROM t3po_memory_events_v2 WHERE project_id = ${projectId} AND superseded_by IS NULL AND kind != 'conversation_notes' ORDER BY sequence DESC LIMIT 5`;
      const notes =
        threadId === lead.threadId || channel
          ? yield* readNotes(projectId, channel?.id ?? null)
          : null;
      // Jobs see the notes of the chat that routed them, never another project's.
      const routingNotes = assignment
        ? yield* sql<{
            text: string;
          }>`SELECT n.text FROM t3po_work_routes r JOIN t3po_notes n ON n.thread_id = r.caller_thread_id AND n.project_id = ${projectId} WHERE r.job_id = ${assignment.id} ORDER BY r.sequence LIMIT 1`
        : [];
      const context = yield* encodeUnknownJson({
        spaceRules:
          yield* sql`SELECT s.name, s.rules FROM t3po_spaces s JOIN t3po_project_spaces p ON p.space_id = s.id WHERE p.project_id = ${projectId}`,
        sharedResources:
          yield* sql`SELECT r.name, r.location, r.owner_space_id AS ownerSpaceId FROM t3po_shared_resources r JOIN t3po_project_spaces p ON p.project_id = ${projectId} AND p.space_id IN (r.owner_space_id, r.target_space_id) ORDER BY r.rowid LIMIT 50`,
        handoffDestinations:
          threadId === lead.threadId || channel
            ? yield* sql`SELECT c.target_project_id AS projectId, c.target_space_id AS spaceId, (SELECT name FROM t3po_spaces WHERE id = c.target_space_id) AS spaceName, (SELECT json_extract(data, '$.name') FROM t3po_leads WHERE project_id = c.target_project_id) AS leadName FROM t3po_space_connections c JOIN t3po_project_spaces p ON p.project_id = ${projectId} AND p.space_id = c.source_space_id JOIN t3po_project_spaces t ON t.project_id = c.target_project_id AND t.space_id = c.target_space_id LIMIT 50`
            : [],
        outgoingHandoffs:
          threadId === lead.threadId || channel
            ? yield* sql`SELECT h.job_id AS jobId, h.target_project_id AS projectId, r.state, r.reason FROM t3po_space_handoffs h JOIN t3po_work_routes r ON r.job_id = h.job_id WHERE h.source_project_id = ${projectId} AND r.caller_thread_id = ${threadId} ORDER BY r.sequence DESC LIMIT 30`
            : [],
        workstreams:
          threadId === lead.threadId || channel
            ? yield* Effect.forEach(
                yield* sql<{
                  data: string;
                }>`SELECT data FROM t3po_workstreams WHERE project_id = ${projectId} AND channel_id IS ${channel?.id ?? null} ORDER BY rowid DESC LIMIT 30`,
                (row) => decodeWorkstream(row.data),
              )
            : [],
        memory: {
          configured: memory.configured,
          available: memoryAvailable,
          ...(memory.configured && !(yield* remembered(projectId))
            ? {
                offTheRecord:
                  "This project is in no space, so nothing from it is kept in long-term memory. Moving it into a space starts memory.",
              }
            : {}),
          recentRecords,
        },
        role: threadId === lead.threadId || channel ? "project lead" : "task worker",
        lead: lead.name,
        projectBrief: lead.brief,
        channel: channel ? { id: channel.id, name: channel.name } : null,
        ...(threadId === lead.threadId || channel
          ? {
              notes: notes
                ? {
                    text: notes.text,
                    revision: notes.revision,
                    updatedAt: notes.updatedAt,
                    updatedBy: notes.updatedBy,
                  }
                : null,
            }
          : { routingNotes: routingNotes[0]?.text ?? null }),
        assignment: assignment?.brief ?? null,
        briefRevision: assignment ? (assignment.briefRevision ?? 1) : null,
        desiredOutcome: assignment?.desiredOutcome ?? null,
        completionPolicy: assignment?.completionPolicy ?? null,
        queuedWork:
          threadId === lead.threadId || channel
            ? yield* sql`SELECT r.job_id AS jobId, r.workstream_id AS workstreamId, r.state, r.reason FROM t3po_work_routes r JOIN t3po_tasks t ON t.id = r.job_id WHERE r.project_id = ${projectId} AND r.state != 'sent' AND json_extract(t.data, '$.channelId') IS ${channel?.id ?? null} ORDER BY r.sequence DESC LIMIT 30`
            : [],
        recentTasks: records
          .filter((task) => !channel || task.channelId === channel.id)
          .map((task) => ({
            id: task.id,
            workstreamId: task.workstreamId,
            title: task.title,
            threadId: task.threadId,
            reviewedComplete: task.completed,
            brief: task.brief.slice(0, 300),
          })),
      });
      return {
        context,
        recall: recall === "" ? "" : yield* encodeUnknownJson({ recalledContext: recall }),
      };
    },
    Effect.mapError((cause) => new T3poError({ operation: "read", cause })),
  );
  const claimContextDelivery = Effect.fn("T3poStore.claimContextDelivery")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
      readonly providerThreadId: string;
      readonly context: string;
    }) {
      // Jobs and linked threads always restate their assignment.
      if (!isT3poLeadConversation(input.threadId)) return true;
      // Provider-native, idle, and manual compactions all leave a compaction item.
      const counted = yield* sql<{
        count: number;
      }>`SELECT count(*) AS count FROM orchestration_v2_projection_turn_items WHERE thread_id = ${input.threadId} AND type = 'compaction'`;
      const compactions = counted[0]?.count ?? 0;
      const previous = (yield* sql<{
        context: string;
        providerThreadId: string;
        runId: string;
        compactions: number;
      }>`SELECT context, provider_thread_id AS providerThreadId, run_id AS runId, compactions FROM t3po_context_deliveries WHERE thread_id = ${input.threadId}`)[0];
      // A run that never reached its provider, or was rolled back, did not deliver its block.
      const reached =
        previous === undefined || previous.runId === input.runId
          ? []
          : yield* sql`SELECT 1 FROM orchestration_v2_projection_run_attempts a JOIN orchestration_v2_projection_runs r ON r.run_id = a.run_id WHERE a.run_id = ${previous.runId} AND a.provider_turn_id IS NOT NULL AND r.status != 'rolled_back' LIMIT 1`;
      if (
        previous !== undefined &&
        reached.length > 0 &&
        previous.context === input.context &&
        previous.providerThreadId === input.providerThreadId &&
        previous.compactions === compactions
      )
        return false;
      yield* sql`INSERT INTO t3po_context_deliveries (thread_id, context, provider_thread_id, run_id, compactions)
        VALUES (${input.threadId}, ${input.context}, ${input.providerThreadId}, ${input.runId}, ${compactions})
        ON CONFLICT(thread_id) DO UPDATE SET context = excluded.context, provider_thread_id = excluded.provider_thread_id, run_id = excluded.run_id, compactions = excluded.compactions`;
      return true;
    },
    Effect.mapError((cause) => new T3poError({ operation: "save", cause })),
  );
  return Store.of({
    proposalEnabled: Effect.fn("T3poStore.proposalEnabled")((threadId: ThreadId) =>
      ExternalActionStore.proposalBinding(threadId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.map((binding) => binding !== null),
        Effect.mapError((cause) => new T3poError({ operation: "read", cause })),
      ),
    ),
    checkStart: Effect.fn("T3poStore.checkStart")((threadId, runId, binding) =>
      Authority.checkJobGrants(threadId, runId, true, binding).pipe(
        sql.withTransaction,
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((cause) =>
          isT3poError(cause) ? cause : new T3poError({ operation: "grant_invalid", cause }),
        ),
      ),
    ),
    memoryDeliveryLock: Effect.succeed(sends),
    runMemoryWorker,
    controlMemory: Effect.fn("T3poStore.controlMemory")(
      function* (input: T3poMemoryControl) {
        if (["refresh", "pause", "resume", "retry"].includes(input.action))
          return yield* memory.control(input);
        yield* sql.withTransaction(
          Effect.gen(function* () {
            const leads =
              yield* sql`SELECT project_id FROM t3po_leads WHERE project_id = ${input.projectId}`;
            if (!leads.length) return yield* new T3poError({ operation: "invalid" });
            const policies = yield* sql<{
              enabled: number;
              revision: number;
            }>`SELECT enabled, revision FROM t3po_memory_delivery_policy WHERE project_id = ${input.projectId}`;
            const policy = policies[0] ?? { enabled: 1, revision: 0 };
            if (input.expectedDeliveryRevision !== policy.revision)
              return yield* new T3poError({ operation: "invalid" });
            if (input.action !== "stop_delivery" && !memory.exchangeAllowed(input.projectId))
              return yield* new T3poError({ operation: "invalid" });
            if (input.action === "release_backlog" && policy.enabled === 0)
              return yield* new T3poError({ operation: "invalid" });
            if (input.action === "release_backlog") {
              const held = yield* sql<{
                count: number;
              }>`SELECT count(*) AS count FROM t3po_memory_events_v2 WHERE project_id = ${input.projectId} AND synced_at IS NULL AND delivery_held = 1 AND superseded_by IS NULL AND kind != 'local_correction'`;
              if (input.expectedHeldRecords !== held[0]?.count)
                return yield* new T3poError({ operation: "invalid" });
            }
            const enabled = input.action === "stop_delivery" ? 0 : 1;
            yield* sql`INSERT INTO t3po_memory_delivery_policy (project_id, enabled, revision) VALUES (${input.projectId}, ${enabled}, ${policy.revision + 1}) ON CONFLICT(project_id) DO UPDATE SET enabled = excluded.enabled, revision = excluded.revision`;
            if (input.action === "stop_delivery")
              yield* sql`UPDATE t3po_memory_events_v2 SET delivery_held = 1 WHERE project_id = ${input.projectId} AND synced_at IS NULL`;
            if (input.action === "release_backlog")
              yield* sql`UPDATE t3po_memory_events_v2 SET delivery_held = 0 WHERE project_id = ${input.projectId} AND synced_at IS NULL`;
            yield* sql`UPDATE t3po_memory_status SET next_attempt = 0, failures = 0 WHERE project_id = ${input.projectId}`;
          }),
        );
        yield* PubSub.publish(changes, { projectId: input.projectId, metadata: true });
        yield* Queue.offer(wake, undefined);
      },
      sends.withPermit,
      Effect.mapError((cause) =>
        isT3poError(cause) ? cause : new T3poError({ operation: "save", cause }),
      ),
    ),
    read,
    list,
    notes: Effect.fn("T3poStore.notes")(
      function* (projectId: ProjectId, channelId: string | null) {
        const row = yield* readNotes(projectId, channelId);
        return row ? toNotes(row) : null;
      },
      Effect.mapError((cause) => new T3poError({ operation: "read", cause })),
    ),
    saveNotes: Effect.fn("T3poStore.saveNotes")(
      writeNotes,
      sql.withTransaction,
      Effect.tap(() => Queue.offer(wake, undefined)),
      Effect.mapError((cause) =>
        isT3poError(cause) ? cause : new T3poError({ operation: "save", cause }),
      ),
    ),
    results,
    getTask,
    getTaskProject,
    mutate,
    requestProjectIcon: Effect.fn("T3poStore.requestProjectIcon")(
      function* (projectId: ProjectId, runId: RunId) {
        // Asked once, unless the run that carried the request did not complete. Setting the
        // icon clears the run, so a drawn icon is never asked for again.
        const marked = yield* sql<{
          projectId: string;
        }>`UPDATE t3po_leads SET data = json_set(data, '$.iconRequested', json('true'), '$.iconRequestRunId', ${runId})
          WHERE project_id = ${projectId} AND (
            COALESCE(json_extract(data, '$.iconRequested'), 0) = 0
            OR (json_extract(data, '$.iconRequestRunId') IS NOT NULL AND (
              json_extract(data, '$.iconRequestRunId') = ${runId}
              OR NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_runs r WHERE r.run_id = json_extract(t3po_leads.data, '$.iconRequestRunId') AND r.status = 'completed')))
          ) RETURNING project_id AS projectId`;
        return marked.length > 0;
      },
      Effect.mapError((cause) => new T3poError({ operation: "save", cause })),
    ),
    reserveLaunch,
    context,
    claimContextDelivery,
    scheduledTurnNote: Effect.fn("T3poStore.scheduledTurnNote")((taskId: ScheduledTaskId) =>
      ScheduledTurn.note(taskId).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.mapError((cause) => new T3poError({ operation: "read", cause })),
      ),
    ),
  });
});
export const layer = Layer.effect(Store, make).pipe(
  Layer.provide(Layer.merge(MemoryBridge.layer, Changes.layer)),
);
