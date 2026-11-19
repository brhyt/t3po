import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { ArtifactVersions } from "./ArtifactVersions";
import { useNavigate } from "@tanstack/react-router";
import { useRightPanelStore } from "../../rightPanelStore";
import { useState } from "react";
import { T, Var, useGT } from "gt-react";
import type { EnvironmentId, T3poResult, T3poTaskView } from "@t3tools/contracts";
import { useEnvironmentQuery } from "../../state/query";
import { t3po } from "../../state/t3po";
import { Button } from "../ui/button";
import ChatMarkdown from "../ChatMarkdown";

export function TaskResults({
  task,
  environmentId,
}: {
  task: T3poTaskView;
  environmentId: EnvironmentId;
}) {
  const [showHistory, setShowHistory] = useState(false);
  return (
    <div className="mt-3 space-y-3">
      {showHistory ? (
        <ResultHistory task={task} environmentId={environmentId} />
      ) : task.latestResult ? (
        <Result task={task} environmentId={environmentId} result={task.latestResult} />
      ) : (
        <p className="text-sm text-muted-foreground">
          <T>No completed result yet.</T>
        </p>
      )}
      {task.latestResult ? (
        <Button variant="ghost" size="sm" onClick={() => setShowHistory(!showHistory)}>
          {showHistory ? <T>Hide result history</T> : <T>Result history</T>}
        </Button>
      ) : null}
    </div>
  );
}

function ResultHistory({
  task,
  environmentId,
}: {
  task: T3poTaskView;
  environmentId: EnvironmentId;
}) {
  const [cursors, setCursors] = useState<number[]>([]);
  const before = cursors.at(-1);
  const query = useEnvironmentQuery(
    t3po.results({
      environmentId,
      input: {
        projectId: task.projectId,
        taskId: task.id,
        ...(before === undefined ? {} : { before }),
      },
    }),
  );
  return (
    <div className="space-y-4">
      {query.error ? (
        <div role="alert">
          {query.error}
          <Button variant="ghost" onClick={query.refresh}>
            <T>Retry</T>
          </Button>
        </div>
      ) : null}
      {!query.data && !query.error ? (
        <p role="status">
          <T>Loading results…</T>
        </p>
      ) : null}
      {query.data?.results.map((result) => (
        <Result key={result.runId} task={task} environmentId={environmentId} result={result} />
      ))}
      <div className="flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={cursors.length === 0}
          onClick={() => setCursors(cursors.slice(0, -1))}
        >
          <T>Previous</T>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={query.data?.nextCursor == null}
          onClick={() => {
            if (query.data?.nextCursor != null) setCursors([...cursors, query.data.nextCursor]);
          }}
        >
          <T>Next</T>
        </Button>
      </div>
    </div>
  );
}

function Result({
  task,
  environmentId,
  result,
}: {
  task: T3poTaskView;
  environmentId: EnvironmentId;
  result: T3poResult;
}) {
  const navigate = useNavigate();
  return (
    <section className="space-y-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>
          <T>
            Run <Var>{result.runOrdinal}</Var>
          </T>
        </span>
        <time dateTime={result.completedAt}>{new Date(result.completedAt).toLocaleString()}</time>
        {task.completed && task.reviewedRunId === result.runId ? (
          <span>
            <T>Reviewed</T>
          </span>
        ) : null}
      </div>
      <ChatMarkdown
        text={result.text}
        cwd={task.workspacePath ?? undefined}
        environmentId={environmentId}
        threadRef={{ environmentId, threadId: task.threadId }}
        onOpenFileInPanel={(path, line) => {
          useRightPanelStore
            .getState()
            .openFile({ environmentId, threadId: task.threadId }, path, line);
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: task.threadId },
          });
        }}
      />
      <SavedResult
        key={`${task.id}:${result.runId}`}
        task={task}
        environmentId={environmentId}
        result={result}
      />
      {result.truncated ? (
        <p className="text-xs text-muted-foreground">
          <T>Excerpt shown. Open work for the full response.</T>
        </p>
      ) : null}
    </section>
  );
}

function SavedResult(props: {
  task: T3poTaskView;
  environmentId: EnvironmentId;
  result: T3poResult;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <Button variant="ghost" size="sm" onClick={() => setOpen(!open)}>
        <T>Saved versions</T>
      </Button>
      {open ? <SavedResultPanel {...props} /> : null}
    </div>
  );
}
function SavedResultPanel({
  task,
  environmentId,
  result,
}: {
  task: T3poTaskView;
  environmentId: EnvironmentId;
  result: T3poResult;
}) {
  const gt = useGT();
  const [before, setBefore] = useState<number | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const query = useEnvironmentQuery(
    t3po.artifactList({
      environmentId,
      input: {
        projectId: task.projectId,
        taskId: task.id,
        ...(before === undefined ? {} : { before }),
      },
    }),
  );
  const save = useAtomCommand(t3po.artifactSave);
  const read = useAtomCommand(t3po.artifactRead);
  const canSave = useAtomValue(t3po.artifactSave.permissionAtom(environmentId));
  return (
    <ArtifactVersions
      page={query.data ?? undefined}
      busy={busy}
      canSave={canSave}
      {...(error || query.error ? { error: error ?? query.error! } : {})}
      onPage={(cursor) => {
        setBefore(cursor);
        query.refresh();
      }}
      onSave={async (paths) => {
        if (busy) return;
        setBusy(true);
        setError(undefined);
        try {
          const saved = await save({
            environmentId,
            input: { projectId: task.projectId, taskId: task.id, runId: result.runId, paths },
          });
          if (saved._tag !== "Success") {
            const cause = squashAtomCommandFailure(saved);
            setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
          } else {
            setBefore(undefined);
            query.refresh();
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
        }
        setBusy(false);
      }}
      onFile={async (version, path) => {
        setError(undefined);
        try {
          const response = await read({
            environmentId,
            input: { projectId: task.projectId, versionId: version.id, path },
          });
          if (response._tag !== "Success") {
            const cause = squashAtomCommandFailure(response);
            setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
          } else {
            downloadArtifact(response.value.base64, path);
          }
        } catch (cause) {
          setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
        }
      }}
    />
  );
}

function downloadArtifact(base64: string, path: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = path.split(/[\\/]/).at(-1) || "artifact";
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}
