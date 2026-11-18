import { createFileRoute } from "@tanstack/react-router";
import { HostedEmptyState } from "../components/HostedEmptyState";
import { useEnvironments } from "../state/environments";
import { ProjectHome } from "../components/t3po/ProjectHome";
import { t3poSearch } from "../components/t3po/search";

export const Route = createFileRoute("/_chat/")({
  validateSearch: t3poSearch,
  component: ProjectHomeRoute,
});

function ProjectHomeRoute() {
  const { authGateState } = Route.useRouteContext();
  const { environments, isReady } = useEnvironments();
  if (authGateState.status === "hosted-static") {
    if (!isReady) return null;
    if (environments.length === 0) return <HostedEmptyState />;
  }
  return <ProjectHome />;
}
