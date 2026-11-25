import { ThreadId, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { t3po } from "../../state/t3po";
import { useEnvironmentQuery } from "../../state/query";

const T3PO_THREAD_PREFIXES = ["t3po-task:", "t3po-lead:", "t3po-channel:"];

/** Where a t3po thread sits, for its breadcrumb: the project's space and, for a job, its chat. */
export function useT3poBreadcrumb(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectId: ProjectId | null,
): {
  spaceName: string | null;
  conversation: { threadId: ThreadId; title: string } | null;
} {
  const job = threadId.startsWith("t3po-task:");
  const query = useEnvironmentQuery(
    projectId !== null && T3PO_THREAD_PREFIXES.some((prefix) => threadId.startsWith(prefix))
      ? t3po.snapshot({
          environmentId,
          input: job ? { projectId, threadId, view: "all" } : { projectId, metadataOnly: true },
        })
      : null,
  );
  const data = query.data;
  const spaceId = data?.projectSpaces?.find((entry) => entry.projectId === projectId)?.spaceId;
  const spaceName = data?.spaces?.find((space) => space.id === spaceId)?.name ?? null;
  const task = data?.tasks.find((candidate) => candidate.threadId === threadId);
  if (!data || !task) return { spaceName, conversation: null };
  if (task.channelId !== null) {
    const channel = data.channels.find((candidate) => candidate.id === task.channelId);
    return {
      spaceName,
      conversation: channel
        ? { threadId: ThreadId.make(`t3po-channel:${channel.id}`), title: `# ${channel.name}` }
        : null,
    };
  }
  const lead = data.leads.find((candidate) => candidate.projectId === task.projectId);
  return {
    spaceName,
    conversation: lead ? { threadId: lead.threadId, title: lead.name } : null,
  };
}
