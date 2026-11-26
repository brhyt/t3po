// @effect-diagnostics-next-line nodeBuiltinImport:off -- Command ids are a synchronous digest of the project state they change.
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  ProjectId,
  type Project,
  type RunId,
  type T3poProjectIconResult,
  type ThreadId,
} from "@t3tools/contracts";
import { sanitizeProjectIconSvg } from "@t3tools/shared/projectIconSvg";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type * as Store from "./Store.ts";
import { projectIconInstructions } from "./WorkInstructions.ts";

export class ProjectIconRefused extends Schema.TaggedError<ProjectIconRefused>()(
  "ProjectIconRefused",
  { reason: Schema.String },
) {
  override get message() {
    return this.reason;
  }
}

const isRefused = Schema.is(ProjectIconRefused);

/** Whether a lead may draw this project's icon: nothing the user chose and no favicon to show. */
const leadMayDrawIcon = (project: Pick<Project, "projectIcon" | "faviconPath">) =>
  (project.projectIcon == null || project.projectIcon.kind === "generated") &&
  project.faviconPath == null;

/** Asks a lead, once, to draw its project's icon; "" when not due. Never fails the turn. */
export const leadIconRequest = Effect.fn("T3poProjectIcon.leadIconRequest")(
  function* (
    projectId: ProjectId,
    runId: RunId,
    store: Store.Store["Service"],
    projects: ProjectService.ProjectService["Service"],
  ) {
    const project = yield* projects.getById(projectId);
    if (Option.isNone(project) || !leadMayDrawIcon(project.value)) return "";
    return (yield* store.requestProjectIcon(projectId, runId))
      ? `${projectIconInstructions}\n\n`
      : "";
  },
  Effect.catch((cause) =>
    Effect.logWarning("T3PO project icon request failed", { cause }).pipe(Effect.as("")),
  ),
);

export class ProjectIcon extends Context.Service<
  ProjectIcon,
  {
    /** Sets the caller lead's project icon to a sanitized SVG, never over a user's icon or favicon. */
    readonly set: (
      caller: ThreadId,
      svg: string,
    ) => Effect.Effect<T3poProjectIconResult, ProjectIconRefused>;
  }
>()("t3/t3po/ProjectIcon") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectService.ProjectService;
  const favicons = yield* ProjectFaviconResolver.ProjectFaviconResolver;
  const refuse = (reason: string) => new ProjectIconRefused({ reason });

  const set = Effect.fn("T3poProjectIcon.set")(
    function* (caller: ThreadId, svg: string) {
      const owners = yield* sql<{ projectId: string }>`
        SELECT project_id AS projectId FROM t3po_leads WHERE json_extract(data, '$.threadId') = ${caller}
        UNION SELECT project_id AS projectId FROM t3po_channels WHERE 't3po-channel:' || id = ${caller} AND COALESCE(json_extract(data, '$.archived'), 0) = 0 LIMIT 1`;
      const owner = owners[0];
      if (!owner) return yield* refuse("Only a project lead or channel can set its project icon.");
      const projectId = ProjectId.make(owner.projectId);
      const found = yield* projects.getById(projectId);
      if (Option.isNone(found)) return yield* refuse("The project is unavailable.");
      const project = found.value;
      if (project.projectIcon != null && project.projectIcon.kind !== "generated")
        return yield* refuse("The user chose this project's icon. Leave it as it is.");
      // Enrichment may not have found a favicon yet; ask the resolver directly.
      const favicon = yield* favicons
        .resolvePath(project.workspaceRoot, project.faviconPath ?? undefined)
        .pipe(Effect.orElseSucceed(() => null));
      if (project.faviconPath != null || favicon !== null)
        return yield* refuse("This project already shows its own favicon. No icon is needed.");
      const sanitized = sanitizeProjectIconSvg(svg);
      if (!sanitized.ok) return yield* refuse(`The SVG was rejected: ${sanitized.reason}`);
      yield* projects
        .update({
          commandId: CommandId.make(
            `t3po-project-icon:${NodeCrypto.createHash("sha256")
              .update(`${projectId}\0${project.updatedAt}\0${sanitized.svg}`)
              .digest("hex")}`,
          ),
          projectId,
          projectIcon: { kind: "generated", svg: sanitized.svg },
        })
        .pipe(
          // The command refuses a drawn icon if the user picked one after the check above.
          Effect.catch((cause) =>
            Effect.gen(function* () {
              const latest = yield* projects
                .getById(projectId)
                .pipe(Effect.orElseSucceed(() => Option.none<Project>()));
              if (Option.isSome(latest) && !leadMayDrawIcon(latest.value))
                return yield* refuse("The user just chose this project's icon. Leave it as it is.");
              return yield* cause;
            }),
          ),
        );
      // The request is answered; a later failed or cancelled run must not ask again.
      yield* sql`UPDATE t3po_leads SET data = json_remove(data, '$.iconRequestRunId') WHERE project_id = ${projectId}`;
      return { projectId };
    },
    Effect.tapError((cause) =>
      isRefused(cause) ? Effect.void : Effect.logWarning("T3PO project icon failed", { cause }),
    ),
    Effect.mapError((cause) =>
      isRefused(cause) ? cause : refuse("Could not save the icon. Try again."),
    ),
  );
  return ProjectIcon.of({ set });
});

export const layer = Layer.effect(ProjectIcon, make);

export const optionalLayer = Layer.unwrap(
  Effect.serviceOption(ProjectIcon).pipe(
    Effect.map((service) =>
      Layer.succeed(
        ProjectIcon,
        Option.isSome(service)
          ? service.value
          : ProjectIcon.of({
              set: Effect.fn("ProjectIcon.unavailable")(() =>
                Effect.fail(new ProjectIconRefused({ reason: "Project icons are unavailable." })),
              ),
            }),
      ),
    ),
  ),
);
