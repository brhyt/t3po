import {
  ThreadId,
  CommandId,
  T3poError,
  isT3poError,
  type T3poLaunchInput,
  type T3poLaunchResult,
  type T3poMutation,
  type T3poSnapshot,
  type ProjectId,
  type T3poTaskView,
  type T3poQuery,
  type T3poResultsQuery,
  type T3poResultsPage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as PubSub from "effect/PubSub";
import * as Changes from "./Changes.ts";
import * as ApplicationEvents from "../persistence/OrchestrationEventStore.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as Store from "./Store.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import { taskStatus } from "./TaskStatus.ts";

export class Service extends Context.Service<
  Service,
  {
    readonly snapshot: (input: T3poQuery) => Effect.Effect<typeof T3poSnapshot.Type, T3poError>;
    readonly results: (input: T3poResultsQuery) => Effect.Effect<T3poResultsPage, T3poError>;
    readonly subscribe: (input: T3poQuery) => Stream.Stream<number, T3poError>;
    readonly mutate: (input: T3poMutation) => Effect.Effect<void, T3poError>;
    readonly launch: (
      input: T3poLaunchInput,
    ) => Effect.Effect<typeof T3poLaunchResult.Type, T3poError>;
  }
>()("t3/t3po/Service") {}

const make = Effect.gen(function* () {
  const store = yield* Store.Store;
  const changes = yield* Changes.Changes;
  const events = yield* ApplicationEvents.OrchestrationEventStore;
  const git = yield* GitWorkflow.GitWorkflowService;
  const projects = yield* ProjectService.ProjectService;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const requireProject = Effect.fn("T3po.requireProject")(function* (projectId: ProjectId) {
    const project = yield* projects.getById(projectId);
    if (Option.isNone(project)) return yield* new T3poError({ operation: "invalid" });
    return project.value;
  });
  const snapshot = Effect.fn("T3po.snapshot")(
    function* (input: T3poQuery) {
      if (input.projectId) yield* requireProject(input.projectId);
      const records = yield* store.list(input);
      const projectRecords = yield* projects.listShells();
      const activeProjects = new Set(projectRecords.map((project) => project.id));
      const tasks = yield* Effect.forEach(
        records.tasks.filter((task) => activeProjects.has(task.projectId)),
        (task) =>
          Effect.gen(function* () {
            const shell = yield* threads.getThreadShell(task.threadId);
            const latestResult =
              (yield* store.results({ projectId: task.projectId, taskId: task.id }, 1))
                .results[0] ?? null;
            return {
              ...task,
              status:
                task.dispatch?.state === "blocked"
                  ? "needs_you"
                  : task.dispatch?.state === "queued" && !shell?.activeRunId
                    ? "up_next"
                    : taskStatus(task.completed, shell, task.reviewedRunId, task.reviewRequired),
              executionExists: shell !== null,
              workspaceLocked: task.workspaceLocked || shell !== null,
              workspacePath: shell
                ? (shell.worktreePath ??
                  (task.workspace?.type === "worktree"
                    ? null
                    : (projectRecords.find((project) => project.id === task.projectId)
                        ?.workspaceRoot ?? null)))
                : null,
              branch: shell?.branch ?? null,
              latestResult,
            } satisfies T3poTaskView;
          }),
        { concurrency: 8 },
      );
      return {
        externalBindings: records.externalBindings,
        spaceConnections: records.spaceConnections,
        sharedResources: records.sharedResources,
        spaces: records.spaces,
        projectSpaces: records.projectSpaces,
        conversations: records.conversations.filter((record) =>
          activeProjects.has(record.projectId),
        ),
        workstreams: records.workstreams.filter((stream) => activeProjects.has(stream.projectId)),
        memory: records.memory.filter((record) => activeProjects.has(record.projectId)),
        nextCursor: records.nextCursor,
        leads: records.leads.filter((lead) => activeProjects.has(lead.projectId)),
        channels: records.channels.filter((channel) => activeProjects.has(channel.projectId)),
        tasks,
      };
    },
    Effect.mapError((cause) =>
      isT3poError(cause) ? cause : new T3poError({ operation: "read", cause }),
    ),
  );
  const results = Effect.fn("T3po.results")(
    function* (input: T3poResultsQuery) {
      yield* requireProject(input.projectId);
      return yield* store.results(input);
    },
    Effect.mapError((cause) =>
      isT3poError(cause) ? cause : new T3poError({ operation: "read", cause }),
    ),
  );
  const mutate = Effect.fn("T3po.mutate")(
    function* (input: T3poMutation) {
      yield* requireProject(input.projectId);
      let reviewedRunId;
      if (input.type === "archive_task" && input.archived) {
        const task = yield* store.getTask(input.id, input.projectId);
        const shell = yield* threads.getThreadShell(task.threadId);
        if (
          shell &&
          (shell.activeRunId ||
            (shell.pendingBackgroundTasks?.length ?? 0) > 0 ||
            ["preparing", "queued", "starting", "running", "waiting"].includes(shell.status))
        )
          return yield* new T3poError({ operation: "busy" });
      }
      if (input.type === "edit_task" && input.workspace) {
        const task = yield* store.getTask(input.id, input.projectId);
        if (yield* threads.getThreadShell(task.threadId))
          return yield* new T3poError({ operation: "invalid" });
      }
      if (input.type === "review_task" && input.completed) {
        const task = yield* store.getTask(input.id, input.projectId);
        const shell = yield* threads.getThreadShell(task.threadId);
        if (!shell || taskStatus(false, shell) !== "ready_for_review" || shell.latestRunId === null)
          return yield* new T3poError({ operation: "invalid" });
        reviewedRunId = shell.latestRunId;
      }
      if (input.type === "memory_control") yield* store.controlMemory(input);
      else yield* store.mutate(input, reviewedRunId);
      yield* PubSub.publish(changes, {
        projectId: input.projectId,
        metadata:
          input.type === "save_space_rules" ||
          input.type.endsWith("_resource") ||
          input.type.endsWith("_space") ||
          input.type === "move_conversation" ||
          input.type === "save_budget" ||
          input.type === "save_lead" ||
          input.type === "save_work_model" ||
          input.type === "save_work_access" ||
          input.type === "save_notes" ||
          input.type === "redraw_project_icon" ||
          input.type.endsWith("channel"),
      });
    },
    Effect.mapError((cause) =>
      isT3poError(cause) ? cause : new T3poError({ operation: "save", cause }),
    ),
  );
  const launch = Effect.fn("T3po.launch")(
    function* (input: T3poLaunchInput) {
      const project = yield* requireProject(input.projectId);
      const records = yield* store.list({ projectId: input.projectId, metadataOnly: true });
      let lead = records.leads.find((lead) => lead.projectId === input.projectId);
      if (!lead && input.taskId === undefined) {
        // Opening a project or channel chat starts its lead; it names itself after a few turns.
        yield* mutate({ type: "save_lead", projectId: input.projectId, brief: "" });
        lead = (yield* store.list({ projectId: input.projectId, metadataOnly: true })).leads.find(
          (lead) => lead.projectId === input.projectId,
        );
      }
      const task =
        input.taskId === undefined
          ? undefined
          : yield* store.getTask(input.taskId, input.projectId);
      if (!lead || task?.archived) return yield* new T3poError({ operation: "invalid" });
      if (input.taskId !== undefined && input.channelId !== undefined)
        return yield* new T3poError({ operation: "invalid" });
      const channel =
        input.channelId === undefined
          ? undefined
          : records.channels.find((channel) => channel.id === input.channelId && !channel.archived);
      if (input.channelId !== undefined && !channel)
        return yield* new T3poError({ operation: "invalid" });
      const threadId =
        task?.threadId ?? (channel ? ThreadId.make(`t3po-channel:${channel.id}`) : lead.threadId);
      const existing = yield* threads.getThreadShell(threadId);
      if (existing && (!task || task.id.startsWith("delegation:"))) return { threadId };
      let workspaceStrategy: ThreadLaunch.ThreadLaunchWorkspaceStrategy = { type: "root" };
      if (task?.workspace?.type === "worktree" && !task.workspaceLocked) {
        let baseRef = task.workspace.baseRef;
        let fetchDefault = false;
        if (baseRef === undefined) {
          const refs = yield* git.listRefs({
            cwd: project.workspaceRoot,
            refKind: "local",
            limit: 1,
            refresh: true,
          });
          if (!refs.isRepo) return yield* new T3poError({ operation: "workspace" });
          if (refs.hasPrimaryRemote) {
            const remote = yield* git.resolvePrimaryRemoteName(project.workspaceRoot);
            const branch = yield* git.resolveDefaultBranchName(project.workspaceRoot, remote);
            if (!branch) return yield* new T3poError({ operation: "workspace" });
            baseRef = `${remote}/${branch}`;
            fetchDefault = true;
          } else {
            const branches = yield* git.listLocalBranchNames(project.workspaceRoot);
            baseRef =
              ["main", "master"].find((branch) => branches.includes(branch)) ??
              (branches.length === 1 ? branches[0] : undefined);
            if (!baseRef) return yield* new T3poError({ operation: "workspace" });
          }
        }
        workspaceStrategy = {
          type: "worktree",
          baseRef,
          startFromOrigin: task.workspace.startFromOrigin ?? fetchDefault,
        };
        yield* launcher.checkWorktreeBase({ projectId: input.projectId, workspaceStrategy });
      }
      const selection = task
        ? yield* store.reserveLaunch(
            task.id,
            task.projectId,
            { ...input, workspaceStrategy },
            task.workspace ?? { type: "root" },
          )
        : { ...input, workspaceStrategy };
      yield* launcher.launch({
        commandId: CommandId.make(`t3po-launch:${threadId}`),
        threadId,
        projectId: input.projectId,
        title:
          ("title" in selection ? selection.title : undefined) ??
          task?.title ??
          (channel ? `# ${channel.name}` : lead.name),
        modelSelection: selection.modelSelection,
        runtimeMode: selection.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: selection.workspaceStrategy ?? { type: "root" },
        createdBy: "user",
        creationSource: "web",
        ...(task
          ? {
              initialMessage: {
                ...("messageId" in selection && selection.messageId
                  ? { messageId: selection.messageId }
                  : {}),
                text: ("brief" in selection ? selection.brief : undefined) ?? task.brief,
                attachments: [],
              },
            }
          : {}),
      });
      return { threadId };
    },
    Effect.mapError((cause) =>
      isT3poError(cause) ? cause : new T3poError({ operation: "launch", cause }),
    ),
  );
  const subscribe = (input: T3poQuery) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue = yield* PubSub.subscribe(changes);
        const afterSequence = yield* events.latestApplicationSequence;
        const execution = input.metadataOnly
          ? Stream.empty
          : events.streamApplicationEvents({ afterSequence }).pipe(
              Stream.filter(
                (stored) =>
                  "event" in stored &&
                  (/^(run\.|thread\.|runtime-request\.|plan\.|subagent\.)/.test(
                    stored.event.type,
                  ) ||
                    (stored.event.type === "turn-item.updated" &&
                      stored.event.payload.type === "assistant_message" &&
                      !stored.event.payload.streaming) ||
                    (stored.event.type === "message.updated" &&
                      stored.event.payload.role === "assistant" &&
                      !stored.event.payload.streaming)),
              ),
              Stream.mapEffect((stored) =>
                "event" in stored
                  ? store.getTaskProject(
                      stored.event.type === "subagent.updated" && stored.event.payload.childThreadId
                        ? stored.event.payload.childThreadId
                        : stored.event.threadId,
                    )
                  : Effect.succeed(null),
              ),
              Stream.filter(
                (projectId) =>
                  projectId !== null && (!input.projectId || projectId === input.projectId),
              ),
              Stream.as(undefined),
            );
        return Stream.merge(
          Stream.fromSubscription(queue).pipe(
            Stream.filter(
              (change) =>
                (!input.projectId || change.projectId === input.projectId) &&
                (!input.metadataOnly || change.metadata),
            ),
            Stream.as(undefined),
          ),
          execution,
        ).pipe(
          Stream.debounce("150 millis"),
          Stream.scan(
            () => 0,
            (revision) => revision + 1,
          ),
        );
      }),
    ).pipe(
      Stream.mapError((cause) =>
        isT3poError(cause) ? cause : new T3poError({ operation: "read", cause }),
      ),
    );
  return Service.of({ snapshot, results, mutate, launch, subscribe });
});
export const layer = Layer.unwrap(
  Effect.serviceOption(Store.Store).pipe(
    Effect.map((store) =>
      Layer.effect(Service, make).pipe(
        Layer.provide(Option.isSome(store) ? Layer.succeed(Store.Store, store.value) : Store.layer),
      ),
    ),
  ),
);
