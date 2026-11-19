import { createFileRoute } from "@tanstack/react-router";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { useEnvironments } from "../state/environments";
import { ProjectHome } from "../components/t3po/ProjectHome";
import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { ProjectChat } from "../components/t3po/ProjectChat";
import { t3poSearch } from "../components/t3po/search";

export const Route = createFileRoute("/_chat/")({
  validateSearch: t3poSearch,
  component: ProjectHomeRoute,
});

function ProjectHomeRoute() {
  const search = Route.useSearch();
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();
  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }
  if (search.project && search.machine)
    return (
      <ProjectChat
        key={`${search.machine}:${search.project}:${search.channel ?? "lead"}`}
        environmentId={EnvironmentId.make(search.machine)}
        projectId={ProjectId.make(search.project)}
        channelId={search.channel}
        view={search.view}
      />
    );
  return <ProjectHome />;
}
