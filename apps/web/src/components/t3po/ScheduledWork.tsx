import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT, useMessages } from "gt-react";
import { Trash2Icon } from "lucide-react";
import type { EnvironmentId, ScheduledTask, ThreadId } from "@t3tools/contracts";
import { requestConfirmDialog } from "../../confirmDialog";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { RUN_STATUS_LABELS, ScheduledRelativeLabel } from "../settings/ScheduledTasksSettings";
import { scheduleLabel } from "../settings/scheduledTasksSettings.logic";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";

/** Schedules the chat keeps for itself; each run sends its prompt back into this chat. */
export function ScheduledWork({
  environmentId,
  threadId,
}: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  const gt = useGT();
  const messages = useMessages();
  const query = useEnvironmentQuery(
    serverEnvironment.scheduledTasksLive({ environmentId, input: {} }),
    messages,
  );
  const canOperate = useAtomValue(
    serverEnvironment.setScheduledTaskEnabled.permissionAtom(environmentId),
  );
  const setEnabled = useAtomCommand(serverEnvironment.setScheduledTaskEnabled, {
    label: "chat schedule toggle",
  });
  const remove = useAtomCommand(serverEnvironment.deleteScheduledTask, {
    label: "chat schedule delete",
  });
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const tasks = (query.data?.tasks ?? []).filter((task) => task.threadId === threadId);

  async function act(task: ScheduledTask, action: "toggle" | "delete") {
    if (action === "delete") {
      const message = `${gt('Delete "{title}"?', { title: task.title })}\n${gt("This cannot be undone.")}`;
      const confirmed =
        (await requestConfirmDialog(message, { variant: "destructive" })) ??
        window.confirm(message);
      if (!confirmed) return;
    }
    setBusy(true);
    setFailed(false);
    try {
      const result =
        action === "toggle"
          ? await setEnabled({ environmentId, input: { id: task.id, enabled: !task.enabled } })
          : await remove({ environmentId, input: { id: task.id } });
      setFailed(result._tag !== "Success");
    } catch {
      setFailed(true);
    }
    setBusy(false);
  }

  return (
    <section className="space-y-2" aria-label={gt("Scheduled")}>
      <h4 className="text-xs font-medium text-muted-foreground">
        <T>Scheduled</T>
      </h4>
      {query.error ? <p className="text-xs text-destructive">{query.error}</p> : null}
      {failed ? (
        <p role="alert" className="text-xs text-destructive">
          {gt("Could not update scheduled task")}
        </p>
      ) : null}
      {tasks.length === 0 && query.data ? (
        <p className="text-xs text-muted-foreground">
          <T>Ask this chat for recurring work or a reminder and it appears here.</T>
        </p>
      ) : null}
      {tasks.length > 0 ? (
        <ul className="space-y-2">
          {tasks.map((task) => (
            <li key={task.id} className="flex items-start gap-2 rounded-lg border p-2">
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm">{task.title}</p>
                <p className="text-xs text-muted-foreground">
                  {scheduleLabel(task.schedule, query.data?.timeZone, task.nextRunAt, messages)}
                  {" · "}
                  {!task.enabled ? (
                    gt("Paused")
                  ) : task.nextRunAt ? (
                    <T>
                      Next run <ScheduledRelativeLabel value={task.nextRunAt} />
                    </T>
                  ) : (
                    gt("Not scheduled")
                  )}
                </p>
                {task.lastRunAt !== null ? (
                  <p className="text-xs text-muted-foreground">
                    <T>
                      Last run <ScheduledRelativeLabel value={task.lastRunAt} />
                    </T>
                    {` · ${messages(RUN_STATUS_LABELS[task.lastRunStatus])}`}
                  </p>
                ) : null}
                {task.lastRunError ? (
                  <p className="break-words text-xs text-destructive">{task.lastRunError}</p>
                ) : null}
              </div>
              <Switch
                size="sm"
                checked={task.enabled}
                disabled={!canOperate || busy}
                aria-label={
                  task.enabled
                    ? gt("Pause {title}", { title: task.title })
                    : gt("Resume {title}", { title: task.title })
                }
                onCheckedChange={() => void act(task, "toggle")}
              />
              <Button
                size="icon-xs"
                variant="ghost"
                disabled={!canOperate || busy}
                aria-label={gt("Delete {title}", { title: task.title })}
                onClick={() => void act(task, "delete")}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
