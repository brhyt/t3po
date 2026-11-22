import { T, useGT } from "gt-react";
import type { ProjectId, T3poMutation, T3poSnapshot } from "@t3tools/contracts";
import { Button } from "../ui/button";

export function ExternalActionSettings({
  projectId,
  bindings,
  save,
  disabled,
}: {
  projectId: ProjectId;
  bindings: (typeof T3poSnapshot.Type)["externalBindings"];
  save: (input: T3poMutation) => Promise<unknown>;
  disabled: boolean;
}) {
  const gt = useGT();
  const binding = bindings?.find((item) => item.projectId === projectId);
  return (
    <details className="rounded border p-3 text-sm">
      <summary className="cursor-pointer">
        <T>External actions</T>
      </summary>
      <p className="my-3 text-muted-foreground">
        <T>
          Allow granted Codex jobs to request approval to convert a pull request in this project's
          GitHub repository to draft. Every action requires your approval. This does not restrict
          tools outside this connection.
        </T>
      </p>
      <form
        key={`${projectId}:${binding?.version ?? 0}`}
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          void save({
            type: "save_external_binding",
            projectId,
            expectedVersion: binding?.version ?? 0,
            accountId: String(form.get("accountId")).trim(),
            host: "github.com",
            repository: String(form.get("repository")).trim(),
            enabled: form.get("enabled") === "on",
          });
        }}
      >
        <label>
          <T>GitHub account ID</T>
          <input
            className="block rounded border bg-background p-2"
            name="accountId"
            required
            maxLength={200}
            defaultValue={binding?.accountId}
            disabled={disabled}
          />
        </label>
        <label>
          <T>GitHub repository</T>
          <input
            className="block rounded border bg-background p-2"
            name="repository"
            required
            placeholder={gt("owner/repository")}
            defaultValue={binding?.repository}
            disabled={disabled}
          />
        </label>
        <label className="flex items-center gap-2 pb-2">
          <input
            name="enabled"
            type="checkbox"
            defaultChecked={binding?.enabled ?? false}
            disabled={disabled}
          />
          <T>Enable proposals</T>
        </label>
        <Button type="submit" variant="outline" size="sm" disabled={disabled}>
          <T>Save connection</T>
        </Button>
      </form>
    </details>
  );
}
