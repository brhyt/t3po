import * as Changes from "./Changes.ts";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Semaphore from "effect/Semaphore";
import * as MemoryBridge from "./MemoryBridge.ts";
import {
  T3poSpace,
  T3poSharedResource,
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
  ThreadId,
  T3poLead,
  T3poWorkstream,
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
const LaunchReservation = Schema.Struct({
  ...T3poLaunchInput.fields,
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
  spaceConnections: readonly (typeof T3poSpaceConnection.Type)[];
  sharedResources: readonly (typeof T3poSharedResource.Type)[];
  spaces: readonly T3poSpace[];
  projectSpaces: readonly (typeof T3poProjectSpace.Type)[];
  conversations: readonly (typeof T3poConversation.Type)[];
  workstreams: readonly T3poWorkstream[];
  memory: readonly (typeof T3poMemoryStatus.Type)[];
  leads: readonly T3poLead[];
  channels: readonly (typeof T3poChannel.Type)[];
  tasks: readonly TaskRecord[];
  nextCursor: number | null;
};
const encodeUnknownJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const decodeResults = Schema.decodeEffect(Schema.Array(T3poResult));

export class Store extends Context.Service<
  Store,
  {
    readonly memoryDeliveryLock: Effect.Effect<Semaphore.Semaphore>;
    readonly runMemoryWorker: Effect.Effect<never>;
    readonly context: (
      projectId: ProjectId,
      threadId: ThreadId,
      query?: string,
    ) => Effect.Effect<string, T3poError>;
    readonly read: Effect.Effect<Page, T3poError>;
    readonly list: (input: T3poQuery) => Effect.Effect<Page, T3poError>;
    readonly results: (
      input: T3poResultsQuery,
      pageSize?: 1 | 10,
    ) => Effect.Effect<T3poResultsPage, T3poError>;
    readonly getTask: (id: string, projectId: ProjectId) => Effect.Effect<TaskRecord, T3poError>;
    readonly getTaskProject: (threadId: ThreadId) => Effect.Effect<ProjectId | null, T3poError>;
    readonly controlMemory: (input: T3poMemoryControl) => Effect.Effect<void, T3poError>;
    readonly mutate: (input: T3poMutation, reviewedRunId?: RunId) => Effect.Effect<void, T3poError>;
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
  const exchangeMemory = Effect.fn("T3poStore.exchangeMemory")(function* (
    projectId: ProjectId,
    query: string,
    background = false,
  ) {
    const pending =
      yield* sql<MemoryBridge.MemoryEvent>`SELECT event_id AS id, kind, text, occurred_at AS occurredAt FROM t3po_memory_events WHERE project_id = ${projectId} AND synced_at IS NULL AND superseded_by IS NULL AND kind != 'local_correction' ORDER BY sequence LIMIT 20`;
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
          yield* sql`UPDATE t3po_memory_events SET synced_at = ${stamp} WHERE project_id = ${projectId} AND synced_at IS NULL AND event_id IN ${sql.in(accepted)}`;
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
    }>`SELECT e.project_id AS projectId, COALESCE(s.next_attempt, 0) AS nextAttempt FROM t3po_memory_events e LEFT JOIN t3po_memory_status s ON s.project_id = e.project_id WHERE e.synced_at IS NULL AND e.superseded_by IS NULL AND e.kind != 'local_correction' GROUP BY e.project_id ORDER BY nextAttempt, e.project_id LIMIT 1`;
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
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`INSERT INTO t3po_memory_events (event_id, project_id, kind, text, occurred_at) VALUES (lower(hex(randomblob(16))), ${projectId}, ${kind}, ${text.slice(0, 12000)}, ${now})`;
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
      // Completed runs and final messages are already durable; keep one source of result history.
      const rows = yield* sql<{
        runId: string;
        runOrdinal: number;
        messageId: string;
        completedAt: string;
        checkpointId: string | null;
        text: string;
        textLength: number;
      }>`SELECT r.run_id AS runId, r.ordinal AS runOrdinal,
          json_extract(i.payload_json, '$.messageId') AS messageId,
          r.completed_at AS completedAt,
          json_extract(r.payload_json, '$.checkpointId') AS checkpointId,
          substr(COALESCE(json_extract(m.payload_json, '$.text'), json_extract(i.payload_json, '$.text'), ''), 1, 12000) AS text,
          length(COALESCE(json_extract(m.payload_json, '$.text'), json_extract(i.payload_json, '$.text'), '')) AS textLength
        FROM orchestration_v2_projection_runs r
        JOIN orchestration_v2_projection_turn_items i ON i.turn_item_id = (
          SELECT candidate.turn_item_id FROM orchestration_v2_projection_turn_items candidate
          WHERE candidate.run_id = r.run_id AND candidate.thread_id = r.thread_id
            AND candidate.type = 'assistant_message' AND candidate.status = 'completed'
            AND COALESCE(json_extract(candidate.payload_json, '$.streaming'), 0) = 0
            AND (json_extract(candidate.payload_json, '$.phase') IS NULL OR json_extract(candidate.payload_json, '$.phase') = 'final_answer')
          ORDER BY candidate.ordinal DESC, candidate.turn_item_id DESC LIMIT 1
        )
        LEFT JOIN orchestration_v2_projection_messages m ON m.message_id = json_extract(i.payload_json, '$.messageId') AND m.thread_id = r.thread_id
        WHERE r.thread_id = ${task.threadId} AND r.status = 'completed' AND r.completed_at IS NOT NULL
          ${input.before === undefined ? sql`` : sql`AND r.ordinal < ${input.before}`}
        ORDER BY r.ordinal DESC LIMIT ${pageSize + 1}`;
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
      const filters = [
        projectFilter,
        sql`COALESCE(json_extract(data, '$.archived'), 0) = ${input.view === "archived" ? 1 : 0}`,
      ];
      if (input.view !== "archived" && input.view !== "outputs" && input.view !== "all")
        filters.push(
          sql`json_extract(data, '$.completed') = ${input.view === "completed" ? 1 : 0}`,
        );
      if (input.view === "active" || input.view === "up_next" || input.view === "outputs") {
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
        available: number | null;
        lastCheckedAt: string | null;
      }>`SELECT l.project_id AS projectId, s.available, s.last_sync_at AS lastCheckedAt, (SELECT count(*) FROM t3po_memory_events e WHERE e.project_id = l.project_id AND e.synced_at IS NULL AND e.superseded_by IS NULL AND e.kind != 'local_correction') AS pending FROM t3po_leads l LEFT JOIN t3po_memory_status s ON s.project_id = l.project_id WHERE ${input.projectId ? sql`l.project_id = ${input.projectId}` : sql`1 = 1`}`;
      const processing = yield* memory.statuses;
      return {
        spaceConnections: yield* sql<
          typeof T3poSpaceConnection.Type
        >`SELECT source_space_id AS sourceSpaceId, target_space_id AS targetSpaceId, target_project_id AS targetProjectId FROM t3po_space_connections`,
        sharedResources: yield* sql<
          typeof T3poSharedResource.Type
        >`SELECT id, owner_space_id AS ownerSpaceId, target_space_id AS targetSpaceId, name, location FROM t3po_shared_resources`,
        spaces: yield* sql<T3poSpace>`SELECT id, name, rules FROM t3po_spaces ORDER BY rowid`,
        projectSpaces: yield* sql<
          typeof T3poProjectSpace.Type
        >`SELECT project_id AS projectId, space_id AS spaceId FROM t3po_project_spaces WHERE ${projectFilter}`,
        conversations: yield* sql<
          typeof T3poConversation.Type
        >`SELECT project_id AS projectId, thread_id AS threadId, channel_id AS channelId FROM t3po_conversations WHERE ${projectFilter}`,
        workstreams: yield* Effect.forEach(workstreams, (row) => decodeWorkstream(row.data)),
        memory: memoryRows.map((row) => ({
          ...row,
          projectId: ProjectId.make(row.projectId),
          processing: processing[row.projectId],
          configured: memory.configured,
          available: memory.configured && row.available === 1,
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
  const mutate = Effect.fn("T3poStore.mutate")(
    function* (input: T3poMutation, reviewedRunId?: RunId) {
      if (input.type === "memory_control") return yield* new T3poError({ operation: "invalid" });
      const now = DateTime.formatIso(yield* DateTime.now);
      if (input.type === "save_space_rules") {
        const existing = yield* sql`SELECT id FROM t3po_spaces WHERE id = ${input.id}`;
        if (!existing.length) return yield* new T3poError({ operation: "invalid" });
        yield* sql`UPDATE t3po_spaces SET rules = ${input.rules} WHERE id = ${input.id}`;
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
      } else if (input.type === "move_job") {
        const task = yield* getTask(input.id, input.projectId);
        const rows =
          yield* sql`SELECT id FROM t3po_workstreams WHERE id = ${input.workstreamId} AND project_id = ${input.projectId} AND channel_id IS ${task.channelId} AND json_extract(data, '$.state') != 'archived'`;
        if (!rows.length) return yield* new T3poError({ operation: "invalid" });
        yield* sql`UPDATE t3po_tasks SET data = json_set(data, '$.workstreamId', ${input.workstreamId}) WHERE id = ${task.id}`;
        yield* sql`UPDATE t3po_work_routes SET workstream_id = ${input.workstreamId} WHERE job_id = ${task.id}`;
      } else if (input.type === "save_budget") {
        yield* sql`INSERT INTO t3po_budgets (project_id, max_runs, max_concurrent) VALUES (${input.projectId}, ${input.maxRuns}, ${input.maxConcurrent}) ON CONFLICT(project_id) DO UPDATE SET max_runs = excluded.max_runs, max_concurrent = excluded.max_concurrent`;
      } else if (input.type === "save_lead") {
        const previous = yield* sql<{
          data: string;
        }>`SELECT data FROM t3po_leads WHERE project_id = ${input.projectId}`;
        if (!previous[0] || (yield* decodeT3poLeadJson(previous[0].data)).brief !== input.brief)
          yield* enqueueMemory(input.projectId, "project_brief", input.brief);
        const data: T3poLead = {
          projectId: input.projectId,
          name: input.name,
          brief: input.brief,
          threadId: ThreadId.make(`t3po-lead:${input.projectId}`),
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
        const data: T3poTask = {
          id: input.id,
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
          updated = {
            ...task,
            title: input.title,
            brief: input.brief,
            channelId: input.channelId,
            ...(input.channelId !== task.channelId ? { workstreamId: undefined } : {}),
            ...(input.workspace ? { workspace: input.workspace } : {}),
            ...(input.brief !== task.brief ? { completed: false, reviewedRunId: null } : {}),
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
      const reservation = { ...input, title: task.title, brief: task.brief };
      yield* sql`UPDATE t3po_tasks SET launch = ${yield* encodeT3poLaunchInputJson(reservation)} WHERE id = ${taskId} AND project_id = ${projectId} AND launch IS NULL`;
      const rows = yield* sql<{
        launch: string;
      }>`SELECT launch FROM t3po_tasks WHERE id = ${taskId} AND project_id = ${projectId}`;
      if (!rows[0]) return yield* new T3poError({ operation: "invalid" });
      return yield* decodeT3poLaunchInputJson(rows[0].launch);
    },
    sql.withTransaction,
    Effect.mapError((cause) =>
      isT3poError(cause) ? cause : new T3poError({ operation: "save", cause }),
    ),
  );
  const context = Effect.fn("T3poStore.context")(
    function* (projectId: ProjectId, threadId: ThreadId, query = "") {
      if (
        !threadId.startsWith("t3po-lead:") &&
        !threadId.startsWith("t3po-task:") &&
        !threadId.startsWith("t3po-channel:")
      ) {
        const linked =
          yield* sql`SELECT id FROM t3po_tasks WHERE project_id = ${projectId} AND json_extract(data, '$.threadId') = ${threadId} LIMIT 1`;
        if (linked.length === 0) return "";
      }
      const leads = yield* sql<{
        data: string;
      }>`SELECT data FROM t3po_leads WHERE project_id = ${projectId}`;
      if (!leads[0]) return "";
      const lead = yield* decodeT3poLeadJson(leads[0].data);
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
      const assignment = assignments[0] ? yield* decodeT3poTaskJson(assignments[0].data) : null;
      if (threadId !== lead.threadId && !assignment && !channel) return "";
      let recall = "";
      let memoryAvailable = false;
      if ((threadId === lead.threadId || channel) && memory.configured) {
        const recalled = yield* exchangeMemory(projectId, (query || lead.brief).slice(0, 2000));
        if (!recalled) return "";
        recall = recalled.context;
        memoryAvailable = recalled.available;
      }
      const recentRecords = yield* sql<{
        kind: string;
        text: string;
      }>`SELECT kind, substr(text, 1, 2000) AS text FROM t3po_memory_events WHERE project_id = ${projectId} AND superseded_by IS NULL ORDER BY sequence DESC LIMIT 5`;
      return yield* encodeUnknownJson({
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
        sourceMessages:
          threadId === lead.threadId || channel
            ? yield* sql`SELECT message_id AS id, substr(json_extract(payload_json, '$.text'), 1, 1000) AS text FROM orchestration_v2_projection_messages WHERE thread_id = ${threadId} AND role = 'user' ORDER BY rowid DESC LIMIT 8`
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
          recalledContext: recall,
          recentRecords,
        },
        role: threadId === lead.threadId || channel ? "project lead" : "task worker",
        lead: lead.name,
        projectBrief: lead.brief,
        channel: channel ? { id: channel.id, name: channel.name } : null,
        assignment: assignment?.brief ?? null,
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
    },
    Effect.mapError((cause) => new T3poError({ operation: "read", cause })),
  );
  return Store.of({
    memoryDeliveryLock: Effect.succeed(sends),
    runMemoryWorker,
    controlMemory: memory.control,
    read,
    list,
    results,
    getTask,
    getTaskProject,
    mutate,
    reserveLaunch,
    context,
  });
});
export const layer = Layer.effect(Store, make).pipe(
  Layer.provide(Layer.merge(MemoryBridge.layer, Changes.layer)),
);
