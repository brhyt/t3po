import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ProjectId, T3poChannel } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { t3po } from "../../state/t3po";
import { randomUUID } from "../../lib/utils";
import { Input } from "../ui/input";
import { Link, useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import {
  MessageSquareIcon,
  LayersIcon,
  PlusIcon,
  SettingsIcon,
  FolderIcon,
  HashIcon,
  PencilIcon,
  ArchiveIcon,
  RotateCcwIcon,
} from "lucide-react";
import { useProjects, useThreadShell, useThreadShellsForProjectRefs } from "../../state/entities";
import { openCommandPalette } from "../../commandPaletteBus";
import { Button } from "../ui/button";
import { SidebarMenuButton, useSidebar } from "../ui/sidebar";
import { t3poSearch } from "./search";
import { resolveThreadRouteRef } from "../../threadRoutes";
import { projectConversations } from "./projectConversations";

export function ProjectSidebar() {
  const gt = useGT();
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
          className="ml-[var(--workspace-titlebar-content-left)] inline-flex h-7 items-center gap-1 rounded-md text-sm font-medium tracking-tight outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset"
          onClick={() => setOpenMobile(false)}
        >
          {"T3PO"}
        </Link>
      </div>
      <div className="px-(--sidebar-content-inset)">
        <SidebarMenuButton
          render={<Link to="/" search={{}} />}
          onClick={() => setOpenMobile(false)}
          isActive={!activeSearch.project}
        >
          <LayersIcon />
          <span>
            <T>Everything</T>
          </span>
        </SidebarMenuButton>
      </div>
      <div className="mt-4 mb-1 flex items-center justify-between px-3 text-xs text-sidebar-muted-foreground">
        <T>Projects</T>
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
  search,
  currentThreadId,
}: {
  projectId: ProjectId;
  environmentId: EnvironmentId;
  title: string;
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
  const selected = search.project === projectId && search.machine === environmentId;
  const channels = query.data?.channels.filter((channel) => channel.projectId === projectId) ?? [];
  return (
    <section aria-label={title}>
      <SidebarMenuButton
        render={<Link to="/" search={{ project: projectId, machine: environmentId }} />}
        onClick={() => setOpenMobile(false)}
        isActive={selected && !search.channel && !currentThreadId}
      >
        <FolderIcon />
        <span>{title}</span>
      </SidebarMenuButton>
      <div className="ml-4 space-y-0.5 border-l border-sidebar-border pl-2">
        {channels
          .filter((channel) => !!channel.archived === showArchived)
          .map((channel) => (
            <div key={channel.id}>
              <div className="flex items-center">
                <SidebarMenuButton
                  render={
                    <Link
                      to="/"
                      search={{ project: projectId, machine: environmentId, channel: channel.id }}
                    />
                  }
                  onClick={() => setOpenMobile(false)}
                  isActive={selected && search.channel === channel.id}
                >
                  <HashIcon />
                  <span>{channel.name}</span>
                </SidebarMenuButton>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={gt("Rename channel")}
                  title={gt("Rename channel")}
                  disabled={!canMutate || busy}
                  onClick={() => {
                    setEditing(channel);
                    setCreating(false);
                  }}
                >
                  <PencilIcon className="size-3.5" />
                </Button>
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
              {editing?.id === channel.id ? (
                <ChannelForm
                  key={channel.id}
                  projectId={projectId}
                  environmentId={environmentId}
                  channel={editing}
                  canMutate={canMutate}
                  onClose={() => setEditing(null)}
                />
              ) : null}
            </div>
          ))}
        {error ? (
          <p className="px-2 text-xs text-destructive" role="alert">
            {error}
          </p>
        ) : null}
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
                >
                  <MessageSquareIcon />
                  <span>{thread.title}</span>
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
