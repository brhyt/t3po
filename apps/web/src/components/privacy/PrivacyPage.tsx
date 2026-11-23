import { readSourceCatalog, mayChangeSource } from "./privacySources.logic";
import { PrivacyEventEvidence, PrivacyFindingEvidence } from "./PrivacyEventEvidence";
import { PrivacyExperiments } from "./PrivacyExperiments";
import { groupFindings, summarizeFlows } from "./privacy.logic";
import { PrivacyOverview } from "./PrivacyOverview";
import { PrivacyFindings } from "./PrivacyFindings";
import { PrivacyControlsPanel } from "./PrivacyControlsPanel";
import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type PrivacyRule,
  type PrivacyJournal,
  type PrivacySourceSnapshot,
} from "@t3tools/contracts";
import { useState } from "react";
import { T, useGT } from "gt-react";
import { AppRouteModal, AppRouteModalClose } from "../AppRouteModal";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { useEnvironmentScope } from "../../state/session";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { t3po } from "../../state/t3po";

export function PrivacyPage() {
  const gt = useGT();
  const { environments } = useEnvironments();
  const primary = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId =
    environments.find((env) => env.environmentId === (selected ?? primary))?.environmentId ??
    environments[0]?.environmentId;
  return (
    <AppRouteModal label={gt("Privacy dashboard")}>
      <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
        <h1 className="font-medium">
          <T>Privacy dashboard</T>
        </h1>
        <div className="ms-auto flex items-center gap-2">
          <select
            aria-label={gt("Machine")}
            value={environmentId ?? ""}
            onChange={(event) => {
              const match = environments.find((env) => env.environmentId === event.target.value);
              if (match) setSelected(match.environmentId);
            }}
            className="max-w-48 rounded-md border bg-background p-1 text-sm"
          >
            {environments.map((env) => (
              <option key={env.environmentId} value={env.environmentId}>
                {env.label}
              </option>
            ))}
          </select>
          <AppRouteModalClose />
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-auto p-5">
        {environmentId ? (
          <div key={environmentId}>
            <ObserverPanel environmentId={environmentId} />
          </div>
        ) : (
          <p>
            <T>Connect a machine to view its privacy dashboard.</T>
          </p>
        )}
      </div>
    </AppRouteModal>
  );
}

function ObserverPanel({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const catalogQuery = useEnvironmentQuery(
    canRead ? t3po.privacySources({ environmentId, input: {} }) : null,
  );
  const catalog = catalogQuery.isSuccess ? readSourceCatalog(catalogQuery.data) : null;
  const [selected, setSelected] = useState("primary");
  const legacy = useEnvironmentQuery(
    canRead && selected === "primary" && !catalog && !catalogQuery.isPending
      ? t3po.privacySnapshot({ environmentId, input: {} })
      : null,
  );
  const source = catalog?.sources.find((entry) => entry.id === selected);
  const data = catalog
    ? source?.status === "available"
      ? source.journal
      : null
    : selected === "primary" && legacy.isSuccess
      ? legacy.data
      : null;
  const refresh = () => {
    catalogQuery.refresh();
    if (!catalog && selected === "primary") legacy.refresh();
  };
  if (!canRead)
    return (
      <p role="status">
        <T>Diagnostics permission is required to view this machine's traffic.</T>
      </p>
    );
  return (
    <div className="space-y-4">
      <label className="flex items-center gap-2">
        <T>Observer source</T>
        <select
          aria-label={gt("Observer source")}
          className="rounded border bg-background p-2 text-sm"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          <option value="primary">primary</option>
          {catalog?.sources
            .filter((entry) => entry.id !== "primary")
            .map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.id}
              </option>
            ))}
          {selected !== "primary" && !source ? <option value={selected}>{selected}</option> : null}
        </select>
      </label>
      {!catalog ? (
        <p role="status">
          <T>
            Extra sources unavailable. Legacy primary evidence is shown when available; freshness is
            unknown.
          </T>
        </p>
      ) : catalog.configuration === "invalid-extras" ? (
        <p role="status">
          <T>Extra source configuration is invalid. Primary evidence remains separate.</T>
        </p>
      ) : null}
      {source ? (
        <section className="space-y-2 rounded border p-3 text-sm">
          <p>
            {source.id} · {source.status} · {source.freshness} ·{" "}
            {source.permissions.change && source.id === "primary" ? (
              <T>Source supports changes</T>
            ) : (
              <T>Read-only source</T>
            )}
          </p>
          <p>
            <T>Fetched at</T>:{" "}
            {Number.isFinite(source.fetchedAt) && source.fetchedAt > 0 ? (
              new Date(source.fetchedAt * 1000).toLocaleString()
            ) : (
              <T>Unknown</T>
            )}
          </p>
          <p>
            <T>
              Configured hops are operator assertions, not proof of capture or delivery. Sources may
              overlap; their evidence is not combined.
            </T>
          </p>
          <ul>
            {["capture", "memory-delivery", "downstream-inference", "delegation", "artifacts"].map(
              (hop) => (
                <li key={hop}>
                  {hop} ·{" "}
                  {source.hops.find((entry) => entry.hop === hop)?.configured ? (
                    <T>Configured</T>
                  ) : (
                    <T>Not configured</T>
                  )}{" "}
                  · <T>Unverified</T>
                </li>
              ),
            )}
          </ul>
        </section>
      ) : null}
      <SourceView
        key={JSON.stringify([environmentId, selected])}
        environmentId={environmentId}
        sourceId={selected}
        source={source}
        data={data}
        query={{
          isPending: catalogQuery.isPending || legacy.isPending,
          error: !catalog && !!legacy.error,
          dataUpdatedAt: source && Number.isFinite(source.fetchedAt) ? source.fetchedAt * 1000 : 0,
          refresh,
        }}
      />
    </div>
  );
}

function SourceView({
  environmentId,
  sourceId,
  source,
  data,
  query,
}: {
  environmentId: EnvironmentId;
  sourceId: string;
  source: PrivacySourceSnapshot | undefined;
  data: PrivacyJournal | null;
  query: { isPending: boolean; error: boolean; dataUpdatedAt: number; refresh: () => void };
}) {
  const gt = useGT();
  const canRead = useEnvironmentScope(environmentId, AuthDiagnosticsReadScope);
  const callerCanChange = useAtomValue(t3po.privacyChange.permissionAtom(environmentId));
  const canChange = mayChangeSource(callerCanChange, sourceId, source?.permissions.change ?? true);
  const change = useAtomCommand(t3po.privacyChange);
  const [pending, setPending] = useState(false);
  const [view, setView] = useState("overview");
  const [outcome, setOutcome] = useState("all");
  const [search, setSearch] = useState("");
  const [sensitiveOnly, setSensitiveOnly] = useState(false);
  const refresh = query.refresh;
  async function apply(rule: PrivacyRule) {
    if (
      pending ||
      !canRead ||
      !mayChangeSource(callerCanChange, sourceId, source?.permissions.change ?? true)
    )
      return;
    setPending(true);
    const result = await change({ environmentId, input: rule }).finally(() => setPending(false));
    if (result._tag === "Success") refresh();
  }
  if (!canRead)
    return (
      <p role="status">
        <T>Diagnostics permission is required to view this machine's traffic.</T>
      </p>
    );
  const destinations = summarizeFlows(data?.events ?? []);
  const maximum = Math.max(1, ...destinations.map((entry) => entry.attempted));
  const events = (data?.events ?? [])
    .filter(
      (event) =>
        [event.host, event.source, event.category, ...event.fields]
          .join(" ")
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (outcome === "all" ||
          (outcome === "blocked"
            ? event.status === "blocked"
            : /^response \d+$/.test(event.status))) &&
        (!sensitiveOnly || event.findings.length > 0),
    )
    .toReversed();
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <nav aria-label={gt("Privacy views")} className="flex flex-wrap gap-2 border-b pb-3">
        {(
          [
            ["overview", gt("Overview")],
            ["flows", gt("Data flows")],
            ["findings", gt("Findings")],
            ["experiments", gt("Experiments")],
            ["controls", gt("Controls")],
          ] as const
        ).map(([id, label]) => (
          <Button
            key={id}
            variant={view === id ? "secondary" : "ghost"}
            size="sm"
            aria-pressed={view === id}
            onClick={() => setView(id)}
          >
            {label}
          </Button>
        ))}
      </nav>
      {view === "controls" ? (
        sourceId === "primary" ? (
          <>
            <p>
              <T>These controls apply to the entire selected machine.</T>
            </p>
            <PrivacyControlsPanel environmentId={environmentId} />
          </>
        ) : (
          <p role="status">
            <T>Environment controls are unavailable while viewing a read-only source.</T>
          </p>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold">
                {view === "overview" ? (
                  <T>Evidence at a glance</T>
                ) : view === "flows" ? (
                  <T>Data flows</T>
                ) : view === "findings" ? (
                  <T>Findings</T>
                ) : (
                  <T>Experiments</T>
                )}
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                <T>
                  Understand the data flows we can observe, what likely caused them, and what
                  changes when you intervene.
                </T>
              </p>
            </div>
            <Button variant="outline" size="sm" disabled={query.isPending} onClick={refresh}>
              <T>Refresh</T>
            </Button>
          </div>
          {query.error ? (
            <p role="alert" className="text-sm text-destructive">
              <T>Selected source unavailable.</T>
            </p>
          ) : null}
          {!data && (sourceId !== "primary" || source?.status === "unavailable" || query.error) ? (
            <p role="status">
              <T>Selected source unavailable.</T>
            </p>
          ) : !data ? (
            <div className="space-y-3 rounded-lg border p-4">
              <h3 className="font-medium">
                {query.isPending ? <T>Connecting</T> : <T>Connect the observer</T>}
              </h3>
              <details>
                <summary className="cursor-pointer text-sm">
                  <T>Advanced observer setup</T>
                </summary>
                <p className="mt-3 text-sm">
                  <T>
                    On the selected machine, start the privacy observer, set the server's
                    connection-file variable to the file it prints, then restart that server. Route
                    a test provider through its proxy to begin capture.
                  </T>
                </p>

                <p className="text-sm text-muted-foreground">
                  <T>
                    Saved policies survive observer restarts. Live observations are bounded;
                    temporary blocks expire at their recorded time.
                  </T>
                </p>
              </details>
            </div>
          ) : (
            <>
              {view === "overview" ? (
                <PrivacyOverview
                  journal={data}
                  refreshing={query.isPending}
                  fetchedAt={query.dataUpdatedAt}
                />
              ) : null}
              {view === "findings" ? (
                <PrivacyFindings
                  journal={data}
                  canChange={canChange}
                  pending={pending}
                  apply={apply}
                />
              ) : null}
              {view === "flows" ? (
                <>
                  <section className="space-y-3 rounded-lg border p-4">
                    <h3 className="font-medium">
                      <T>Payload evidence by destination</T>
                    </h3>
                    <p className="text-xs text-muted-foreground">
                      <T>
                        Retained events only. Attempted bytes include blocked payloads. Responses
                        and forwarding signals do not confirm recipient delivery.
                      </T>
                    </p>
                    {destinations.map(({ host, attempted, blocked, responses, forwarding }) => (
                      <div key={host}>
                        <div className="flex justify-between gap-3 text-xs">
                          <span className="break-all">{host}</span>
                          <span>
                            {attempted.toLocaleString()} B · <T>attempted</T>
                          </span>
                        </div>
                        <div className="mt-1 h-2 rounded bg-primary/15">
                          <div
                            className="h-2 rounded bg-primary"
                            style={{ width: `${Math.max(1, (attempted / maximum) * 100)}%` }}
                          />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {blocked.toLocaleString()} B <T>blocked</T> · {responses}{" "}
                          <T>upstream responses</T> · {forwarding} <T>forwarding signals</T>
                        </p>
                      </div>
                    ))}
                  </section>
                </>
              ) : null}
              {view === "experiments" ? (
                <PrivacyExperiments
                  journal={data}
                  canChange={canChange}
                  pending={pending}
                  apply={apply}
                />
              ) : null}
              {view === "flows" ? (
                <>
                  <div className="flex flex-wrap items-center gap-3">
                    <div className="min-w-48 flex-1">
                      <Input
                        aria-label={gt("Search source, destination or fields")}
                        placeholder={gt("Search source, destination or fields")}
                        value={search}
                        onChange={(event) => setSearch(event.target.value)}
                      />
                    </div>
                    <select
                      aria-label={gt("Outcome filter")}
                      className="rounded border bg-background p-2 text-sm"
                      value={outcome}
                      onChange={(event) => setOutcome(event.target.value)}
                    >
                      <option value="all">{gt("All outcomes")}</option>
                      <option value="blocked">{gt("Blocked")}</option>
                      <option value="responses">{gt("Upstream response")}</option>
                    </select>
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={sensitiveOnly}
                        onChange={(event) => setSensitiveOnly(event.target.checked)}
                      />
                      <T>Possible sensitive data</T>
                    </label>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        const url = URL.createObjectURL(
                          new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
                        );
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = "t3-privacy-masked-report.json";
                        link.click();
                        setTimeout(() => URL.revokeObjectURL(url), 1000);
                      }}
                    >
                      <T>Export masked report</T>
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!canChange || pending}
                      onClick={() => void apply({ action: "clear" })}
                    >
                      <T>Clear observations</T>
                    </Button>
                  </div>
                  <div className="overflow-auto rounded-lg border">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-muted">
                        <tr>
                          <th className="p-3">
                            <T>Time</T>
                          </th>
                          <th className="p-3">
                            <T>Destination</T>
                          </th>
                          <th className="p-3">
                            <T>Inferred purpose</T>
                          </th>
                          <th className="p-3">
                            <T>Initiating component</T>
                          </th>
                          <th className="p-3">
                            <T>Workflow association</T>
                          </th>
                          <th className="p-3">
                            <T>What was observed</T>
                          </th>
                          <th className="p-3">
                            <T>Sensitive-data signals</T>
                          </th>
                          <th className="p-3">
                            <T>Delivery / action</T>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {events.map((event) => (
                          <tr key={event.id} className="border-t align-top">
                            <td className="p-3">
                              {new Date(event.time * 1000).toLocaleTimeString()}
                            </td>
                            <td className="p-3">
                              <div className="break-all">{event.host}</div>
                            </td>
                            <td className="p-3">{event.category}</td>
                            <td className="p-3">
                              {event.launchAttribution?.component ?? <T>Unknown</T>}
                              <div>{event.launchAttribution?.evidence ?? "unknown"}</div>
                              <div>
                                {event.source} · <T>Operator-supplied</T>
                              </div>
                            </td>
                            <td className="p-3">
                              <T>Unknown</T>
                            </td>
                            <td className="p-3">
                              <details>
                                <summary className="cursor-pointer">
                                  <T>Inspect masked metadata</T>
                                </summary>
                                <PrivacyEventEvidence event={event} />
                                {event.method} · {event.bodyBytes.toLocaleString()} B
                                <div>{event.fields.join(", ")}</div>
                                <div className="text-muted-foreground">{event.inspection}</div>
                                {event.scanTruncated ? (
                                  <div className="text-destructive">
                                    <T>Only the first 1 MiB was scanned.</T>
                                  </div>
                                ) : null}
                              </details>
                            </td>
                            <td className="p-3">
                              {event.findings.length ? (
                                groupFindings(event.findings).map(({ key, ...finding }) => (
                                  <div key={key} className="text-destructive">
                                    {finding.kind} · {finding.location} ×{finding.count} ·{" "}
                                    <T>Value masked</T>
                                    <PrivacyFindingEvidence finding={finding} />
                                  </div>
                                ))
                              ) : (
                                <span className="text-muted-foreground">
                                  <T>No pattern matched</T>
                                </span>
                              )}
                            </td>
                            <td className="p-3">
                              {event.status}
                              <div>
                                <Button
                                  variant="ghost"
                                  size="xs"
                                  disabled={!canChange || pending}
                                  onClick={() =>
                                    void apply({
                                      action: data.blocked.includes(
                                        event.host.toLowerCase().replace(/\.$/, ""),
                                      )
                                        ? data.rules?.some(
                                            (rule) =>
                                              rule.host ===
                                                event.host.toLowerCase().replace(/\.$/, "") &&
                                              rule.kind === "saved",
                                          )
                                          ? "remove-policy"
                                          : "unblock"
                                        : "block",
                                      host: event.host,
                                    })
                                  }
                                >
                                  {data.blocked.includes(
                                    event.host.toLowerCase().replace(/\.$/, ""),
                                  ) ? (
                                    <T>Unblock</T>
                                  ) : (
                                    <T>Block</T>
                                  )}
                                </Button>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!events.length ? (
                      <p className="p-8 text-center text-sm text-muted-foreground">
                        <T>
                          No matching observations. Run a task through the observer to see its
                          traffic.
                        </T>
                      </p>
                    ) : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    <T>
                      Errors can follow partial forwarding; WebSocket signals do not confirm
                      delivery. Up to 2,000 events are retained in memory. Source labels are
                      operator-supplied; purposes are inferred. Self-hosted services may make
                      further outbound requests that need separate observation.
                    </T>
                  </p>
                </>
              ) : null}
            </>
          )}
        </>
      )}
    </div>
  );
}
