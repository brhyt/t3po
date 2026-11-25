import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react";
import { T3PO_NOTES_MAX_LENGTH, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import { t3po } from "../../state/t3po";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

/** The chat's working record: the lead keeps it current and the user can correct it. */
export function ConversationNotes({
  environmentId,
  projectId,
  channelId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  channelId: string | null;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    t3po.snapshot({
      environmentId,
      input: { projectId, ...(channelId ? { channelId } : {}), metadataOnly: true },
    }),
  );
  const notes = query.data?.notes?.find((candidate) => candidate.channelId === channelId);
  const mutate = useAtomCommand(t3po.mutate);
  const canMutate = useAtomValue(t3po.mutate.permissionAtom(environmentId));
  const [draft, setDraft] = useState<{ text: string; revision: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const revision = notes?.revision ?? 0;
  const stale = draft !== null && draft.revision !== revision;
  const when = notes ? new Date(notes.updatedAt).toLocaleString() : "";

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(false);
    try {
      const result = await mutate({
        environmentId,
        input: {
          type: "save_notes",
          projectId,
          channelId,
          text: draft.text,
          expectedRevision: draft.revision,
        },
      });
      if (result._tag === "Success") setDraft(null);
      else setError(true);
    } catch {
      setError(true);
    }
    setBusy(false);
  }

  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <label className="block space-y-1">
        <span className="font-medium text-foreground">
          <T>Notes</T>
        </span>
        <Textarea
          size="sm"
          value={draft?.text ?? notes?.text ?? ""}
          maxLength={T3PO_NOTES_MAX_LENGTH}
          disabled={!canMutate || busy}
          placeholder={gt("Decisions, preferences and open questions from this chat.")}
          onChange={(event) =>
            setDraft({ text: event.target.value, revision: draft?.revision ?? revision })
          }
        />
      </label>
      {notes && notes.revision > 0 ? (
        <p>
          {notes.updatedBy === "lead"
            ? gt("Updated {when} by the lead", { when })
            : gt("Updated {when} by you", { when })}
        </p>
      ) : null}
      {stale ? (
        <p role="alert">
          <T>These notes changed while you were editing. Cancel to see the latest.</T>
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive">
          <T>Could not save notes.</T>
        </p>
      ) : null}
      {draft ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={busy || stale} onClick={() => void save()}>
            <T>Save notes</T>
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
            <T>Cancel</T>
          </Button>
        </div>
      ) : null}
    </div>
  );
}
