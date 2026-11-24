import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react";
import { PencilIcon } from "lucide-react";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { t3po } from "../../state/t3po";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

/** The project lead's name and description, shown above the thread details card in lead and channel chats. */
export function LeadCard({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    t3po.snapshot({ environmentId, input: { projectId, metadataOnly: true } }),
  );
  const lead = query.data?.leads.find((candidate) => candidate.projectId === projectId);
  const mutate = useAtomCommand(t3po.mutate);
  const canMutate = useAtomValue(t3po.mutate.permissionAtom(environmentId));
  const [draft, setDraft] = useState<{ name: string; brief: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!lead) return null;

  async function save(name: string, brief: string) {
    setBusy(true);
    setError(false);
    try {
      const result = await mutate({
        environmentId,
        input: {
          type: "save_lead",
          projectId,
          ...(name.trim() ? { name: name.trim() } : {}),
          brief: brief.trim(),
        },
      });
      if (result._tag === "Success") setDraft(null);
      else setError(true);
    } catch {
      setError(true);
    }
    setBusy(false);
  }

  if (draft)
    return (
      <form
        className="space-y-2 p-3"
        aria-label={gt("Edit lead")}
        onSubmit={(event) => {
          event.preventDefault();
          void save(draft.name, draft.brief);
        }}
      >
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">
            <T>Name</T>
          </span>
          <Input
            size="sm"
            maxLength={200}
            value={draft.name}
            placeholder={gt("Leave blank and the lead names itself")}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
        </label>
        <label className="block space-y-1 text-xs">
          <span className="text-muted-foreground">
            <T>Description</T>
          </span>
          <Textarea
            rows={3}
            maxLength={12000}
            value={draft.brief}
            onChange={(event) => setDraft({ ...draft, brief: event.target.value })}
          />
        </label>
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            <T>Could not save changes.</T>
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setDraft(null);
              setError(false);
            }}
          >
            <T>Cancel</T>
          </Button>
          <Button size="sm" type="submit" disabled={busy}>
            <T>Save</T>
          </Button>
        </div>
      </form>
    );

  return (
    <section className="p-3" aria-label={gt("Lead")}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
            <T>Lead</T>
          </p>
          <h3
            className={cn(
              "truncate text-sm font-semibold",
              lead.autoName && "font-medium text-muted-foreground",
            )}
          >
            {lead.autoName ? gt("Unnamed lead") : lead.name}
          </h3>
        </div>
        {canMutate ? (
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={gt("Edit lead")}
            onClick={() => setDraft({ name: lead.autoName ? "" : lead.name, brief: lead.brief })}
          >
            <PencilIcon />
          </Button>
        ) : null}
      </div>
      {lead.brief ? (
        <p className="mt-1 line-clamp-4 whitespace-pre-wrap text-xs text-muted-foreground">
          {lead.brief}
        </p>
      ) : lead.autoName ? (
        <p className="mt-1 text-xs text-muted-foreground">
          <T>Names itself after a few conversations.</T>
        </p>
      ) : null}
    </section>
  );
}
