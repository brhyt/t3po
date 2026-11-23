import type { PrivacyJournal } from "@t3tools/contracts";
import { T } from "gt-react";

export function PrivacyOverview({
  journal,
  refreshing,
  fetchedAt,
}: {
  journal: PrivacyJournal;
  refreshing: boolean;
  fetchedAt: number;
}) {
  const tracking = journal.tracking;
  return (
    <div className="space-y-4">
      <section className="rounded-lg border p-4">
        <h3 className="font-medium">
          <T>Observer evidence</T>
        </h3>
        <p className="mt-2 text-sm" role="status">
          {refreshing ? (
            <T>Refreshing observer snapshot</T>
          ) : (
            <T>Snapshot available; continuous health is not verified</T>
          )}
        </p>
        <p className="mt-2 break-all text-sm">
          <T>Component / version</T>:{" "}
          {journal.component ? (
            `${journal.component.name} / ${journal.component.version} (${journal.component.identityKind})`
          ) : (
            <T>Unknown</T>
          )}
        </p>
        <p className="mt-2 text-sm">
          <T>Snapshot generated</T>:{" "}
          {journal.generatedAt ? (
            new Date(journal.generatedAt * 1000).toLocaleString()
          ) : (
            <T>Unknown</T>
          )}
        </p>
        <p className="mt-2 text-sm">
          <T>Fetched at</T>: {fetchedAt ? new Date(fetchedAt).toLocaleString() : <T>Unknown</T>}
        </p>
        <p className="mt-2 text-sm">
          <T>Observation window</T>:{" "}
          {journal.observationWindow ? (
            <>
              {new Date(journal.observationWindow.startedAt * 1000).toLocaleString()} –{" "}
              {new Date(journal.observationWindow.endedAt * 1000).toLocaleString()} ·{" "}
              {journal.observationWindow.retainedEvents}
            </>
          ) : (
            <T>Unknown</T>
          )}
        </p>
        {journal.observationWindow?.truncated ? (
          <p>
            <T>Evidence is incomplete.</T>
          </p>
        ) : null}
        <p className="mt-2 text-sm text-muted-foreground">
          <T>Last observation</T>:{" "}
          {tracking?.lastObservedAt ? (
            new Date(tracking.lastObservedAt * 1000).toLocaleString()
          ) : (
            <T>Unknown or none this session</T>
          )}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {journal.label} · {journal.coverage}
        </p>
      </section>
      <div className="grid gap-3 sm:grid-cols-3">
        <section className="rounded-lg border p-4">
          <p className="text-2xl font-semibold">{journal.events.length}</p>
          <h3 className="text-sm">
            <T>Retained observations</T>
          </h3>
        </section>
        <section className="rounded-lg border p-4">
          <p className="text-2xl font-semibold">
            {journal.issues ? (
              journal.issues.filter((issue) => issue.state === "open").length
            ) : (
              <T>Unknown</T>
            )}
          </p>
          <h3 className="text-sm">
            <T>Needs review</T>
          </h3>
        </section>
        <section className="rounded-lg border p-4">
          <p className="text-2xl font-semibold">
            <T>Unknown</T>
          </p>
          <h3 className="text-sm">
            <T>Direct and mobile coverage</T>
          </h3>
        </section>
      </div>
      <section className="space-y-2 rounded-lg border p-4 text-sm">
        <h3 className="font-medium">
          <T>Coverage gaps</T>
        </h3>
        <p>
          <T>
            Only traffic routed through this observer is visible. An empty journal is not evidence
            of safety.
          </T>
        </p>
        <p className="text-muted-foreground">
          <T>
            Provider and session attribution are unknown. Source labels are operator-supplied. Other
            clients and self-hosted services need separate observation.
          </T>
        </p>
        <details>
          <summary className="cursor-pointer">
            <T>Retention and inspection limits</T>
          </summary>
          <p className="mt-2">
            <T>
              Up to 2,000 live events are retained in memory and lost on restart or clearing.
              Pattern detection can miss encoded or unsupported content. Raw payloads and matched
              values are not saved.
            </T>
          </p>
          <p className="mt-2">
            <T>
              Experiments persist until manually deleted; clearing live events does not delete
              experiments.
            </T>
          </p>
          {tracking ? (
            <p className="mt-2">
              {tracking.retentionDays}{" "}
              <T>
                days since the latest occurrence before a finding expires. Earlier counts can
                predate this window.
              </T>{" "}
              ·{" "}
              {tracking.persistent && !tracking.persistenceError ? (
                <T>Persistent findings available</T>
              ) : (
                <T>Persistent findings unavailable</T>
              )}
            </p>
          ) : null}
        </details>
      </section>
    </div>
  );
}
