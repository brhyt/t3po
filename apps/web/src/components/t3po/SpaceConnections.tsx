import { useState } from "react";
import { useAtomValue } from "@effect/atom-react";
import { T, useGT } from "gt-react";
import type { EnvironmentId, ProjectId, T3poMutation, T3poSpace } from "@t3tools/contracts";
import { useProjects } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { t3po } from "../../state/t3po";
import { randomUUID } from "../../lib/utils";
import { SpaceToolChoices, useToolDefaults } from "./ToolsSettings";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Dialog,
  DialogPopup,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogPanel,
} from "../ui/dialog";

export function SpaceConnections({
  environmentId,
  projectId,
  space,
  onClose,
}: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  space: T3poSpace;
  onClose: () => void;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(
    t3po.snapshot({ environmentId, input: { metadataOnly: true } }),
  );
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.archivedAt == null,
  );
  const mutate = useAtomCommand(t3po.mutate);
  const canMutate = useAtomValue(t3po.mutate.permissionAtom(environmentId));
  const [tab, setTab] = useState<"connections" | "rules" | "tools">("connections");
  const toolDefaults = useToolDefaults(environmentId);
  const [rules, setRules] = useState(space.rules ?? "");
  const [savedRules, setSavedRules] = useState(space.rules ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [targetSpaceId, setTargetSpaceId] = useState("");
  const spaces = query.data?.spaces ?? [];
  const others = spaces.filter((other) => other.id !== space.id);
  const nameOf = (id: string) => spaces.find((entry) => entry.id === id)?.name ?? id;
  const targets = projects.filter((project) =>
    query.data?.projectSpaces?.some(
      (entry) => entry.projectId === project.id && entry.spaceId === space.id,
    ),
  );
  const resources = (query.data?.sharedResources ?? []).filter(
    (resource) => resource.ownerSpaceId === space.id || resource.targetSpaceId === space.id,
  );
  async function save(input: T3poMutation) {
    setBusy(true);
    setError(null);
    let saved = false;
    try {
      const result = await mutate({ environmentId, input });
      if (result._tag === "Success") {
        query.refresh();
        saved = true;
      } else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : gt("Could not save changes."));
    }
    setBusy(false);
    return saved;
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>
            {space.name} · <T>Space settings</T>
          </DialogTitle>
          <DialogDescription>
            <T>
              Share selected resources or allow incoming jobs. Conversations and memory stay
              separate.
            </T>
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex gap-2">
            <Button
              size="sm"
              variant={tab === "connections" ? "secondary" : "ghost"}
              onClick={() => setTab("connections")}
            >
              <T>Connections</T>
            </Button>
            <Button
              size="sm"
              variant={tab === "rules" ? "secondary" : "ghost"}
              onClick={() => setTab("rules")}
            >
              <T>Rules</T>
            </Button>
            <Button
              size="sm"
              variant={tab === "tools" ? "secondary" : "ghost"}
              onClick={() => setTab("tools")}
            >
              <T>Tools</T>
            </Button>
          </div>
          {tab === "tools" ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                <T>
                  Choose what agents in this space can use. Defaults come from Settings → Tools.
                  This space's browser is its own, so its logins stay here.
                </T>
              </p>
              <SpaceToolChoices
                environmentId={environmentId}
                projectId={projectId}
                spaceId={space.id}
                choices={query.data?.spaceTools ?? []}
                defaults={toolDefaults}
                onSaved={() => query.refresh()}
              />
            </div>
          ) : tab === "rules" ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                <T>
                  Rules guide every project lead and worker in this space. They do not grant
                  permissions or override approval requirements. Changes save when you leave the
                  field.
                </T>
              </p>
              <textarea
                aria-label={gt("Space rules")}
                className="min-h-48 w-full rounded border border-input bg-background p-3 text-sm"
                maxLength={12000}
                value={rules}
                disabled={!canMutate || busy}
                onChange={(event) => setRules(event.target.value)}
                onBlur={() => {
                  if (rules !== savedRules)
                    void save({ type: "save_space_rules", projectId, id: space.id, rules }).then(
                      (saved) => {
                        if (saved) setSavedRules(rules);
                      },
                    );
                }}
              />
              <p className="text-xs text-muted-foreground">
                <T>
                  Memory remains project-scoped. Handoffs require an explicit connection and use the
                  receiving project's allowance. External actions still require approval.
                </T>
              </p>
            </div>
          ) : (
            <>
              <h3 className="font-medium">
                <T>Incoming jobs</T>
              </h3>
              <p className="text-sm text-muted-foreground">
                <T>
                  Each checked direction allows new jobs in that project, using its allowance. Only
                  the supplied brief crosses the boundary.
                </T>
              </p>
              {others.map((other) => (
                <div key={other.id} className="space-y-2">
                  {targets.map((project) => {
                    const enabled =
                      query.data?.spaceConnections?.some(
                        (entry) =>
                          entry.sourceSpaceId === other.id && entry.targetProjectId === project.id,
                      ) ?? false;
                    return (
                      <label key={project.id} className="flex items-center gap-2 text-sm">
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={busy || !canMutate || !query.data}
                          onChange={(event) =>
                            void save({
                              type: "connect_space",
                              projectId,
                              sourceSpaceId: other.id,
                              targetSpaceId: space.id,
                              targetProjectId: project.id,
                              enabled: event.target.checked,
                            })
                          }
                        />
                        <span>
                          {other.name} → {space.name} / {project.title}
                        </span>
                      </label>
                    );
                  })}
                </div>
              ))}
              {!targets.length ? (
                <p className="text-sm text-muted-foreground">
                  <T>Assign a project to this space to receive jobs.</T>
                </p>
              ) : null}
              <h3 className="font-medium">
                <T>Shared resource references</T>
              </h3>
              <p className="text-sm text-muted-foreground">
                <T>
                  Share a folder path or HTTPS service address. This shares a reference, not
                  credentials or additional tool permissions.
                </T>
              </p>
              {resources.map((resource) => (
                <div key={resource.id} className="flex items-start justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div>{resource.name}</div>
                    <div className="break-all text-muted-foreground">{resource.location}</div>
                    <div className="text-muted-foreground">
                      {nameOf(resource.ownerSpaceId)} → {nameOf(resource.targetSpaceId)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy || !canMutate}
                    onClick={() =>
                      void save({ type: "unshare_resource", projectId, id: resource.id })
                    }
                  >
                    <T>Disconnect</T>
                  </Button>
                </div>
              ))}
              <form
                className="space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void save({
                    type: "share_resource",
                    projectId,
                    id: randomUUID(),
                    ownerSpaceId: space.id,
                    targetSpaceId,
                    name: name.trim(),
                    location: location.trim(),
                  }).then((saved) => {
                    if (saved) {
                      setName("");
                      setLocation("");
                    }
                  });
                }}
              >
                <Input
                  required
                  aria-label={gt("Resource name")}
                  placeholder={gt("Resource name")}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={200}
                />
                <Input
                  required
                  aria-label={gt("Folder path or HTTPS address")}
                  placeholder={gt("Folder path or HTTPS address")}
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                  maxLength={2000}
                />
                <label className="flex items-center gap-2 text-sm">
                  <T>Share with</T>
                  <select
                    required
                    aria-label={gt("Share with")}
                    value={targetSpaceId}
                    onChange={(event) => setTargetSpaceId(event.target.value)}
                    className="min-w-0 flex-1 rounded border border-input bg-background p-2"
                  >
                    <option value="">{gt("Choose a space")}</option>
                    {others.map((other) => (
                      <option key={other.id} value={other.id}>
                        {other.name}
                      </option>
                    ))}
                  </select>
                </label>
                <Button
                  type="submit"
                  size="sm"
                  disabled={
                    busy || !canMutate || !targetSpaceId || !name.trim() || !location.trim()
                  }
                >
                  <T>Share resource</T>
                </Button>
              </form>
              <p className="text-xs text-muted-foreground">
                <T>
                  Disconnecting blocks future access and queued handoffs. It cannot retract context
                  already delivered or stop a running job.
                </T>
              </p>
            </>
          )}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
