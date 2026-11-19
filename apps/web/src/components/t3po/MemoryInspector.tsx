import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { t3po } from "../../state/t3po";
import { randomUUID } from "../../lib/utils";
import { useState } from "react";
import { T } from "gt-react";
import type { ProjectId } from "@t3tools/contracts";
import type { T3poMemoryCorrection, T3poMemoryEntry, T3poMemoryPage } from "@t3tools/contracts";
import { createMemoryCorrection } from "@t3tools/client-runtime/state/t3poMemory";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

function MemoryInspector({
  projectId,
  page,
  error,
  canCorrect,
  onPage,
  onCorrect,
}: {
  projectId: ProjectId;
  page: T3poMemoryPage | undefined;
  error: string | null;
  canCorrect: boolean;
  onPage: (before?: number) => void;
  onCorrect: (input: T3poMemoryCorrection) => Promise<void>;
}) {
  const [cursors, setCursors] = useState<number[]>([]);
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">
        <T>Project memory</T>
      </h3>
      <p className="text-sm text-muted-foreground">
        <T>
          Corrections apply to local journal recall only. Previously delivered Honcho memory may
          still be recalled. Receipt acceptance does not mean processing is complete.
        </T>
      </p>
      {error ? <p role="alert">{error}</p> : null}
      <Button variant="ghost" size="sm" onClick={() => onPage(cursors.at(-1))}>
        <T>Refresh memory</T>
      </Button>
      {page?.entries.map((entry) => (
        <MemoryRow
          key={entry.id}
          projectId={projectId}
          entry={entry}
          canCorrect={canCorrect}
          onCorrect={onCorrect}
        />
      ))}
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={!cursors.length}
          onClick={() => {
            const previous = cursors.slice(0, -1);
            setCursors(previous);
            onPage(previous.at(-1));
          }}
        >
          <T>Previous</T>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={page?.nextCursor == null}
          onClick={() => {
            if (page?.nextCursor != null) {
              setCursors([...cursors, page.nextCursor]);
              onPage(page.nextCursor);
            }
          }}
        >
          <T>Next</T>
        </Button>
      </div>
    </section>
  );
}
function MemoryRow({
  projectId,
  entry,
  canCorrect,
  onCorrect,
}: {
  projectId: ProjectId;
  entry: T3poMemoryEntry;
  canCorrect: boolean;
  onCorrect: (input: T3poMemoryCorrection) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry.text);
  const [pending, setPending] = useState<T3poMemoryCorrection | null>(null);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <article className="space-y-2 rounded-md border p-3">
      <div className="text-xs text-muted-foreground">
        {entry.kind} · {entry.source} · <time>{entry.occurredAt}</time>
      </div>
      <p className="whitespace-pre-wrap text-sm">{entry.text}</p>
      <p className="text-xs text-muted-foreground" hidden={entry.supersededBy !== null}>
        {entry.stage === "local_only" ? (
          <T>Local correction only</T>
        ) : entry.stage === "receipt_accepted" ? (
          <T>Convex receipt accepted; Honcho delivery and processing unverified</T>
        ) : (
          <T>Awaiting Convex receipt</T>
        )}
      </p>
      {entry.targetId ? (
        <p className="text-xs">
          <T>Corrects record</T>: {entry.targetId}
        </p>
      ) : null}
      {entry.supersededBy ? (
        <p className="text-xs">
          <T>Superseded locally by</T>: {entry.supersededBy}
        </p>
      ) : null}
      {editing ? (
        <form
          className="space-y-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (saving) return;
            const operation =
              pending ?? createMemoryCorrection(projectId, entry, text, randomUUID());
            setPending(operation);
            setSaving(true);
            setFailed(false);
            try {
              await onCorrect(operation);
              setEditing(false);
              setPending(null);
            } catch {
              setFailed(true);
            }
            setSaving(false);
          }}
        >
          <label className="block">
            <T>Corrected memory</T>
            <Textarea
              value={text}
              maxLength={12000}
              disabled={saving || pending !== null}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          {failed ? (
            <p role="alert">
              <T>
                Correction was not confirmed. Retry the same correction or refresh to check for a
                newer revision.
              </T>
            </p>
          ) : null}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={saving || !text.trim()}>
              <T>Save local correction</T>
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={saving}
              onClick={() => {
                setEditing(false);
                setPending(null);
              }}
            >
              <T>Cancel</T>
            </Button>
          </div>
        </form>
      ) : (
        <Button
          variant="ghost"
          size="sm"
          disabled={!canCorrect || entry.supersededBy !== null}
          onClick={() => setEditing(true)}
        >
          <T>Correct locally</T>
        </Button>
      )}
    </article>
  );
}

export function ProjectMemory({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-3">
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
        <T>Project memory</T>
      </Button>
      {open ? (
        <ConnectedMemoryInspector
          key={`${environmentId}:${projectId}`}
          environmentId={environmentId}
          projectId={projectId}
        />
      ) : null}
    </div>
  );
}
function ConnectedMemoryInspector({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const [before, setBefore] = useState<number | undefined>();
  const query = useEnvironmentQuery(
    t3po.memoryList({
      environmentId,
      input: { projectId, ...(before === undefined ? {} : { before }) },
    }),
  );
  const correct = useAtomCommand(t3po.memoryCorrect);
  const canCorrect = useAtomValue(t3po.memoryCorrect.permissionAtom(environmentId));
  return (
    <MemoryInspector
      projectId={projectId}
      page={query.data ?? undefined}
      error={query.error}
      canCorrect={canCorrect}
      onPage={(cursor) => {
        setBefore(cursor);
        query.refresh();
      }}
      onCorrect={async (input) => {
        const result = await correct({ environmentId, input });
        if (result._tag !== "Success") throw squashAtomCommandFailure(result);
        query.refresh();
      }}
    />
  );
}
