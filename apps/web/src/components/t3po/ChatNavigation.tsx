import { Link } from "@tanstack/react-router";
import { T } from "gt-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Button } from "../ui/button";

export function ChatNavigation({
  environmentId,
  threadId,
  view = "chat",
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  view?: "chat" | "board";
}) {
  const channelId = threadId.startsWith("t3po-channel:")
    ? threadId.slice("t3po-channel:".length)
    : undefined;
  if (!channelId && !threadId.startsWith("t3po-lead:")) return null;
  return (
    <nav aria-label="T3RO" className="flex shrink-0 items-center gap-2 border-b px-4 py-1.5">
      <Button
        size="sm"
        variant={view === "chat" ? "secondary" : "ghost"}
        render={
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId }}
            search={{}}
            aria-current={view === "chat" ? "page" : undefined}
          />
        }
      >
        <T>Chat</T>
      </Button>
      <Button
        size="sm"
        variant={view === "board" ? "secondary" : "ghost"}
        render={
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId }}
            search={{ view: "board" }}
            aria-current={view === "board" ? "page" : undefined}
          />
        }
      >
        <T>Tasks & context</T>
      </Button>
    </nav>
  );
}
