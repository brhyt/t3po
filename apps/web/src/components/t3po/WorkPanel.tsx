import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import type { EnvironmentId, ProjectId, ThreadId, T3poMutation } from "@t3tools/contracts";
import { t3po } from "../../state/t3po";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";

export function WorkPanel({
  environmentId,
  projectId,
  threadId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  threadId: ThreadId;
}) {
  const gt = useGT();
  const channelId = threadId.startsWith("t3po-channel:")
    ? threadId.slice("t3po-channel:".length)
    : undefined;
  const [before, setBefore] = useState<number | undefined>();
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const query = useEnvironmentQuery(
    t3po.snapshot({
      environmentId,
      input: {
        projectId,
        ...(channelId ? { channelId } : {}),
        view: "all",
        ...(before === undefined ? {} : { before }),
      },
    }),
  );
  const mutate = useAtomCommand(t3po.mutate);
  const canMutate = useAtomValue(t3po.mutate.permissionAtom(environmentId));
  const streams = (query.data?.workstreams ?? []).filter(
    (stream) => stream.channelId === (channelId ?? null),
  );
  const tasks = (query.data?.tasks ?? []).filter((task) => task.channelId === (channelId ?? null));
  const statuses = {
    up_next: gt("Queued"),
    active: gt("Running"),
    needs_you: gt("Needs you"),
    ready_for_review: gt("Ready for review"),
    completed: gt("Completed"),
  };
  async function save(input: T3poMutation) {
    setBusy(true);
    setError(false);
    try {
      const result = await mutate({ environmentId, input });
      setError(result._tag !== "Success");
    } catch {
      setError(true);
    }
    setBusy(false);
  }
  return (
    <section className="space-y-3 border-t p-3" aria-label={gt("Work")}>
      <h3 className="text-sm font-semibold">
        <T>Work</T>
      </h3>
      {query.error ? <p className="text-xs text-destructive">{query.error}</p> : null}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          <T>Could not save changes.</T>
        </p>
      ) : null}
      {query.isPending && !query.data ? (
        <p className="text-xs text-muted-foreground">
          <T>Loading…</T>
        </p>
      ) : null}
      {streams.length === 0 && query.data ? (
        <p className="text-xs text-muted-foreground">
          <T>Workstreams appear when you ask your lead to take on work.</T>
        </p>
      ) : null}
      {streams.map((stream) => (
        <details
          key={stream.id}
          open={stream.state === "active"}
          className="group/workstream rounded-lg border p-2"
        >
          <summary className="cursor-pointer text-sm font-medium">{stream.title}</summary>
          <p className="mt-2 break-words text-xs text-muted-foreground">{stream.goal}</p>
          <label className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
            <T>Workstream</T>
            <select
              aria-label={gt("Workstream status")}
              value={stream.state}
              disabled={!canMutate || busy}
              className="min-w-0 rounded border bg-background p-1 text-foreground"
              onChange={(event) => {
                const state = event.target.value;
                if (
                  state === "active" ||
                  state === "waiting" ||
                  state === "completed" ||
                  state === "archived"
                )
                  void save({ type: "save_workstream", ...stream, state });
              }}
            >
              <option value="active">{gt("Active")}</option>
              <option value="waiting">{gt("Waiting")}</option>
              <option value="completed">{gt("Completed")}</option>
              <option value="archived">{gt("Archived")}</option>
            </select>
          </label>
          <ul className="mt-2 space-y-3">
            {tasks
              .filter((task) => task.workstreamId === stream.id)
              .map((task) => (
                <li key={task.id} className="border-t pt-2">
                  {task.executionExists ? (
                    <Link
                      to="/$environmentId/$threadId"
                      params={{ environmentId, threadId: task.threadId }}
                      className="break-words text-sm hover:underline"
                    >
                      {task.title}
                    </Link>
                  ) : (
                    <span className="break-words text-sm">{task.title}</span>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {task.dispatch?.state === "blocked"
                      ? gt("Needs you")
                      : task.dispatch?.state === "queued"
                        ? gt("Queued")
                        : statuses[task.status]}
                  </p>
                  {task.dispatch?.state !== "sent" && task.dispatch?.reason ? (
                    <p className="text-xs text-muted-foreground">{task.dispatch.reason}</p>
                  ) : null}
                  <label className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                    <T>Move</T>
                    <select
                      aria-label={gt("Move job to workstream")}
                      value={stream.id}
                      disabled={!canMutate || busy}
                      className="min-w-0 max-w-full rounded border bg-background p-1 text-foreground"
                      onChange={(event) =>
                        void save({
                          type: "move_job",
                          projectId,
                          id: task.id,
                          workstreamId: event.target.value,
                        })
                      }
                    >
                      {streams
                        .filter((target) => target.state !== "archived" || target.id === stream.id)
                        .map((target) => (
                          <option key={target.id} value={target.id}>
                            {target.title}
                          </option>
                        ))}
                    </select>
                  </label>
                </li>
              ))}
          </ul>
        </details>
      ))}
      {before !== undefined || query.data?.nextCursor != null ? (
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={before === undefined}
            onClick={() => setBefore(undefined)}
          >
            <T>Latest</T>
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={query.data?.nextCursor == null || query.isPending}
            onClick={() => setBefore(query.data?.nextCursor ?? undefined)}
          >
            <T>Older jobs</T>
          </Button>
        </div>
      ) : null}
    </section>
  );
}
