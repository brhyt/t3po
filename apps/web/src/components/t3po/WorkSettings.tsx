import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import { T, useGT, useMessages } from "gt-react";
import {
  RuntimeMode,
  T3PO_DEFAULT_CONCURRENT_JOBS,
  type EnvironmentId,
  type ProjectId,
  type T3poMutation,
} from "@t3tools/contracts";
import { t3po } from "../../state/t3po";
import { useEnvironmentQuery } from "../../state/query";
import { useEnvironmentProviders } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { resolveRuntimeModeOption, runtimeModeOptions } from "../chat/runtimeModeConfig";

const modelKey = (model: { instanceId: string; model: string }) =>
  `${model.instanceId}/${model.model}`;

const isRuntimeMode = Schema.is(RuntimeMode);

/** How many of the project's agents run at once, and the model and permissions jobs run with. */
export function WorkSettings({
  environmentId,
  projectId,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
}) {
  const gt = useGT();
  const messages = useMessages();
  const query = useEnvironmentQuery(
    t3po.snapshot({ environmentId, input: { projectId, metadataOnly: true } }),
  );
  const lead = query.data?.leads.find((candidate) => candidate.projectId === projectId);
  const providers = (useEnvironmentProviders().get(environmentId) ?? []).filter(
    (provider) => provider.status !== "disabled" && provider.status !== "error",
  );
  const mutate = useAtomCommand(t3po.mutate);
  const canMutate = useAtomValue(t3po.mutate.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  if (!lead) return null;
  const limit = lead.budget?.maxConcurrent ?? T3PO_DEFAULT_CONCURRENT_JOBS;
  const disabled = !canMutate || busy;

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
  function saveLimit(value: string) {
    const next = Number(value);
    if (value.trim() === "" || !Number.isInteger(next) || next < 0 || next === limit) return;
    void save({ type: "save_budget", projectId, maxConcurrent: next });
  }

  return (
    <div className="space-y-2 text-xs text-muted-foreground">
      <label className="flex items-center justify-between gap-2">
        <T>Agents at once</T>
        <input
          key={limit}
          aria-label={gt("Agents at once")}
          className="w-16 rounded border bg-background p-1 text-foreground"
          type="number"
          min="0"
          step="1"
          defaultValue={limit}
          disabled={disabled}
          onBlur={(event) => saveLimit(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") saveLimit(event.currentTarget.value);
          }}
        />
      </label>
      <label className="flex items-center justify-between gap-2">
        <T>Model for jobs</T>
        <select
          aria-label={gt("Model for jobs")}
          className="min-w-0 max-w-48 rounded border bg-background p-1 text-foreground"
          value={lead.workModel ? modelKey(lead.workModel) : ""}
          disabled={disabled}
          onChange={(event) => {
            const option = providers
              .flatMap((provider) =>
                provider.models.map((model) => ({
                  instanceId: provider.instanceId,
                  model: model.slug,
                })),
              )
              .find((model) => modelKey(model) === event.target.value);
            void save({ type: "save_work_model", projectId, modelSelection: option ?? null });
          }}
        >
          <option value="">{gt("Same as this chat")}</option>
          {providers.flatMap((provider) =>
            provider.models.map((model) => (
              <option
                key={`${provider.instanceId}/${model.slug}`}
                value={`${provider.instanceId}/${model.slug}`}
              >
                {provider.displayName ?? provider.driver} · {model.name}
              </option>
            )),
          )}
        </select>
      </label>
      <label className="flex items-center justify-between gap-2">
        <T>Job permissions</T>
        <select
          aria-label={gt("Job permissions")}
          className="min-w-0 max-w-48 rounded border bg-background p-1 text-foreground"
          value={lead.workAccess ?? "approval-required"}
          disabled={disabled}
          onChange={(event) => {
            const runtimeMode = event.target.value;
            if (isRuntimeMode(runtimeMode))
              void save({ type: "save_work_access", projectId, runtimeMode });
          }}
        >
          {runtimeModeOptions.map((mode) => (
            <option key={mode} value={mode}>
              {resolveRuntimeModeOption(mode, messages).label}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p role="alert" className="text-destructive">
          <T>Could not save changes.</T>
        </p>
      ) : null}
    </div>
  );
}
