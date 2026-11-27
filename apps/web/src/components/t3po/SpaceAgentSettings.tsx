import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { useGT } from "gt-react";
import type {
  EnvironmentId,
  ProjectId,
  T3poMcpServer,
  T3poMutation,
  T3poSpace,
  T3poSpaceAgent,
  T3poSpaceMcpChoice,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useAtomCommand } from "../../state/use-atom-command";
import { t3po } from "../../state/t3po";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";

const selectClass = "rounded border border-input bg-background p-1.5 text-sm";

/** Saves one t3ro change and reports a failure as text. */
function useSave(environmentId: EnvironmentId) {
  const gt = useGT();
  const mutate = useAtomCommand(t3po.mutate);
  const canMutate = useAtomValue(t3po.mutate.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save(input: T3poMutation, onSaved: () => void) {
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({ environmentId, input });
      if (result._tag === "Success") {
        onSaved();
        setBusy(false);
        return true;
      }
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
    }
    setBusy(false);
    return false;
  }
  return { save, busy, error, canMutate };
}

function ErrorText({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;
}

/** A space's choice for each central connection, and the connections only it has. */
export function SpaceMcpChoices({
  environmentId,
  projectId,
  spaceId,
  servers,
  choices,
  onSaved,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  spaceId: string | null;
  servers: ReadonlyArray<T3poMcpServer>;
  choices: ReadonlyArray<T3poSpaceMcpChoice>;
  onSaved: () => void;
}) {
  const gt = useGT();
  const { save, busy, error, canMutate } = useSave(environmentId);
  const central = servers.filter((server) => server.spaceId === null);
  const own = servers.filter((server) => server.spaceId !== null && server.spaceId === spaceId);
  if (!central.length && !own.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{gt("Connections")}</p>
      {central.map((server) => {
        const choice = choices.find(
          (entry) => entry.spaceId === spaceId && entry.serverId === server.id,
        );
        const value = choice === undefined ? "default" : choice.enabled ? "on" : "off";
        return (
          <label key={server.id} className="flex items-center justify-between gap-3 text-sm">
            <span>{server.name}</span>
            <select
              aria-label={server.name}
              value={value}
              disabled={busy || !canMutate}
              onChange={(event) =>
                void save(
                  {
                    type: "set_space_mcp",
                    projectId,
                    spaceId,
                    serverId: server.id,
                    enabled: event.target.value === "default" ? null : event.target.value === "on",
                  },
                  onSaved,
                )
              }
              className={selectClass}
            >
              <option value="default">
                {server.shared ? gt("Shared (on)") : gt("Shared (off)")}
              </option>
              <option value="on">{gt("On")}</option>
              <option value="off">{gt("Off")}</option>
            </select>
          </label>
        );
      })}
      {own.map((server) => (
        <div key={server.id} className="flex items-center justify-between gap-3 text-sm">
          <span>{server.name}</span>
          <span className="text-muted-foreground">{gt("This space only")}</span>
        </div>
      ))}
      <ErrorText error={error} />
    </div>
  );
}

/** A space's own GitHub access (optional) and the shell commands its agents may not run. */
export function SpaceAgentForm({
  environmentId,
  projectId,
  spaceId,
  agents,
  onSaved,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  spaceId: string | null;
  agents: ReadonlyArray<T3poSpaceAgent>;
  onSaved: () => void;
}) {
  const gt = useGT();
  const { save, busy, error, canMutate } = useSave(environmentId);
  const current = agents.find((entry) => entry.spaceId === spaceId);
  const [token, setToken] = useState("");
  const [gitName, setGitName] = useState(current?.gitName ?? "");
  const [gitEmail, setGitEmail] = useState(current?.gitEmail ?? "");
  const [blocked, setBlocked] = useState((current?.blockedCommands ?? []).join("\n"));
  const rules = () =>
    blocked
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const submit = async (clearGithubToken = false) => {
    const saved = await save(
      {
        type: "save_space_agent",
        projectId,
        spaceId,
        ...(token ? { githubToken: token } : {}),
        ...(clearGithubToken ? { clearGithubToken: true } : {}),
        ...(gitName.trim() ? { gitName: gitName.trim() } : {}),
        ...(gitEmail.trim() ? { gitEmail: gitEmail.trim() } : {}),
        blockedCommands: rules(),
      },
      onSaved,
    );
    if (saved) setToken("");
  };
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{gt("GitHub access")}</p>
      <p className="text-xs text-muted-foreground">
        {current?.hasGithubToken
          ? gt("This space's agents use its own GitHub token for git and gh.")
          : gt(
              "Optional. Without a token of its own, this space's agents use your own GitHub sign-in.",
            )}
      </p>
      <Input
        type="password"
        autoComplete="off"
        aria-label={gt("GitHub token for this space")}
        placeholder={
          current?.hasGithubToken ? gt("Replace this space's token") : gt("GitHub token (optional)")
        }
        value={token}
        disabled={busy || !canMutate}
        onChange={(event) => setToken(event.target.value)}
      />
      <div className="flex gap-2">
        <Input
          aria-label={gt("Git author name")}
          placeholder={gt("Git author name (optional)")}
          value={gitName}
          disabled={busy || !canMutate}
          onChange={(event) => setGitName(event.target.value)}
        />
        <Input
          aria-label={gt("Git author email")}
          placeholder={gt("Git author email (optional)")}
          value={gitEmail}
          disabled={busy || !canMutate}
          onChange={(event) => setGitEmail(event.target.value)}
        />
      </div>
      <p className="text-xs font-medium text-muted-foreground">{gt("Blocked commands")}</p>
      <p className="text-xs text-muted-foreground">
        {gt(
          "One per line, such as git push --force or gh repo delete. Claude refuses them in every mode; Codex refuses them only when it asks before running a command.",
        )}
      </p>
      <Textarea
        aria-label={gt("Blocked commands")}
        value={blocked}
        rows={3}
        disabled={busy || !canMutate}
        onChange={(event) => setBlocked(event.target.value)}
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={busy || !canMutate} onClick={() => void submit()}>
          {gt("Save")}
        </Button>
        {current?.hasGithubToken ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !canMutate}
            onClick={() => void submit(true)}
          >
            {gt("Use my own sign-in")}
          </Button>
        ) : null}
      </div>
      <ErrorText error={error} />
    </div>
  );
}

/** Settings → Tools → Connections: MCP servers agents get beside T3's own. */
export function McpServersEditor({
  environmentId,
  projectId,
  spaces,
  servers,
  onSaved,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId | undefined;
  spaces: ReadonlyArray<T3poSpace>;
  servers: ReadonlyArray<T3poMcpServer>;
  onSaved: () => void;
}) {
  const gt = useGT();
  const { save, busy, error, canMutate } = useSave(environmentId);
  const blank = {
    id: "",
    name: "",
    owner: "central-shared",
    transport: "http" as "http" | "stdio",
    location: "",
    args: "",
    secretName: "",
    secret: "",
  };
  const [draft, setDraft] = useState(blank);
  const set = (patch: Partial<typeof blank>) => setDraft((current) => ({ ...current, ...patch }));
  const edit = (server: T3poMcpServer) =>
    setDraft({
      id: server.id,
      name: server.name,
      owner:
        server.spaceId === null
          ? server.shared
            ? "central-shared"
            : "central-chosen"
          : `space:${server.spaceId}`,
      transport: server.transport,
      location: (server.transport === "http" ? server.url : server.command) ?? "",
      args: server.args.join(" "),
      secretName: server.secretName ?? "",
      secret: "",
    });
  const ownerLabel = (server: T3poMcpServer) =>
    server.spaceId === null
      ? server.shared
        ? gt("Every space")
        : gt("Spaces that turn it on")
      : (spaces.find((space) => space.id === server.spaceId)?.name ?? gt("One space"));
  const submit = async () => {
    if (!projectId) return;
    const spaceId = draft.owner.startsWith("space:") ? draft.owner.slice(6) : null;
    const saved = await save(
      {
        type: "save_mcp_server",
        projectId,
        id: draft.id || randomUUID(),
        name: draft.name.trim(),
        spaceId,
        transport: draft.transport,
        ...(draft.transport === "http"
          ? { url: draft.location.trim() }
          : { command: draft.location.trim() }),
        args:
          draft.transport === "stdio" ? draft.args.split(/\s+/).filter(Boolean) : ([] as string[]),
        ...(draft.secretName.trim() ? { secretName: draft.secretName.trim() } : {}),
        ...(draft.secret ? { secret: draft.secret } : {}),
        shared: draft.owner === "central-shared",
      },
      onSaved,
    );
    if (saved) setDraft(blank);
  };
  return (
    <div className="space-y-3">
      {servers.map((server) => (
        <div key={server.id} className="flex items-center justify-between gap-3 text-sm">
          <div className="min-w-0">
            <p className="truncate font-medium">{server.name}</p>
            <p className="truncate text-xs text-muted-foreground">
              {ownerLabel(server)} · {server.transport === "http" ? server.url : server.command}
              {server.hasSecret ? ` · ${gt("secret saved")}` : ""}
            </p>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => edit(server)}>
              {gt("Edit")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !canMutate || !projectId}
              onClick={() =>
                projectId
                  ? void save({ type: "remove_mcp_server", projectId, id: server.id }, onSaved)
                  : undefined
              }
            >
              {gt("Remove")}
            </Button>
          </div>
        </div>
      ))}
      <div className="space-y-2 rounded border border-border p-3">
        <p className="text-sm font-medium">
          {draft.id ? gt("Edit connection") : gt("Add a connection")}
        </p>
        <div className="flex gap-2">
          <Input
            aria-label={gt("Connection name")}
            placeholder={gt("Name, such as linear")}
            value={draft.name}
            onChange={(event) => set({ name: event.target.value })}
          />
          <select
            aria-label={gt("Connection type")}
            value={draft.transport}
            onChange={(event) => set({ transport: event.target.value as "http" | "stdio" })}
            className={selectClass}
          >
            <option value="http">{gt("Web address")}</option>
            <option value="stdio">{gt("Command")}</option>
          </select>
        </div>
        <Input
          aria-label={draft.transport === "http" ? gt("Server address") : gt("Command")}
          placeholder={draft.transport === "http" ? "https://…/mcp" : "npx"}
          value={draft.location}
          onChange={(event) => set({ location: event.target.value })}
        />
        {draft.transport === "stdio" ? (
          <Input
            aria-label={gt("Arguments")}
            placeholder={gt("Arguments, separated by spaces")}
            value={draft.args}
            onChange={(event) => set({ args: event.target.value })}
          />
        ) : null}
        <div className="flex gap-2">
          <Input
            aria-label={draft.transport === "http" ? gt("Secret header") : gt("Secret variable")}
            placeholder={
              draft.transport === "http"
                ? gt("Header for the secret, such as Authorization")
                : gt("Variable for the secret, such as API_KEY")
            }
            value={draft.secretName}
            onChange={(event) => set({ secretName: event.target.value })}
          />
          <Input
            type="password"
            autoComplete="off"
            aria-label={gt("Secret")}
            placeholder={draft.id ? gt("Replace the secret") : gt("Secret (optional)")}
            value={draft.secret}
            onChange={(event) => set({ secret: event.target.value })}
          />
        </div>
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>{gt("Who gets it")}</span>
          <select
            aria-label={gt("Who gets it")}
            value={draft.owner}
            onChange={(event) => set({ owner: event.target.value })}
            className={selectClass}
          >
            <option value="central-shared">{gt("Shared with every space")}</option>
            <option value="central-chosen">{gt("Shared with spaces that turn it on")}</option>
            {spaces.map((space) => (
              <option key={space.id} value={`space:${space.id}`}>
                {gt("Only {name}", { name: space.name })}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={busy || !canMutate || !projectId || !draft.name.trim() || !draft.location}
            onClick={() => void submit()}
          >
            {draft.id ? gt("Save") : gt("Add")}
          </Button>
          {draft.id ? (
            <Button size="sm" variant="ghost" onClick={() => setDraft(blank)}>
              {gt("Cancel")}
            </Button>
          ) : null}
        </div>
        <ErrorText error={error} />
      </div>
    </div>
  );
}
