import { hostsAbsentFromBaseline } from "./privacy.logic";
import { PrivacyExperimentMetadata } from "./PrivacyExperimentMetadata";
import type { PrivacyJournal, PrivacyRule } from "@t3tools/contracts";
import { useState } from "react";
import { T, useGT } from "gt-react";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

export function PrivacyExperiments({
  journal,
  canChange,
  pending,
  apply,
}: {
  journal: PrivacyJournal;
  canChange: boolean;
  pending: boolean;
  apply: (rule: PrivacyRule) => Promise<void>;
}) {
  const gt = useGT();
  const [taskRef, setTaskRef] = useState("");
  const [provider, setProvider] = useState("");
  const [providerVersion, setProviderVersion] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const [host, setHost] = useState("");
  const [duration, setDuration] = useState("300");
  const available =
    journal.policyStorage?.status === "ready" && !journal.policyStorage.persistenceError;
  return (
    <section className="space-y-4 rounded-lg border p-4">
      <h3 className="font-medium">
        <T>Compare baseline, block and recovery</T>
      </h3>
      <ol className="list-decimal space-y-2 ps-5 text-sm">
        <li>
          <T>Run your task through this proxy to collect a baseline for the exact host.</T>
        </li>
        <li>
          <T>Start a timed block, then retry the same task. Record the task result yourself.</T>
        </li>
        <li>
          <T>Restore access and retry to collect recovery evidence, then finish the experiment.</T>
        </li>
      </ol>
      <p className="text-sm text-muted-foreground">
        <T>
          Blocks affect every client sharing this proxy. Provider and session scope are unknown. The
          block expires automatically; response counts do not establish task success.
        </T>
      </p>
      {!canChange ? (
        <p className="text-sm text-muted-foreground">
          <T>Settings permission is required to change rules or clear observations.</T>
        </p>
      ) : null}
      {!available ? (
        <p role="status" className="text-sm">
          <T>
            Experiments require an observer with durable policy storage. Refresh after upgrading or
            restoring storage.
          </T>
        </p>
      ) : null}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (available && canChange && !pending)
            void apply({
              action: "start-experiment",
              host: host.trim(),
              durationSeconds: Number(duration),
              ...(journal.supportedActions?.includes("experiment-metadata")
                ? {
                    metadata: {
                      provenance: "operator-asserted" as const,
                      ...(taskRef ? { taskRef } : {}),
                      ...(provider ? { provider } : {}),
                      ...(providerVersion ? { providerVersion } : {}),
                    },
                  }
                : {}),
            });
        }}
      >
        {journal.supportedActions?.includes("experiment-metadata") ? (
          <>
            <label className="space-y-1 text-sm">
              <span>
                <T>Safe task reference</T>
              </span>
              <Input
                value={taskRef}
                onChange={(e) => setTaskRef(e.target.value)}
                pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
                maxLength={64}
                disabled={!available || !canChange || pending}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>
                <T>Provider</T>
              </span>
              <Input
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
                maxLength={64}
                disabled={!available || !canChange || pending}
              />
            </label>
            <label className="space-y-1 text-sm">
              <span>
                <T>Provider version</T>
              </span>
              <Input
                value={providerVersion}
                onChange={(e) => setProviderVersion(e.target.value)}
                pattern="[A-Za-z0-9][A-Za-z0-9._-]{0,63}"
                maxLength={64}
                disabled={!available || !canChange || pending}
              />
            </label>
            <p className="text-xs">
              <T>
                Operator-supplied identifiers only; no prompts, secrets or environment values.
                Repeat the same safe task in each phase.
              </T>
            </p>
          </>
        ) : null}
        <label className="space-y-1 text-sm">
          <span>
            <T>Exact hostname</T>
          </span>
          <Input
            value={host}
            onChange={(event) => setHost(event.target.value)}
            required
            disabled={!available || !canChange || pending}
          />
        </label>
        <label className="space-y-1 text-sm">
          <span>
            <T>Block duration</T>
          </span>
          <select
            className="block rounded border bg-background p-2"
            value={duration}
            onChange={(event) => setDuration(event.target.value)}
            disabled={!available || !canChange || pending}
          >
            <option value="60">{gt("1 minute")}</option>
            <option value="300">{gt("5 minutes")}</option>
            <option value="900">{gt("15 minutes")}</option>
          </select>
        </label>
        <Button
          type="submit"
          size="sm"
          variant="outline"
          disabled={!available || !canChange || pending || !host.trim()}
        >
          <T>Start timed block</T>
        </Button>
      </form>
      {journal.experiments?.map((experiment) => (
        <article className="space-y-3 rounded border p-3 text-sm" key={experiment.id}>
          <h4 className="break-all font-medium">{experiment.host}</h4>
          <p>
            <T>Operator-supplied</T>: {experiment.metadata?.taskRef ?? gt("Unknown")} ·{" "}
            {experiment.metadata?.provider ?? gt("Unknown")} /{" "}
            {experiment.metadata?.providerVersion ?? gt("Unknown")}
          </p>
          {journal.supportedActions?.includes("experiment-metadata") ? (
            <PrivacyExperimentMetadata
              experimentId={experiment.id}
              metadata={experiment.metadata}
              disabled={!canChange || pending}
              apply={apply}
            />
          ) : null}
          {experiment.evidenceIncomplete ? (
            <p role="status">
              <T>
                Evidence is incomplete. Some observations may have been cleared, evicted or
                interrupted by restart.
              </T>
            </p>
          ) : null}
          <p className="text-xs text-muted-foreground">
            <T>Baseline window</T>:{" "}
            {experiment.baselineStartedAt === null ? (
              <T>No retained baseline</T>
            ) : (
              new Date(experiment.baselineStartedAt * 1000).toLocaleString()
            )}{" "}
            – {new Date(experiment.baselineEndedAt * 1000).toLocaleString()}
          </p>
          <p>
            {experiment.phase === "blocked" ? (
              <T>Block active</T>
            ) : experiment.phase === "recovery" ? (
              <T>Collecting recovery</T>
            ) : (
              <T>Finished collecting</T>
            )}{" "}
            ·{" "}
            {experiment.outcomeSource === "user-reported" ? (
              <>
                <T>User-reported outcome</T>:{" "}
                {experiment.outcome === "succeeded"
                  ? gt("Succeeded")
                  : experiment.outcome === "partial"
                    ? gt("Partial")
                    : experiment.outcome === "failed"
                      ? gt("Failed")
                      : gt("Unknown")}
              </>
            ) : (
              <T>Task outcome unknown</T>
            )}
          </p>
          <p>
            <T>Block expiry</T>: {new Date(experiment.expiresAt * 1000).toLocaleString()}
          </p>
          <div className="overflow-auto">
            <table className="w-full text-left text-xs">
              <caption className="mb-2 text-left text-muted-foreground">
                <T>Bounded proxy observations only; baseline uses retained events</T>
              </caption>
              <thead>
                <tr>
                  <th className="p-2">
                    <T>Phase</T>
                  </th>
                  <th className="p-2">
                    <T>Observed</T>
                  </th>
                  <th className="p-2">
                    <T>Blocked</T>
                  </th>
                  <th className="p-2">
                    <T>Responses</T>
                  </th>
                  <th className="p-2">
                    <T>Errors</T>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(
                  [
                    [gt("Baseline"), experiment.baseline],
                    [gt("Block"), experiment.blocked],
                    [gt("Recovery"), experiment.recovery],
                  ] as const
                ).map(([label, evidence]) => (
                  <tr key={label}>
                    <th className="p-2">{label}</th>
                    <td className="p-2">{evidence.observed}</td>
                    <td className="p-2">{evidence.blocked}</td>
                    <td className="p-2">{evidence.responses}</td>
                    <td className="p-2">{evidence.errors}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {experiment.destinations ? (
            <p className="text-sm">
              <T>Hosts absent from retained baseline</T>:{" "}
              {hostsAbsentFromBaseline(experiment.destinations).join(", ") || gt("None")}.{" "}
              <T>
                The retained baseline may be incomplete; absence does not prove a new route or
                bypass.
              </T>
            </p>
          ) : null}
          {experiment.destinations ? (
            <div className="overflow-auto">
              <table className="w-full text-left text-xs">
                <caption>
                  <T>
                    All destinations by phase; timing correlation does not prove causation. Counts
                    include other clients sharing this proxy.
                  </T>
                </caption>
                <thead>
                  <tr>
                    <th>
                      <T>Phase</T>
                    </th>
                    <th>
                      <T>Destination</T>
                    </th>
                    <th>
                      <T>Observed</T>
                    </th>
                    <th>
                      <T>Blocked</T>
                    </th>
                    <th>
                      <T>Responses</T>
                    </th>
                    <th>
                      <T>Errors</T>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      [gt("Baseline"), experiment.destinations.baseline],
                      [gt("Block"), experiment.destinations.blocked],
                      [gt("Recovery"), experiment.destinations.recovery],
                    ] as const
                  ).flatMap(([label, destinations]) =>
                    destinations.map((entry) => (
                      <tr key={`${label}:${entry.host}`}>
                        <th>{label}</th>
                        <td>{entry.host}</td>
                        <td>{entry.observed}</td>
                        <td>{entry.blocked}</td>
                        <td>{entry.responses}</td>
                        <td>{entry.errors}</td>
                      </tr>
                    )),
                  )}
                </tbody>
              </table>
              {experiment.destinationsTruncated ? (
                <p>
                  <T>Evidence is incomplete.</T>
                </p>
              ) : null}
            </div>
          ) : (
            <p>
              <T>Cross-destination evidence unavailable.</T>
            </p>
          )}
          {journal.supportedActions?.includes("experiment-outcome") ||
          journal.supportedActions?.includes("delete-experiment") ? (
            <div className="flex flex-wrap gap-2">
              {journal.supportedActions?.includes("experiment-outcome") ? (
                <>
                  <label>
                    <T>User-reported outcome</T>
                    <select
                      className="block rounded border bg-background p-2"
                      value={outcomes[experiment.id] ?? experiment.outcome}
                      disabled={!canChange || pending}
                      onChange={(e) =>
                        setOutcomes({ ...outcomes, [experiment.id]: e.target.value })
                      }
                    >
                      <option value="unknown">{gt("Unknown")}</option>
                      <option value="succeeded">{gt("Succeeded")}</option>
                      <option value="partial">{gt("Partial")}</option>
                      <option value="failed">{gt("Failed")}</option>
                    </select>
                  </label>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canChange || pending}
                    onClick={() => {
                      const outcome = outcomes[experiment.id] ?? experiment.outcome;
                      if (
                        outcome === "unknown" ||
                        outcome === "succeeded" ||
                        outcome === "partial" ||
                        outcome === "failed"
                      )
                        void apply({
                          action: "experiment-outcome",
                          experimentId: experiment.id,
                          outcome,
                        });
                    }}
                  >
                    <T>Save outcome</T>
                  </Button>
                </>
              ) : null}
              {experiment.phase === "finished" &&
              journal.supportedActions?.includes("delete-experiment") ? (
                deleting === experiment.id ? (
                  <div role="alert">
                    <p>
                      <T>Delete this experiment and its evidence? Rules remain unchanged.</T>
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={!canChange || pending}
                      onClick={() => {
                        void apply({ action: "delete-experiment", experimentId: experiment.id });
                        setDeleting(null);
                      }}
                    >
                      <T>Confirm deletion</T>
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => setDeleting(null)}>
                      <T>Cancel</T>
                    </Button>
                  </div>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={!canChange || pending}
                    onClick={() => setDeleting(experiment.id)}
                  >
                    <T>Delete experiment</T>
                  </Button>
                )
              ) : null}
            </div>
          ) : null}
          <div className="flex gap-2">
            {experiment.phase === "blocked" ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canChange || pending}
                onClick={() =>
                  void apply({ action: "stop-experiment", experimentId: experiment.id })
                }
              >
                <T>Restore access and collect recovery</T>
              </Button>
            ) : null}
            {experiment.phase !== "finished" ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={!canChange || pending}
                onClick={() =>
                  void apply({ action: "finish-experiment", experimentId: experiment.id })
                }
              >
                <T>Finish experiment</T>
              </Button>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            <T>
              Ending this experiment removes only its own block. Other rules may still block this
              host.
            </T>
          </p>
        </article>
      ))}
    </section>
  );
}
