import { Link } from "@tanstack/react-router";
import { T } from "gt-react";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { Button } from "../ui/button";

export function ChatNavigation({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
}) {
  const channelId = threadId.startsWith("t3po-channel:")
    ? threadId.slice("t3po-channel:".length)
    : undefined;
  if (!channelId && !threadId.startsWith("t3po-lead:")) return null;
  return (
    <nav aria-label="T3PO" className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5">
      <span className="px-2 text-xs font-medium">
        <T>Chat</T>
      </span>
      <Button
        size="sm"
        variant="ghost"
        render={
          <Link
            to="/"
            search={{
              project: projectId,
              machine: environmentId,
              channel: channelId,
              view: "board",
            }}
          />
        }
      >
        <T>Tasks & context</T>
      </Button>
    </nav>
  );
}
