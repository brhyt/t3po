import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import type {
  EnvironmentId,
  ProjectId,
  RuntimeMode,
  T3poMutation,
  T3poSpace,
  T3poSpaceLimit,
  T3poSpaceTool,
  T3poSpaceToolName,
  T3poToolDefault,
  T3poToolDefaultName,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { t3po } from "../../state/t3po";
import { AgentBrowserAccessSetting } from "../settings/IntegrationsSettings";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useSettingsScope } from "../settings/SettingsScopeContext";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "../settings/settingsLayout";
import { Switch } from "../ui/switch";
import { resolveRuntimeModeOption, runtimeModeOptions } from "../chat/runtimeModeConfig";

const TOOLS: ReadonlyArray<T3poSpaceToolName> = ["browser", "device", "pull-requests", "issues"];

/** Saves one t3po change and reports a failure as text. */
function useSaveT3po(environmentId: EnvironmentId) {
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
      if (result._tag === "Success") onSaved();
      else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
    }
    setBusy(false);
  }
  return { save, busy, error, canMutate };
}

function useToolLabel() {
  const gt = useGT();
  return (tool: T3poSpaceToolName) =>
    tool === "browser"
      ? gt("Browser")
      : tool === "device"
        ? gt("Devices")
        : tool === "pull-requests"
          ? gt("Pull requests")
          : gt("Issues");
}

/** Each space's choice for one tool: follow the default, or turn it on or off for that space. */
export function SpaceToolChoices({
  environmentId,
  projectId,
  spaceId,
  choices,
  defaults,
  onSaved,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  spaceId: string | null;
  choices: ReadonlyArray<T3poSpaceTool>;
  defaults: Readonly<Record<T3poSpaceToolName, boolean>>;
  onSaved: () => void;
}) {
  const gt = useGT();
  const { save, busy, error, canMutate } = useSaveT3po(environmentId);
  const label = useToolLabel();
  const choose = (tool: T3poSpaceToolName, value: string) =>
    save(
      {
        type: "set_space_tool",
        projectId,
        spaceId,
        tool,
        enabled: value === "default" ? null : value === "on",
      },
      onSaved,
    );
  return (
    <div className="space-y-2">
      {TOOLS.map((tool) => {
        const choice = choices.find((entry) => entry.spaceId === spaceId && entry.tool === tool);
        const value = choice === undefined ? "default" : choice.enabled ? "on" : "off";
        return (
          <label key={tool} className="flex items-center justify-between gap-3 text-sm">
            <span>{label(tool)}</span>
            <select
              aria-label={label(tool)}
              value={value}
              disabled={busy || !canMutate}
              onChange={(event) => void choose(tool, event.target.value)}
              className="rounded border border-input bg-background p-1.5 text-sm"
            >
              <option value="default">
                {defaults[tool] ? gt("Default (on)") : gt("Default (off)")}
              </option>
              <option value="on">{gt("On")}</option>
              <option value="off">{gt("Off")}</option>
            </select>
          </label>
        );
      })}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** The environment-wide defaults; a space's choice applies on top of them. */
export function useToolDefaults(
  environmentId: EnvironmentId,
  toolDefaults: ReadonlyArray<T3poToolDefault> | undefined,
): Readonly<Record<T3poSpaceToolName, boolean>> {
  const browser = useEnvironmentSettings(
    environmentId,
    (settings) => settings.enableAgentBrowserAccess,
  );
  const device = useEnvironmentSettings(
    environmentId,
    (settings) => settings.enableDeviceSupport && settings.enableAgentDeviceAccess,
  );
  const on = (tool: T3poToolDefaultName) =>
    toolDefaults?.find((entry) => entry.tool === tool)?.enabled ?? true;
  return { browser, device, "pull-requests": on("pull-requests"), issues: on("issues") };
}

/** How far a space's agents may go, whatever mode a chat is set to. */
export function SpaceLimitChoice({
  environmentId,
  projectId,
  spaceId,
  limits,
  onSaved,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  spaceId: string | null;
  limits: ReadonlyArray<T3poSpaceLimit>;
  onSaved: () => void;
}) {
  const gt = useGT();
  const { save, busy, error, canMutate } = useSaveT3po(environmentId);
  const current = limits.find((entry) => entry.spaceId === spaceId)?.maxRuntimeMode;
  return (
    <div className="space-y-2">
      <label className="flex items-center justify-between gap-3 text-sm">
        <span>{gt("Most agents can do")}</span>
        <select
          aria-label={gt("Most agents can do")}
          value={current ?? "any"}
          disabled={busy || !canMutate}
          onChange={(event) =>
            void save(
              {
                type: "set_space_limit",
                projectId,
                spaceId,
                maxRuntimeMode:
                  event.target.value === "any" ? null : (event.target.value as RuntimeMode),
              },
              onSaved,
            )
          }
          className="rounded border border-input bg-background p-1.5 text-sm"
        >
          <option value="any">{gt("Any mode")}</option>
          {[...runtimeModeOptions].reverse().map((mode) => (
            <option key={mode} value={mode}>
              {resolveRuntimeModeOption(mode).label}
            </option>
          ))}
        </select>
      </label>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SpacesToolsSection({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    t3po.snapshot({ environmentId, input: { metadataOnly: true } }),
  );
  const defaults = useToolDefaults(environmentId, query.data?.toolDefaults);
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.archivedAt == null,
  );
  const spaces: ReadonlyArray<T3poSpace> = query.data?.spaces ?? [];
  const choices = query.data?.spaceTools ?? [];
  const limits = query.data?.spaceLimits ?? [];
  const memberOf = (spaceId: string | null) =>
    projects.find(
      (project) =>
        (query.data?.projectSpaces?.find((entry) => entry.projectId === project.id)?.spaceId ??
          null) === spaceId,
    ) ?? projects[0];
  const rows: ReadonlyArray<{ id: string | null; name: string; detail: string }> = [
    ...spaces.map((space) => ({
      id: space.id,
      name: space.name,
      detail: gt("Its own browser, with its own logins."),
    })),
    {
      id: null,
      name: gt("Off Record"),
      detail: gt("Projects in no space. A scratch browser that keeps no logins."),
    },
  ];
  return (
    <SettingsSection id="tools-spaces" title={gt("Spaces")}>
      {!spaces.length ? (
        <SettingsRow
          title={gt("No spaces yet")}
          description={gt("Every project follows the defaults above until you make a space.")}
        />
      ) : null}
      {spaces.length
        ? rows.map((row) => {
            const project = memberOf(row.id);
            return (
              <SettingsRow
                key={row.id ?? "off-the-record"}
                title={row.name}
                description={row.detail}
                control={
                  project ? (
                    <div className="space-y-3">
                      <SpaceToolChoices
                        environmentId={environmentId}
                        projectId={project.id}
                        spaceId={row.id}
                        choices={choices}
                        defaults={defaults}
                        onSaved={() => query.refresh()}
                      />
                      <SpaceLimitChoice
                        environmentId={environmentId}
                        projectId={project.id}
                        spaceId={row.id}
                        limits={limits}
                        onSaved={() => query.refresh()}
                      />
                    </div>
                  ) : null
                }
              />
            );
          })
        : null}
    </SettingsSection>
  );
}

function DeviceDefaultRow({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const device = useEnvironmentSettings(
    environmentId,
    (settings) => settings.enableDeviceSupport && settings.enableAgentDeviceAccess,
  );
  return (
    <SettingsRow
      title={gt("Agent device access")}
      description={
        <T>
          Simulators and emulators need setup first. Change it in{" "}
          <Link to="/settings/devices" className="underline underline-offset-2">
            Devices
          </Link>
          .
        </T>
      }
      status={device ? gt("On") : gt("Off")}
    />
  );
}

/** Pull request and issue tools: on everywhere unless turned off here or in a space. */
function ToolDefaultRows({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    t3po.snapshot({ environmentId, input: { metadataOnly: true } }),
  );
  const defaults = useToolDefaults(environmentId, query.data?.toolDefaults);
  const project = useProjects().find(
    (entry) => entry.environmentId === environmentId && entry.archivedAt == null,
  );
  const { save, busy, error, canMutate } = useSaveT3po(environmentId);
  const rows: ReadonlyArray<{ tool: T3poToolDefaultName; title: string; description: string }> = [
    {
      tool: "pull-requests",
      title: gt("Agent pull request tools"),
      description: gt("Link, watch and draft pull requests from a chat."),
    },
    {
      tool: "issues",
      title: gt("Agent issue tools"),
      description: gt("Read, create and comment on GitHub and Linear issues."),
    },
  ];
  return (
    <>
      {rows.map((row) => (
        <SettingsRow
          key={row.tool}
          title={row.title}
          description={row.description}
          control={
            <Switch
              aria-label={row.title}
              checked={defaults[row.tool]}
              disabled={busy || !canMutate || !project}
              onCheckedChange={(enabled) =>
                project
                  ? void save(
                      {
                        type: "set_tool_default",
                        projectId: project.id,
                        tool: row.tool,
                        enabled: Boolean(enabled),
                      },
                      () => query.refresh(),
                    )
                  : undefined
              }
            />
          }
        />
      ))}
      {error ? (
        <p role="alert" className="px-1 text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}

/** Settings → Tools: what agents can use everywhere, and where each space differs. */
export function ToolsSettingsPanel() {
  const gt = useGT();
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  return (
    <SettingsPageContainer>
      <SettingsSection id="tools-defaults" title={gt("Defaults")}>
        <AgentBrowserAccessSetting />
        {environmentId ? <DeviceDefaultRow environmentId={environmentId} /> : null}
        {environmentId ? <ToolDefaultRows environmentId={environmentId} /> : null}
        <SettingsRow
          title={gt("Pages and messages")}
          description={gt("Agents can always show you an HTML page or a message.")}
          status={gt("Always on")}
        />
      </SettingsSection>
      {environmentId ? <SpacesToolsSection environmentId={environmentId} /> : null}
      <p className="px-1 text-xs text-muted-foreground">
        <T>
          A project's own setting wins over its space, and a space wins over the defaults. Changes
          apply when an agent's session next starts. git, gh and the terminal run in the agent's own
          shell, so a space's mode limit is what holds them back: a chat set higher runs at the
          limit.
        </T>
      </p>
    </SettingsPageContainer>
  );
}
