import { useAtomValue } from "@effect/atom-react";
import {
  AuthDiagnosticsReadScope,
  type EnvironmentId,
  type PrivacyRule,
  type PrivacyJournal,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";
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
          <ObserverPanel key={environmentId} environmentId={environmentId} />
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
  const canChange = useAtomValue(t3po.privacyChange.permissionAtom(environmentId));
  const query = useEnvironmentQuery(
    canRead ? t3po.privacySnapshot({ environmentId, input: {} }) : null,
  );
  const change = useAtomCommand(t3po.privacyChange);
  const [pending, setPending] = useState(false);
  const [hostname, setHostname] = useState("");
  const [search, setSearch] = useState("");
  const [sensitiveOnly, setSensitiveOnly] = useState(false);
  const data = query.isSuccess ? query.data : null;
  const refresh = query.refresh;
  const hasData = data !== null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Keep the external observer journal current while this panel is visible.
  useEffect(() => {
    if (!canRead || !hasData) return;
    const timer = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => clearInterval(timer);
  }, [canRead, hasData, refresh]);
  async function apply(rule: PrivacyRule) {
    if (pending || !canChange) return;
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
  const totals = new Map<string, number>();
  for (const event of data?.events ?? [])
    totals.set(event.host, (totals.get(event.host) ?? 0) + event.bodyBytes);
  const destinations = [...totals].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maximum = Math.max(1, ...destinations.map(([, size]) => size));
  const events = (data?.events ?? [])
    .filter(
      (event) =>
        event.host.toLowerCase().includes(search.toLowerCase()) &&
        (!sensitiveOnly || event.findings.some((finding) => !finding.expected)),
    )
    .toReversed();
  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">
            <T>Where your data goes</T>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            <T>Observe first. Blocks are manual and affect only this proxy.</T>
          </p>
        </div>
        <Button variant="outline" size="sm" disabled={query.isPending} onClick={refresh}>
          <T>Refresh</T>
        </Button>
      </div>
      <p className="rounded-lg border p-3 text-sm text-muted-foreground">
        <T>
          Only traffic routed through the observer is visible. Detection can miss sensitive data.
          Raw payloads and matched values are never saved in this journal.
        </T>
      </p>
      {query.error ? (
        <p role="alert" className="text-sm text-destructive">
          {query.error}
        </p>
      ) : null}
      {!data ? (
        <div className="space-y-3 rounded-lg border p-4">
          <h3 className="font-medium">
            {query.isPending ? <T>Connecting</T> : <T>Connect the observer</T>}
          </h3>
          <p className="text-sm">
            <T>
              On the selected machine, start the privacy observer, set the server's connection-file
              variable to the file it prints, then restart that server. Route a test provider
              through its proxy to begin capture.
            </T>
          </p>
          <pre className="overflow-auto rounded bg-muted p-3 text-xs">
            {
              "vp run privacy:observe\nT3CODE_PRIVACY_OBSERVER_FILE=/absolute/path/.t3-privacy/observer.json"
            }
          </pre>
          <p className="text-sm text-muted-foreground">
            <T>The observer starts with no blocks. Stopping it clears observations and rules.</T>
          </p>
        </div>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">{data.label}</p>
          <div className="grid grid-cols-3 gap-3">
            <Stat value={data.observed} label={gt("Requests observed")} />
            <Stat
              value={
                data.events.filter((event) => event.findings.some((finding) => !finding.expected))
                  .length
              }
              label={gt("Possible sensitive data")}
            />
            <Stat value={data.blocked.length} label={gt("Blocked hosts")} />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <section className="space-y-3 rounded-lg border p-4">
              <h3 className="font-medium">
                <T>Destinations · outbound body bytes</T>
              </h3>
              {destinations.map(([host, size]) => (
                <div key={host}>
                  <div className="flex justify-between gap-3 text-xs">
                    <span className="break-all">{host}</span>
                    <span>{size.toLocaleString()} B</span>
                  </div>
                  <div className="mt-1 h-2 rounded bg-primary/15">
                    <div
                      className="h-2 rounded bg-primary"
                      style={{ width: `${Math.max(1, (size / maximum) * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </section>
            <section className="space-y-3 rounded-lg border p-4">
              <h3 className="font-medium">
                <T>Block experiments</T>
              </h3>
              <p className="text-sm text-muted-foreground">
                <T>Block an exact host, retry your task, then unblock it to compare.</T>
              </p>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void apply({ action: "block", host: hostname.trim() });
                }}
              >
                <Input
                  aria-label={gt("Exact hostname")}
                  placeholder="api.example.com"
                  value={hostname}
                  onChange={(event) => setHostname(event.target.value)}
                  required
                  disabled={!canChange || pending}
                />
                <Button
                  size="sm"
                  variant="outline"
                  type="submit"
                  disabled={!canChange || pending || !hostname.trim()}
                >
                  <T>Block</T>
                </Button>
              </form>
              {data.blocked.map((host) => (
                <div className="flex items-center justify-between gap-2 text-sm" key={host}>
                  <span className="break-all">{host}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={!canChange || pending}
                    onClick={() => void apply({ action: "unblock", host })}
                  >
                    <T>Unblock</T>
                  </Button>
                </div>
              ))}
              {!canChange ? (
                <p className="text-xs text-muted-foreground">
                  <T>Settings permission is required to change rules or clear observations.</T>
                </p>
              ) : null}
            </section>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-48 flex-1">
              <Input
                aria-label={gt("Filter destinations")}
                placeholder={gt("Filter destinations")}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
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
                    <T>Time / source</T>
                  </th>
                  <th className="p-3">
                    <T>Destination / purpose</T>
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
                      <div className="text-muted-foreground">{event.source}</div>
                    </td>
                    <td className="p-3">
                      <div className="break-all">{event.host}</div>
                      <div className="text-muted-foreground">{event.category}</div>
                    </td>
                    <td className="p-3">
                      {event.method} · {event.bodyBytes.toLocaleString()} B
                      <div>{event.fields.join(", ")}</div>
                      <div className="text-muted-foreground">{event.inspection}</div>
                      {event.scanTruncated ? (
                        <div className="text-destructive">
                          <T>Only the first 1 MiB was scanned.</T>
                        </div>
                      ) : null}
                    </td>
                    <td className="p-3">
                      {event.findings.length ? (
                        groupFindings(event.findings).map(({ key, ...finding }) => (
                          <div
                            key={key}
                            className={
                              finding.expected ? "text-muted-foreground" : "text-destructive"
                            }
                          >
                            {finding.kind} · {finding.location} ×{finding.count} ·{" "}
                            {finding.expected ? (
                              <T>Expected authentication</T>
                            ) : (
                              <T>Value masked</T>
                            )}
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
                                ? "unblock"
                                : "block",
                              host: event.host,
                            })
                          }
                        >
                          {data.blocked.includes(event.host.toLowerCase().replace(/\.$/, "")) ? (
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
                <T>No matching observations. Run a task through the observer to see its traffic.</T>
              </p>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            <T>
              Up to 2,000 events are retained in memory. Source labels are operator-supplied;
              purposes are inferred. Self-hosted services may make further outbound requests that
              need separate observation.
            </T>
          </p>
        </>
      )}
    </div>
  );
}

function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-2xl font-semibold">{value.toLocaleString()}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function groupFindings(findings: PrivacyJournal["events"][number]["findings"]) {
  const groups = new Map<string, (typeof findings)[number]>();
  for (const finding of findings) {
    const key = `${finding.kind}:${finding.location}:${finding.expected}`;
    groups.set(key, { ...finding, count: (groups.get(key)?.count ?? 0) + finding.count });
  }
  return [...groups].map(([key, finding]) => ({ key, ...finding }));
}
