import type { EnvironmentId, ProjectIconOverride, ProjectId } from "@t3tools/contracts";
import { useGT } from "gt-react";

import { toastManager } from "../components/ui/toast";
import { t3po } from "../state/t3po";
import { useAtomCommand } from "../state/use-atom-command";

type DrawnProject = {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
  readonly projectIcon?: ProjectIconOverride | null | undefined;
};

/** Asks each project's lead to draw a new icon in its next reply; the current icon stays until then. */
export function useProjectIconRedraw() {
  const gt = useGT();
  const mutate = useAtomCommand(t3po.mutate, { reportFailure: false });
  return async (projects: ReadonlyArray<DrawnProject>) => {
    const drawn = projects.filter((project) => project.projectIcon?.kind === "generated");
    const results = await Promise.all(
      drawn.map((project) =>
        mutate({
          environmentId: project.environmentId,
          input: { type: "redraw_project_icon", projectId: project.id },
        }),
      ),
    );
    toastManager.add(
      results.every((result) => result._tag === "Success")
        ? { type: "success", title: gt("The lead will draw a new icon in its next reply") }
        : { type: "error", title: gt("Could not ask the lead for a new icon") },
    );
  };
}
