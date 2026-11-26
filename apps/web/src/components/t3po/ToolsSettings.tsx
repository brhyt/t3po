import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { Link } from "@tanstack/react-router";
import { T, useGT } from "gt-react";
import type {
  EnvironmentId,
  ProjectId,
  T3poSpace,
  T3poSpaceTool,
  T3poSpaceToolName,
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

const TOOLS: ReadonlyArray<T3poSpaceToolName> = ["browser", "device"];

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
  const mutate = useAtomCommand(t3po.mutate);
  const canMutate = useAtomValue(t3po.mutate.permissionAtom(environmentId));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (tool: T3poSpaceToolName) => (tool === "browser" ? gt("Browser") : gt("Devices"));
  async function choose(tool: T3poSpaceToolName, value: string) {
    setBusy(true);
    setError(null);
    try {
      const result = await mutate({
        environmentId,
        input: {
          type: "set_space_tool",
          projectId,
          spaceId,
          tool,
          enabled: value === "default" ? null : value === "on",
        },
      });
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
): Readonly<Record<T3poSpaceToolName, boolean>> {
  const browser = useEnvironmentSettings(
    environmentId,
    (settings) => settings.enableAgentBrowserAccess,
  );
  const device = useEnvironmentSettings(
    environmentId,
    (settings) => settings.enableDeviceSupport && settings.enableAgentDeviceAccess,
  );
  return { browser, device };
}

function SpacesToolsSection({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    t3po.snapshot({ environmentId, input: { metadataOnly: true } }),
  );
  const defaults = useToolDefaults(environmentId);
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.archivedAt == null,
  );
  const spaces: ReadonlyArray<T3poSpace> = query.data?.spaces ?? [];
  const choices = query.data?.spaceTools ?? [];
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
                    <SpaceToolChoices
                      environmentId={environmentId}
                      projectId={project.id}
                      spaceId={row.id}
                      choices={choices}
                      defaults={defaults}
                      onSaved={() => query.refresh()}
                    />
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
  const { device } = useToolDefaults(environmentId);
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
          apply when an agent's session next starts.
        </T>
      </p>
    </SettingsPageContainer>
  );
}
