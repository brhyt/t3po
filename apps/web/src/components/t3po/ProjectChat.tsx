import { useEffect, useState } from "react";
import { Navigate, useNavigate } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react";
import {
  type EnvironmentId,
  type ProjectId,
  ThreadId,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useProjects, useThreadShell } from "../../state/entities";
import { useEnvironmentProviders } from "../../state/environments";
import { environmentServerConfigsAtom } from "../../state/server";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveProjectDefaultProviderModelSelection } from "../../providerInstances";
import { t3po } from "../../state/t3po";
import { Button } from "../ui/button";
import { SidebarInset, SidebarTrigger } from "../ui/sidebar";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { isElectron } from "../../env";

export function ProjectChat({
  environmentId,
  projectId,
  channelId,
  view,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  channelId?: string | undefined;
  view?: "board" | undefined;
}) {
  const gt = useGT();
  const navigate = useNavigate();
  const query = useEnvironmentQuery(
    t3po.snapshot({ environmentId, input: { projectId, metadataOnly: true } }),
  );
  const project = useProjects().find(
    (p) => p.id === projectId && p.environmentId === environmentId,
  );
  const lead = query.data?.leads.find((l) => l.projectId === projectId);
  const channel = query.data?.channels.find((c) => c.id === channelId && !c.archived);
  const threadId = channelId ? ThreadId.make(`t3po-channel:${channelId}`) : lead?.threadId;
  const thread = useThreadShell(threadId ? { environmentId, threadId } : null);
  const providers = useEnvironmentProviders().get(environmentId) ?? [];
  const config = useAtomValue(environmentServerConfigsAtom).get(environmentId);
  const model =
    project?.defaultModelSelection ??
    resolveProjectDefaultProviderModelSelection(
      providers,
      config?.settings ?? DEFAULT_SERVER_SETTINGS,
      projectId,
    );
  const canLaunch = useAtomValue(t3po.launch.permissionAtom(environmentId));
  const launch = useAtomCommand(t3po.launch);
  const [error, setError] = useState<string | null>(null);
  // Opening a chat starts the project's lead when it has none; the lead names itself later.
  const available = !channelId || !!channel;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- opens the durable conversation for the selected project/channel through the idempotent server launch command
  useEffect(() => {
    if (!available || thread || !model || !canLaunch || error) return;
    let current = true;
    void launch({
      environmentId,
      input: {
        projectId,
        ...(channelId ? { channelId } : {}),
        modelSelection: model,
        runtimeMode: "approval-required",
      },
    }).then((result) => {
      if (!current) return;
      if (result._tag !== "Success") {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : gt("Could not start work."));
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId: result.value.threadId },
        search: view ? { view } : {},
        replace: true,
      });
    });
    return () => {
      current = false;
    };
  }, [
    available,
    thread,
    model,
    canLaunch,
    launch,
    environmentId,
    projectId,
    channelId,
    view,
    navigate,
    gt,
    error,
  ]);
  if (available && thread && threadId)
    return (
      <Navigate
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId }}
        search={view ? { view } : {}}
        replace
      />
    );
  return (
    <SidebarInset className="h-dvh min-h-0">
      <WorkspacePageHeader electron={isElectron}>
        <SidebarTrigger />
        <span className="text-sm">{channel ? `# ${channel.name}` : project?.title}</span>
      </WorkspacePageHeader>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-sm text-muted-foreground">
        {query.error || error ? (
          <>
            <p role="alert">{query.error ?? error}</p>
            <Button
              variant="outline"
              onClick={() => {
                query.refresh();
                setError(null);
              }}
            >
              <T>Retry</T>
            </Button>
          </>
        ) : query.data && channelId && !channel ? (
          <T>This channel is unavailable.</T>
        ) : !model ? (
          <T>Configure a provider in Settings before starting work.</T>
        ) : !canLaunch ? (
          <T>You do not have permission to open this conversation.</T>
        ) : (
          <p role="status">
            <T>Opening conversation…</T>
          </p>
        )}
      </div>
    </SidebarInset>
  );
}
