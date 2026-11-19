import { NeedsYou } from "./NeedsYou";
import { ProjectMemory } from "./MemoryInspector";
import { NativeChildren } from "./NativeChildren.tsx";
import { TaskResults } from "./TaskResults";
import { randomUUID } from "../../lib/utils";
import { useAtomValue } from "@effect/atom-react";
import { Link, useNavigate } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import { ArrowUpRightIcon, PlusIcon, CheckIcon, RotateCcwIcon } from "lucide-react";
import { useRef, useState } from "react";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type T3poLead,
  type T3poMutation,
  type T3poTaskView,
  type T3poWorkspace,
  type T3poChannel,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Route } from "../../routes/_chat.index";
import { useProjects } from "../../state/entities";
import { useEnvironments, useEnvironmentProviders } from "../../state/environments";
import { environmentServerConfigsAtom } from "../../state/server";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { t3po } from "../../state/t3po";
import { openCommandPalette } from "../../commandPaletteBus";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { isElectron } from "../../env";

export function ProjectHome() {
  const search = Route.useSearch();
  const projects = useProjects().filter((project) => project.archivedAt == null);
  const { environments } = useEnvironments();
  const selected = projects.find(
    (project) => project.id === search.project && project.environmentId === search.machine,
  );
  const targets = selected
    ? environments.filter((env) => env.environmentId === selected.environmentId)
    : environments;
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden" role="main">
      <WorkspacePageHeader electron={isElectron}>
        <SidebarTrigger />
        <span className="text-sm text-muted-foreground">
          {"T3PO"}
          {" / "}
          {selected?.title ?? <T>Everything</T>}
        </span>
        {selected ? (
          <Button
            variant="ghost"
            size="sm"
            render={
              <Link
                to="/"
                search={{
                  project: selected.id,
                  machine: selected.environmentId,
                  channel: search.channel,
                }}
              />
            }
          >
            <T>Chat</T>
          </Button>
        ) : null}
      </WorkspacePageHeader>
      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-gutter-both">
        <div className="mx-auto max-w-5xl px-5 py-8 sm:px-10 sm:py-12">
          <div className="mb-9 flex items-start justify-between gap-4">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-widest text-primary">
                <T>Your project team</T>
              </p>
              <h1 className="text-3xl font-semibold tracking-tight">
                {selected?.title ?? <T>Everything</T>}
              </h1>
              <p className="mt-3 text-sm text-muted-foreground">
                {selected ? (
                  <T>One lead. Shared context. Work that carries forward.</T>
                ) : (
                  <T>Work in motion, next steps, and decisions that need you.</T>
                )}
              </p>
            </div>
            <Button variant="outline" onClick={() => openCommandPalette({ open: "add-project" })}>
              <PlusIcon className="size-4" />
              <T>Add project</T>
            </Button>
          </div>
          {search.project && !selected ? (
            <p role="status">
              <T>This project is unavailable. Choose a project from the sidebar.</T>
            </p>
          ) : null}
          {projects.length === 0 ? (
            <div className="rounded-2xl border border-dashed p-10 text-center">
              <h2 className="text-lg font-medium">
                <T>Give your first lead a project</T>
              </h2>
              <p className="mt-2 text-sm text-muted-foreground">
                <T>Add a workspace folder to start organizing its work.</T>
              </p>
            </div>
          ) : null}
          {targets.map((env) => (
            <ProjectBoard
              key={`${env.environmentId}:${selected?.id ?? "all"}:${search.channel ?? "all"}`}
              environmentId={env.environmentId}
              projectId={selected?.id ?? null}
              title={selected?.title ?? env.label}
              channelId={selected ? (search.channel ?? null) : null}
            />
          ))}
        </div>
      </div>
    </SidebarInset>
  );
}

export function ProjectBoard({
  environmentId,
  projectId,
  title,
  channelId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | null;
  title: string;
  channelId: string | null;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const [tab, setTab] = useState<"active" | "up_next" | "outputs" | "completed" | "archived">(
    "active",
  );
  const [cursors, setCursors] = useState<number[]>([]);
  const query = useEnvironmentQuery(
    t3po.snapshot({
      environmentId,
      input: {
        ...(projectId ? { projectId } : {}),
        ...(channelId ? { channelId } : {}),
        view: tab,
        ...(cursors.length ? { before: cursors[cursors.length - 1]! } : {}),
      },
    }),
  );
  const mutate = useAtomCommand(t3po.mutate);
  const launch = useAtomCommand(t3po.launch);
  const canMutate = useAtomValue(t3po.mutate.permissionAtom(environmentId));
  const canLaunch = useAtomValue(t3po.launch.permissionAtom(environmentId));
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const config = useAtomValue(environmentServerConfigsAtom).get(environmentId);
  const projects = useProjects();
  const project = projects.find(
    (project) => project.id === projectId && project.environmentId === environmentId,
  );
  const defaultModel =
    project?.defaultModelSelection ??
    resolveProjectDefaultProviderModelSelection(
      providers,
      config?.settings ?? DEFAULT_SERVER_SETTINGS,
      projectId,
    );
  const [model, setModel] = useState<ModelSelection | null>(null);
  const selectedModel = model ?? defaultModel;

  const [editingTask, setEditingTask] = useState<T3poTaskView | null>(null);
  const [memoryOpen, setMemoryOpen] = useState(false);
  const budgetControl = useRef<HTMLInputElement>(null);
  const memoryControl = useRef<HTMLDivElement>(null);
  const [form, setForm] = useState<"lead" | "task" | "channel" | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const lead = query.data?.leads.find((lead) => lead.projectId === projectId);
  const memory = query.data?.memory.find((entry) => entry.projectId === projectId);
  const channels =
    query.data?.channels.filter(
      (channel) => channel.projectId === projectId && !channel.archived,
    ) ?? [];
  const projectTasks =
    query.data?.tasks.filter((task) => projectId === null || task.projectId === projectId) ?? [];
  const tasks = projectTasks.filter((task) => channelId === null || task.channelId === channelId);
  const visibleTasks = tasks;
  async function save(input: T3poMutation) {
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({ environmentId, input });
      if (result._tag !== "Success") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
        setBusy(false);
        return;
      }
      setForm(null);
      setEditingTask(null);
      query.refresh();
      if (input.type === "create_task") {
        setTab("up_next");
        setCursors([]);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
    }
    setBusy(false);
  }
  async function openLeadOrTask(targetProject: ProjectId, task?: T3poTaskView) {
    if (!selectedModel) {
      setError(gt("Configure a provider in Settings before starting work."));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await launch({
        environmentId,
        input: {
          projectId: targetProject,
          ...(task ? { taskId: task.id } : {}),
          modelSelection: selectedModel,
          runtimeMode: "approval-required",
        },
      });
      if (result._tag !== "Success") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
        setBusy(false);
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: result.value.threadId },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not start work."));
    }
    setBusy(false);
  }
  return (
    <section className="mb-10 space-y-6" aria-label={title}>
      {!projectId ? <h2 className="text-sm font-medium text-muted-foreground">{title}</h2> : null}
      {query.error ? (
        <div role="alert" className="rounded-xl border border-destructive/30 p-4 text-sm">
          {query.error}
          <div className="mt-3">
            <Button variant="outline" onClick={query.refresh}>
              <T>Retry</T>
            </Button>
          </div>
        </div>
      ) : null}
      {query.isPending && !query.data ? (
        <p role="status" className="text-sm text-muted-foreground">
          <T>Loading project work…</T>
        </p>
      ) : null}
      {projectId && query.data ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-2xl border bg-muted/20 p-5">
            <div className="flex items-center gap-4">
              <div>
                <h2 className="font-medium">{lead?.name ?? gt("Set up your project lead")}</h2>
                <p className="mt-1 max-w-lg whitespace-pre-wrap text-sm text-muted-foreground">
                  {lead?.brief ||
                    gt("Give your lead the goals and context it should keep in mind.")}
                </p>
                {lead ? (
                  <p className="mt-2 text-xs text-muted-foreground" role="status">
                    {!memory?.configured ? (
                      <T>Memory: local continuity</T>
                    ) : memory.available ? (
                      <T>Memory: connected</T>
                    ) : (
                      <T>
                        Memory: recall unavailable or not yet checked; local continuity retained
                      </T>
                    )}
                    {memory?.configured && memory.pending > 0 ? (
                      <> · {gt("{count} records awaiting sync", { count: memory.pending })}</>
                    ) : null}
                  </p>
                ) : null}
                {lead && memory?.configured ? (
                  <div className="mt-2 space-y-2">
                    {memory.processing ? (
                      <p className="text-xs text-muted-foreground" role="status">
                        {memory.processing.paused
                          ? gt("Memory processing paused")
                          : gt("Memory processing enabled")}
                        {" · "}
                        {gt("{count} queued", { count: memory.processing.counts.queued ?? 0 })}
                        {" · "}
                        {gt("{count} processing", {
                          count: memory.processing.counts.processing ?? 0,
                        })}
                        {" · "}
                        {gt("{count} need retry", { count: memory.processing.counts.failed ?? 0 })}
                      </p>
                    ) : null}
                    <p className="text-xs text-muted-foreground">
                      <T>
                        Processing controls apply to all projects using this memory service. Refresh
                        to check current status.
                      </T>
                    </p>
                    <div className="flex gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!canMutate || busy}
                        onClick={() =>
                          void save({ type: "memory_control", projectId, action: "refresh" })
                        }
                      >
                        <T>Refresh memory status</T>
                      </Button>
                      {memory.processing ? (
                        <>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!canMutate || busy}
                            onClick={() =>
                              void save({
                                type: "memory_control",
                                projectId,
                                action: memory.processing?.paused ? "resume" : "pause",
                              })
                            }
                          >
                            {memory.processing.paused ? <T>Resume memory</T> : <T>Pause memory</T>}
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={!canMutate || busy}
                            onClick={() =>
                              void save({ type: "memory_control", projectId, action: "retry" })
                            }
                          >
                            <T>Retry memory jobs</T>
                          </Button>
                        </>
                      ) : null}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
            <div className="flex gap-2">
              <Button
                variant="outline"
                disabled={!canMutate || busy}
                onClick={() => setForm("lead")}
              >
                {lead ? <T>Edit lead</T> : <T>Set up lead</T>}
              </Button>
              {lead ? (
                <Button
                  disabled={!canLaunch || busy || !selectedModel}
                  onClick={() => void openLeadOrTask(projectId)}
                >
                  <T>Talk to lead</T>
                  <ArrowUpRightIcon className="size-4" />
                </Button>
              ) : null}
            </div>
          </div>
          <ProjectAttention
            environmentId={environmentId}
            projectId={projectId}
            onOpenProject={(target) => {
              if (target === "memory") setMemoryOpen(true);
              const control = target === "budget" ? budgetControl.current : memoryControl.current;
              control?.scrollIntoView({ block: "center" });
              control?.focus({ preventScroll: true });
            }}
          />
          <div ref={memoryControl} tabIndex={-1}>
            <ProjectMemory
              environmentId={environmentId}
              projectId={projectId}
              open={memoryOpen}
              onOpenChange={setMemoryOpen}
            />
          </div>
          {lead ? (
            <NativeChildren
              environmentId={environmentId}
              threadId={lead.threadId}
              parentTitle={lead.name}
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant={channelId === null ? "secondary" : "ghost"}
              render={
                <Link
                  to="/"
                  search={{ project: projectId, machine: environmentId, view: "board" }}
                />
              }
            >
              <T>All channels</T>
            </Button>
            {channels.map((channel) => (
              <Button
                key={channel.id}
                variant={channel.id === channelId ? "secondary" : "ghost"}
                render={
                  <Link
                    to="/"
                    search={{
                      project: projectId,
                      machine: environmentId,
                      channel: channel.id,
                      view: "board",
                    }}
                  />
                }
              >
                # {channel.name}
              </Button>
            ))}
            <Button
              variant="ghost"
              disabled={!canMutate || busy}
              onClick={() => setForm("channel")}
            >
              <PlusIcon className="size-4" />
              <T>New channel</T>
            </Button>
          </div>
          <form
            key={`budget:${projectId}:${lead?.budget?.maxRuns}:${lead?.budget?.maxConcurrent}`}
            className="flex flex-wrap items-end gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              void save({
                type: "save_budget",
                projectId,
                maxRuns: Number(data.get("maxRuns")),
                maxConcurrent: Number(data.get("maxConcurrent")),
              });
            }}
          >
            <label className="text-xs">
              <T>Task run budget</T>
              <input
                className="block w-32 rounded border bg-background p-2"
                ref={budgetControl}
                name="maxRuns"
                type="number"
                min="0"
                step="1"
                required
                defaultValue={lead?.budget?.maxRuns}
                disabled={!canMutate || busy}
              />
            </label>
            <label className="text-xs">
              <T>Concurrent task runs</T>
              <input
                className="block w-32 rounded border bg-background p-2"
                name="maxConcurrent"
                type="number"
                min="0"
                step="1"
                required
                defaultValue={lead?.budget?.maxConcurrent}
                disabled={!canMutate || busy}
              />
            </label>
            <Button type="submit" variant="outline" disabled={!canMutate || busy || !lead}>
              <T>Save budget</T>
            </Button>
            <p className="text-xs text-muted-foreground">
              {lead?.budget ? (
                gt("{used} runs used; {active} active", {
                  used: lead.budget.usedRuns,
                  active: lead.budget.activeRuns,
                })
              ) : (
                <T>Set a budget before starting tasks</T>
              )}
            </p>
          </form>
          {form ? (
            <WorkForm
              key={`${form}:${lead?.name}`}
              kind={form}
              lead={lead}
              projectTitle={title}
              busy={busy}
              onCancel={() => setForm(null)}
              channels={channels}
              initialChannelId={channelId}
              onSave={(name, brief, id, selectedChannelId, workspace) =>
                void save(
                  form === "lead"
                    ? { type: "save_lead", projectId, name, brief }
                    : form === "channel"
                      ? { type: "create_channel", projectId, id, name }
                      : {
                          type: "create_task",
                          projectId,
                          id,
                          channelId: selectedChannelId,
                          workspace,
                          title: name,
                          brief,
                        },
                )
              }
            />
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <T>Model for new work</T>
              <select
                aria-label={gt("Model for new work")}
                className="max-w-60 rounded-lg border bg-background p-2 text-foreground"
                value={selectedModel ? `${selectedModel.instanceId}/${selectedModel.model}` : ""}
                onChange={(event) => {
                  const option = providers
                    .flatMap((provider) =>
                      provider.models.map((model) => ({
                        instanceId: provider.instanceId,
                        model: model.slug,
                      })),
                    )
                    .find((model) => `${model.instanceId}/${model.model}` === event.target.value);
                  if (option) setModel(option);
                }}
              >
                <option value="" disabled>
                  {gt("Choose a model")}
                </option>
                {providers
                  .filter(
                    (provider) => provider.status !== "disabled" && provider.status !== "error",
                  )
                  .flatMap((provider) =>
                    provider.models.map((model) => (
                      <option
                        key={`${provider.instanceId}/${model.slug}`}
                        value={`${provider.instanceId}/${model.slug}`}
                      >
                        {provider.displayName ?? provider.driver} · {model.name}
                      </option>
                    )),
                  )}
              </select>
            </label>
            <Button
              disabled={
                !canMutate ||
                !lead ||
                busy ||
                (!!channelId && !channels.some((channel) => channel.id === channelId))
              }
              onClick={() => setForm("task")}
            >
              <PlusIcon className="size-4" />
              <T>New task</T>
            </Button>
          </div>
        </>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div
        className="flex flex-wrap gap-1 border-b pb-3"
        role="tablist"
        aria-label={gt("Project work")}
      >
        {(
          [
            ["active", gt("Active")],
            ["up_next", gt("Up next")],
            ["outputs", gt("Outputs")],
            ["completed", gt("Completed")],
            ["archived", gt("Archived")],
          ] as const
        ).map(([value, label]) => (
          <Button
            key={value}
            role="tab"
            aria-selected={tab === value}
            variant={tab === value ? "secondary" : "ghost"}
            onClick={() => {
              setTab(value);
              setCursors([]);
            }}
          >
            {label}
          </Button>
        ))}
      </div>
      <div className="space-y-3" role="tabpanel">
        {visibleTasks.map((task) => (
          <article key={task.id} className="rounded-2xl border p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p
                  className={`mb-2 text-xs font-medium ${task.status === "ready_for_review" ? "text-success" : task.status === "needs_you" ? "text-primary" : "text-muted-foreground"}`}
                >
                  {
                    {
                      up_next: gt("Up next"),
                      active: gt("In progress"),
                      needs_you: gt("Needs you"),
                      ready_for_review: gt("Ready for review"),
                      completed: gt("Completed"),
                    }[task.status]
                  }
                </p>
                <h3 className="font-medium">{task.title}</h3>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="ghost"
                  disabled={!canMutate || busy}
                  onClick={() => setEditingTask(task)}
                >
                  <T>Edit</T>
                </Button>
                <Button
                  variant="ghost"
                  disabled={!canMutate || busy || (!task.archived && task.status === "active")}
                  onClick={() =>
                    void save({
                      type: "archive_task",
                      projectId: task.projectId,
                      id: task.id,
                      archived: !task.archived,
                    })
                  }
                >
                  {task.archived ? <T>Restore</T> : <T>Archive</T>}
                </Button>
                {task.executionExists ? (
                  <Button
                    variant="outline"
                    render={
                      <Link
                        to="/$environmentId/$threadId"
                        params={{ environmentId, threadId: task.threadId }}
                      />
                    }
                  >
                    <T>Open work</T>
                    <ArrowUpRightIcon className="size-4" />
                  </Button>
                ) : (
                  <Button
                    disabled={!canLaunch || busy || !selectedModel || !!task.archived}
                    onClick={() => void openLeadOrTask(task.projectId, task)}
                  >
                    <T>Start task</T>
                  </Button>
                )}
              </div>
            </div>
            <NativeChildren
              environmentId={environmentId}
              threadId={task.threadId}
              parentTitle={task.title}
            />
            {tab === "outputs" ? (
              <TaskResults task={task} environmentId={environmentId} />
            ) : (
              <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{task.brief}</p>
            )}
            <p className="mt-2 break-all text-xs text-muted-foreground">
              {task.workspacePath ??
                (task.workspace?.type === "worktree"
                  ? gt("Isolated worktree · created at launch")
                  : gt("Project folder"))}
              {task.branch ? ` · ${task.branch}` : ""}
            </p>
            {editingTask?.id === task.id ? (
              <WorkForm
                key={task.id}
                kind="task"
                task={editingTask}
                lead={undefined}
                projectTitle={title}
                channels={
                  query.data?.channels.filter((channel) => channel.projectId === task.projectId) ??
                  []
                }
                initialChannelId={task.channelId}
                busy={busy}
                onCancel={() => setEditingTask(null)}
                onSave={(name, brief, id, selectedChannelId, workspace) =>
                  void save({
                    type: "edit_task",
                    projectId: task.projectId,
                    id,
                    title: name,
                    brief,
                    channelId: selectedChannelId,
                    ...(!task.workspaceLocked ? { workspace } : {}),
                  })
                }
              />
            ) : null}
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
              <Link
                to="/"
                search={{
                  view: "board",
                  project: task.projectId,
                  machine: environmentId,
                  ...(task.channelId ? { channel: task.channelId } : {}),
                }}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                {
                  projects.find(
                    (project) =>
                      project.id === task.projectId && project.environmentId === environmentId,
                  )?.title
                }{" "}
                {task.channelId
                  ? ` / #${query.data?.channels.find((channel) => channel.id === task.channelId)?.name ?? ""}`
                  : ""}
              </Link>
              {task.status === "ready_for_review" || task.status === "completed" ? (
                <Button
                  variant="ghost"
                  disabled={!canMutate || busy}
                  onClick={() =>
                    void save({
                      type: "review_task",
                      projectId: task.projectId,
                      id: task.id,
                      completed: task.status !== "completed",
                    })
                  }
                >
                  {task.status === "completed" ? (
                    <>
                      <RotateCcwIcon className="size-4" />
                      <T>Reopen</T>
                    </>
                  ) : (
                    <>
                      <CheckIcon className="size-4" />
                      <T>Mark complete</T>
                    </>
                  )}
                </Button>
              ) : null}
            </div>
          </article>
        ))}
        {query.data && visibleTasks.length === 0 ? (
          <div className="rounded-2xl border border-dashed px-6 py-12 text-center">
            <p className="font-medium">
              {tab === "up_next" ? gt("What should we take on next?") : gt("Nothing here yet")}
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              {tab === "up_next"
                ? gt("Add a task with a clear outcome, then start it when you’re ready.")
                : gt("Tasks and their results will appear here as work progresses.")}
            </p>
          </div>
        ) : null}
      </div>
      <div className="flex justify-end gap-2">
        <Button
          variant="outline"
          disabled={!cursors.length || query.isPending}
          onClick={() => setCursors((previous) => previous.slice(0, -1))}
        >
          <T>Previous</T>
        </Button>
        <Button
          variant="outline"
          disabled={query.data?.nextCursor == null || query.isPending}
          onClick={() => {
            if (query.data?.nextCursor != null)
              setCursors((previous) => [...previous, query.data!.nextCursor!]);
          }}
        >
          <T>Next</T>
        </Button>
      </div>
    </section>
  );
}

function WorkForm({
  kind,
  lead,
  projectTitle,
  task,
  channels,
  initialChannelId,
  busy,
  onCancel,
  onSave,
}: {
  kind: "lead" | "task" | "channel";
  lead: T3poLead | undefined;
  projectTitle: string;
  task?: T3poTaskView;
  channels: readonly (typeof T3poChannel.Type)[];
  initialChannelId: string | null;
  busy: boolean;
  onCancel: () => void;
  onSave: (
    name: string,
    brief: string,
    id: string,
    channelId: string | null,
    workspace: T3poWorkspace,
  ) => void;
}) {
  const gt = useGT();
  const [id] = useState(() => task?.id ?? randomUUID());
  const [name, setName] = useState(
    task?.title ?? (kind === "lead" ? (lead?.name ?? `${projectTitle} T3PO`) : ""),
  );
  const [brief, setBrief] = useState(task?.brief ?? (kind === "lead" ? (lead?.brief ?? "") : ""));
  const [channel, setChannel] = useState(initialChannelId ?? "");
  const [workspaceType, setWorkspaceType] = useState(
    task?.workspace?.type ?? (task ? "root" : "worktree"),
  );
  const [baseRef, setBaseRef] = useState(
    task?.workspace?.type === "worktree" ? (task.workspace.baseRef ?? "") : "",
  );
  const [fetchBase, setFetchBase] = useState(
    task?.workspace?.type === "worktree" ? (task.workspace.startFromOrigin ?? true) : true,
  );
  return (
    <form
      className="space-y-4 rounded-2xl border bg-muted/10 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        onSave(
          name.trim(),
          brief.trim(),
          id,
          channel || null,
          workspaceType === "root"
            ? { type: "root" }
            : {
                type: "worktree",
                ...(baseRef.trim() ? { baseRef: baseRef.trim(), startFromOrigin: fetchBase } : {}),
              },
        );
      }}
    >
      <label className="block space-y-2 text-sm">
        <span>
          {kind === "lead"
            ? gt("Lead name")
            : kind === "channel"
              ? gt("Channel name")
              : gt("Task title")}
        </span>
        <Input
          required
          maxLength={200}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {kind !== "channel" ? (
        <label className="block space-y-2 text-sm">
          <span>
            {kind === "lead" ? gt("Project goals and context") : gt("Brief and expected outcome")}
          </span>
          <Textarea
            rows={4}
            required={kind === "task"}
            maxLength={12000}
            value={brief}
            onChange={(event) => setBrief(event.target.value)}
          />
        </label>
      ) : null}
      {kind === "task" ? (
        <div className="space-y-3 text-sm">
          <label className="block space-y-2">
            <span>
              <T>Channel</T>
            </span>
            <select
              className="block w-full rounded-md border bg-background p-2"
              value={channel}
              onChange={(event) => setChannel(event.target.value)}
            >
              <option value="">{gt("No channel")}</option>
              {channels
                .filter((item) => !item.archived || item.id === channel)
                .map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
            </select>
          </label>
          <label className="block space-y-2">
            <span>
              <T>Workspace</T>
            </span>
            <select
              className="block w-full rounded-md border bg-background p-2"
              disabled={task?.workspaceLocked}
              value={workspaceType}
              onChange={(event) =>
                setWorkspaceType(event.target.value === "root" ? "root" : "worktree")
              }
            >
              <option value="worktree">{gt("Isolated worktree")}</option>
              <option value="root">{gt("Project folder")}</option>
            </select>
          </label>
          {workspaceType === "worktree" && !task?.workspaceLocked ? (
            <>
              <label className="block space-y-2">
                <span>
                  <T>Base branch or commit</T>
                </span>
                <Input
                  value={baseRef}
                  onChange={(event) => setBaseRef(event.target.value)}
                  placeholder={gt("Default branch")}
                />
              </label>
              {baseRef.trim() ? (
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={fetchBase}
                    onChange={(event) => setFetchBase(event.target.checked)}
                  />
                  <T>Fetch remote base</T>
                </label>
              ) : null}
              <p className="text-xs text-muted-foreground">
                <T>
                  Worktrees start from committed files. Uncommitted changes in the project folder
                  are not copied.
                </T>
              </p>
            </>
          ) : null}
          {task?.workspaceLocked ? (
            <p className="text-xs text-muted-foreground">
              <T>
                Workspace is fixed after launch. Brief changes apply to the next turn; the current
                run is not interrupted.
              </T>
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          <T>Cancel</T>
        </Button>
        <Button type="submit" disabled={busy || !name.trim() || (kind === "task" && !brief.trim())}>
          <T>Save</T>
        </Button>
      </div>
    </form>
  );
}

function ProjectAttention({
  environmentId,
  projectId,
  onOpenProject,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  onOpenProject: (target: "budget" | "memory") => void;
}) {
  const [before, setBefore] = useState<number | undefined>();
  const navigate = useNavigate();
  const query = useEnvironmentQuery(
    t3po.attention({
      environmentId,
      input: { projectId, ...(before === undefined ? {} : { before }) },
    }),
  );
  return (
    <NeedsYou
      onOpenProject={onOpenProject}
      {...(query.data ? { page: query.data } : {})}
      {...(query.error ? { error: query.error } : {})}
      onPage={(cursor) => {
        setBefore(cursor);
        query.refresh();
      }}
      onOpen={(item) => {
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: item.threadId },
        });
      }}
    />
  );
}
