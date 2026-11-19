import { useEnvironmentScope } from "../../state/session";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { projectEnvironment } from "../../state/projects";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import * as Schema from "effect/Schema";
import { readLocalApi } from "../../localApi";
import { contextMenuSourceOf } from "../../contextMenuSource";
import { useRoName } from "./useRoName";
import { useRef, useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, T3poChannel } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { t3po } from "../../state/t3po";
import { randomUUID } from "../../lib/utils";
import { Input } from "../ui/input";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { T, useGT, useMessages } from "gt-react";
import {
  ChevronDownIcon,
  ChevronRightIcon,
  MonitorIcon,
  PlusIcon,
  SettingsIcon,
  FolderIcon,
  HashIcon,
  ArchiveIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useProjects, useThreadShell, useThreadShellsForProjectRefs } from "../../state/entities";
import { openCommandPalette } from "../../commandPaletteBus";
import { Button } from "../ui/button";
import { Tooltip, TooltipTrigger, TooltipPopup } from "../ui/tooltip";
import { SidebarMenuButton, SidebarTrigger, useSidebar } from "../ui/sidebar";
import { t3poSearch } from "./search";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { useEnvironments } from "../../state/environments";
import { useNowMinute } from "../../hooks/useNowMinute";
import { formatRelativeTime } from "../../timestampFormat";
import { projectConversations } from "./projectConversations";

export function ProjectSidebar() {
  const gt = useGT();
  const [roName, setRoName] = useRoName();
  const [renamingRo, setRenamingRo] = useState(false);
  const { environments } = useEnvironments();
  const projects = useProjects().filter((project) => project.archivedAt == null);
  const search = useLocation({ select: (location) => t3poSearch(location.search) });
  const threadRef = resolveThreadRouteRef(useParams({ strict: false }));
  const currentThread = useThreadShell(threadRef);
  const activeSearch = currentThread
    ? { project: currentThread.projectId, machine: currentThread.environmentId }
    : search;
  const { setOpenMobile } = useSidebar();
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-[var(--workspace-topbar-height)] shrink-0 items-center pr-3">
        <Link
          to="/"
          search={{}}
          aria-label="T3PO"
          className="ml-3 inline-flex h-7 items-center gap-1 rounded-md text-sm font-medium tracking-tight outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
          onClick={() => setOpenMobile(false)}
        >
          {"T3PO"}
        </Link>
        <div className="ml-auto">
          <SidebarTrigger aria-label={gt("Toggle main sidebar")} />
        </div>
      </div>
      <div className="my-3 flex items-center gap-1 px-(--sidebar-content-inset)">
        {renamingRo ? (
          <InlineName
            name={roName}
            label={gt("Agent name")}
            maxLength={80}
            onSave={async (name) => {
              setRoName(name);
            }}
            onClose={() => setRenamingRo(false)}
          />
        ) : (
          <SidebarMenuButton
            render={<Link to="/" search={{}} />}
            onClick={() => setOpenMobile(false)}
            onContextMenu={(event) => {
              event.preventDefault();
              void readLocalApi()
                ?.contextMenu.show(
                  [{ id: "rename", label: gt("Rename") }],
                  { x: event.clientX, y: event.clientY },
                  contextMenuSourceOf(event.nativeEvent),
                )
                .then((action) => {
                  if (action === "rename") setRenamingRo(true);
                });
            }}
            onKeyDown={(event) => {
              if (event.key === "F2") {
                event.preventDefault();
                setRenamingRo(true);
              }
            }}
            isActive={!activeSearch.project}
          >
            <span className="text-base font-semibold">{roName}</span>
          </SidebarMenuButton>
        )}
        <Button
          size="icon"
          variant="ghost"
          aria-label={gt("Add project")}
          onClick={() => openCommandPalette({ open: "add-project" })}
        >
          <PlusIcon className="size-4" />
        </Button>
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-(--sidebar-content-inset)">
        {projects.map((project) => (
          <ProjectChannels
            key={`${project.environmentId}:${project.id}`}
            projectId={project.id}
            environmentId={project.environmentId}
            title={project.title}
            workspaceRoot={project.workspaceRoot}
            machineLabel={
              environments.find((env) => env.environmentId === project.environmentId)?.label ?? ""
            }
            search={activeSearch}
            currentThreadId={
              threadRef?.environmentId === project.environmentId ? threadRef.threadId : undefined
            }
          />
        ))}
      </div>
      <div className="border-t border-sidebar-border p-(--sidebar-content-inset)">
        <Button variant="ghost" render={<Link to="/settings" />}>
          <SettingsIcon className="size-4" />
          <T>Settings</T>
        </Button>
      </div>
    </div>
  );
}

function ProjectChannels({
  projectId,
  environmentId,
  title,
  workspaceRoot,
  machineLabel,
  search,
  currentThreadId,
}: {
  projectId: ProjectId;
  environmentId: EnvironmentId;
  title: string;
  workspaceRoot: string;
  machineLabel: string;
  search: ReturnType<typeof t3poSearch>;
  currentThreadId: string | undefined;
}) {
  const { setOpenMobile } = useSidebar();
  const query = useEnvironmentQuery(
    t3po.snapshot({ environmentId, input: { metadataOnly: true } }),
  );
  const threads = useThreadShellsForProjectRefs([{ environmentId, projectId }]);
  const conversations = projectConversations(threads, { environmentId, projectId });
  const [conversationLimit, setConversationLimit] = useState(6);
  const canMutate = useAtomValue(t3po.mutate.permissionAtom(environmentId));
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<typeof T3poChannel.Type | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutate = useAtomCommand(t3po.mutate);
  const gt = useGT();
  const navigate = useNavigate();
  const [collapsed, setCollapsed] = useLocalStorage(
    `t3po.project-collapsed:${environmentId}:${projectId}`,
    false,
    Schema.Boolean,
  );
  const [renamingProject, setRenamingProject] = useState(false);
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    label: "update project",
  });
  const canUpdateProject = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  async function updateProjectDetails(input: { title?: string; archived?: boolean }) {
    const result = await updateProject({ environmentId, input: { projectId, ...input } });
    if (result._tag !== "Success") throw squashAtomCommandFailure(result);
  }
  async function archive(channel: typeof T3poChannel.Type) {
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({
        environmentId,
        input: { type: "archive_channel", projectId, id: channel.id, archived: !channel.archived },
      });
      if (result._tag !== "Success") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
        setBusy(false);
        return;
      }
      query.refresh();
      if (!channel.archived && search.channel === channel.id)
        await navigate({ to: "/", search: { project: projectId, machine: environmentId } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
    }
    setBusy(false);
  }
  const latestActivity = threads.reduce<string | null>(
    (latest, thread) => (!latest || thread.updatedAt > latest ? thread.updatedAt : latest),
    null,
  );
  const selected = search.project === projectId && search.machine === environmentId;
  const channels = query.data?.channels.filter((channel) => channel.projectId === projectId) ?? [];
  const activeChannelId = currentThreadId?.startsWith("t3po-channel:")
    ? currentThreadId.slice("t3po-channel:".length)
    : search.channel;
  return (
    <section aria-label={title}>
      <div className="flex items-center">
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={collapsed ? gt("Expand") : gt("Collapse")}
          aria-expanded={!collapsed}
          onClick={() => setCollapsed(!collapsed)}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-3.5" />
          ) : (
            <ChevronDownIcon className="size-3.5" />
          )}
        </Button>
        {renamingProject ? (
          <InlineName
            name={title}
            label={gt("Project name")}
            onSave={(title) => updateProjectDetails({ title })}
            onClose={() => setRenamingProject(false)}
          />
        ) : (
          <SidebarMenuButton
            render={<Link to="/" search={{ project: projectId, machine: environmentId }} />}
            onClick={() => setOpenMobile(false)}
            onContextMenu={(event) => {
              event.preventDefault();
              void readLocalApi()
                ?.contextMenu.show(
                  [
                    { id: "rename", label: gt("Rename"), disabled: !canUpdateProject },
                    { id: "archive", label: gt("Archive"), disabled: !canUpdateProject },
                  ],
                  { x: event.clientX, y: event.clientY },
                  contextMenuSourceOf(event.nativeEvent),
                )
                .then(async (action) => {
                  if (action === "rename") setRenamingProject(true);
                  if (action === "archive") {
                    await updateProjectDetails({ archived: true });
                    await navigate({ to: "/", search: {} });
                  }
                })
                .catch((cause) =>
                  setError(cause instanceof Error ? cause.message : gt("Could not save changes.")),
                );
            }}
            size="lg"
            isActive={
              selected &&
              !activeChannelId &&
              (!currentThreadId || currentThreadId.startsWith("t3po-lead:"))
            }
          >
            <SidebarLabel
              label={title}
              timestamp={latestActivity}
              machine={machineLabel}
              path={workspaceRoot}
            />
          </SidebarMenuButton>
        )}
      </div>
      {error ? (
        <p role="alert" className="px-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div hidden={collapsed} className="ml-4 space-y-0.5 border-l border-sidebar-border pl-2">
        {channels
          .filter((channel) => !!channel.archived === showArchived)
          .map((channel) => (
            <div key={channel.id}>
              <div className="flex items-center">
                {editing?.id === channel.id ? (
                  <div className="flex min-w-0 flex-1 items-center gap-2 px-2">
                    <HashIcon className="size-4 shrink-0" />
                    <InlineName
                      name={channel.name}
                      label={gt("Channel name")}
                      onClose={() => setEditing(null)}
                      onSave={async (name) => {
                        const result = await mutate({
                          environmentId,
                          input: {
                            type: "edit_channel",
                            projectId,
                            id: channel.id,
                            name,
                          },
                        });
                        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
                        query.refresh();
                      }}
                    />
                  </div>
                ) : (
                  <SidebarMenuButton
                    render={
                      <Link
                        to="/"
                        search={{ project: projectId, machine: environmentId, channel: channel.id }}
                      />
                    }
                    onContextMenu={(event) => {
                      event.preventDefault();
                      void readLocalApi()
                        ?.contextMenu.show(
                          [
                            { id: "rename", label: gt("Rename"), disabled: !canMutate || busy },
                            {
                              id: "archive",
                              label: channel.archived
                                ? gt("Restore channel")
                                : gt("Archive channel"),
                              disabled: !canMutate || busy,
                            },
                          ],
                          { x: event.clientX, y: event.clientY },
                          contextMenuSourceOf(event.nativeEvent),
                        )
                        .then(async (action) => {
                          if (action === "rename") {
                            setEditing(channel);
                            setCreating(false);
                          }
                          if (action === "archive") await archive(channel);
                        })
                        .catch((cause) =>
                          setError(
                            cause instanceof Error ? cause.message : gt("Could not save changes."),
                          ),
                        );
                    }}
                    onClick={() => setOpenMobile(false)}
                    onKeyDown={(event) => {
                      if (event.key === "F2" && canMutate && !busy) {
                        event.preventDefault();
                        setEditing(channel);
                        setCreating(false);
                      }
                    }}
                    isActive={selected && activeChannelId === channel.id}
                  >
                    <HashIcon />
                    <span>{channel.name}</span>
                  </SidebarMenuButton>
                )}
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={channel.archived ? gt("Restore channel") : gt("Archive channel")}
                  title={channel.archived ? gt("Restore channel") : gt("Archive channel")}
                  disabled={!canMutate || busy}
                  onClick={() => void archive(channel)}
                >
                  {channel.archived ? (
                    <RotateCcwIcon className="size-3.5" />
                  ) : (
                    <ArchiveIcon className="size-3.5" />
                  )}
                </Button>
              </div>
            </div>
          ))}
        {channels.some((channel) => channel.archived) || showArchived ? (
          <SidebarMenuButton size="sm" onClick={() => setShowArchived(!showArchived)}>
            <span>{showArchived ? <T>Active channels</T> : <T>Archived channels</T>}</span>
          </SidebarMenuButton>
        ) : null}
        {query.error ? (
          <div className="px-2 py-1 text-xs text-destructive" role="alert">
            {query.error}
            <Button variant="ghost" size="sm" onClick={query.refresh}>
              <T>Retry</T>
            </Button>
          </div>
        ) : null}
        {creating ? (
          <ChannelForm
            projectId={projectId}
            environmentId={environmentId}
            canMutate={canMutate}
            onClose={() => setCreating(false)}
          />
        ) : (
          <SidebarMenuButton
            onClick={() => {
              setCreating(true);
              setEditing(null);
              setShowArchived(false);
            }}
            disabled={!canMutate}
          >
            <PlusIcon />
            <span>
              <T>New channel</T>
            </span>
          </SidebarMenuButton>
        )}
        {conversations.length > 0 ? (
          <div className="pt-2">
            <div className="px-2 py-1 text-xs text-sidebar-muted-foreground">
              <T>Conversations</T>
            </div>
            {conversations
              .filter((thread, index) => index < conversationLimit || thread.id === currentThreadId)
              .map((thread) => (
                <SidebarMenuButton
                  key={thread.id}
                  render={
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: thread.id }}
                    />
                  }
                  onClick={() => setOpenMobile(false)}
                  isActive={thread.id === currentThreadId}
                  title={thread.title}
                  size="lg"
                >
                  <SidebarLabel
                    label={thread.title}
                    timestamp={thread.updatedAt}
                    machine={machineLabel}
                    path={thread.worktreePath ?? workspaceRoot}
                  />
                </SidebarMenuButton>
              ))}
            {conversations.length > conversationLimit ? (
              <SidebarMenuButton
                size="sm"
                onClick={() => setConversationLimit((limit) => limit + 6)}
              >
                <span>
                  <T>Show more</T>
                </span>
              </SidebarMenuButton>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function InlineName({
  name,
  label,
  maxLength = 200,
  onSave,
  onClose,
}: {
  name: string;
  label: string;
  maxLength?: number;
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const gt = useGT();
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const settled = useRef(false);
  async function save() {
    if (settled.current) return;
    settled.current = true;
    const next = value.trim();
    if (!next || next === name) {
      onClose();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave(next);
      onClose();
    } catch (cause) {
      settled.current = false;
      setSaving(false);
      setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
    }
  }
  return (
    <div className="min-w-0 flex-1">
      <Input
        autoFocus
        aria-label={label}
        aria-invalid={error ? true : undefined}
        maxLength={maxLength}
        value={value}
        readOnly={saving}
        onFocus={(event) => event.target.select()}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === "Enter") {
            event.preventDefault();
            void save();
          }
          if (event.key === "Escape" && !saving) {
            event.preventDefault();
            settled.current = true;
            onClose();
          }
        }}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ChannelForm({
  projectId,
  environmentId,
  canMutate,
  channel,
  onClose,
}: {
  projectId: ProjectId;
  environmentId: EnvironmentId;
  canMutate: boolean;
  channel?: typeof T3poChannel.Type;
  onClose: () => void;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const { setOpenMobile } = useSidebar();
  const mutate = useAtomCommand(t3po.mutate);
  const [id] = useState(() => channel?.id ?? randomUUID());
  const [name, setName] = useState(channel?.name ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    if (busy || !canMutate || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({
        environmentId,
        input: {
          type: channel ? "edit_channel" : "create_channel",
          projectId,
          id,
          name: name.trim(),
        },
      });
      if (result._tag !== "Success") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
        setBusy(false);
        return;
      }
      await navigate({
        to: "/",
        search: { project: projectId, machine: environmentId, channel: id },
      });
      setOpenMobile(false);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
    }
    setBusy(false);
  }
  return (
    <form
      className="space-y-2 px-2 py-2"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !busy) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <Input
        autoFocus
        required
        maxLength={200}
        aria-label={gt("Channel name")}
        placeholder={gt("Channel name")}
        value={name}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
      />
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap justify-end gap-1">
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onClose}>
          <T>Cancel</T>
        </Button>
        <Button type="submit" size="sm" disabled={busy || !canMutate || !name.trim()}>
          <T>Save</T>
        </Button>
      </div>
    </form>
  );
}

function SidebarLabel({
  label,
  timestamp,
  machine,
  path,
}: {
  label: string;
  timestamp: string | null;
  machine: string;
  path: string;
}) {
  return (
    <span className="block min-w-0 flex-1">
      <span className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</span>
        <SidebarTime timestamp={timestamp} />
      </span>
      <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs font-normal text-sidebar-muted-foreground/80">
        <MonitorIcon className="size-3 shrink-0" />
        <span className="shrink-0">{machine}</span>
        <FolderIcon className="ml-1 size-3 shrink-0" />
        <Tooltip>
          <TooltipTrigger render={<span className="truncate" />}>
            {path
              .replace(/\\/g, "/")
              .replace(/^(?:\/(?:Users|home)\/[^/]+|\/root|[A-Za-z]:\/Users\/[^/]+)(?=\/|$)/, "~")}
          </TooltipTrigger>
          <TooltipPopup>{path}</TooltipPopup>
        </Tooltip>
      </span>
    </span>
  );
}

function SidebarTime({ timestamp }: { timestamp: string | null }) {
  const minute = useNowMinute();
  const messages = useMessages();
  const relative = timestamp
    ? formatRelativeTime(timestamp, Date.parse(`${minute}:00.000Z`), messages)
    : null;
  return relative ? (
    <time
      dateTime={timestamp ?? undefined}
      aria-label={timestamp ?? undefined}
      className="shrink-0 text-xs font-normal text-sidebar-muted-foreground/80"
    >
      {relative.value}
    </time>
  ) : null;
}
