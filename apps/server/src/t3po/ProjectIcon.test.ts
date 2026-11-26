import { expect, it } from "@effect/vitest";
import { ProjectId, RunId, ThreadId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as Changes from "./Changes.ts";
import * as ProjectIcon from "./ProjectIcon.ts";
import * as Store from "./Store.ts";

const projectId = ProjectId.make("project");
const lead = ThreadId.make(`t3po-lead:${projectId}`);
const svg = '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#0ea5e9"/></svg>';
const drawn = {
  kind: "generated",
  svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#0ea5e9"/></svg>',
} as const;

function fixture(initial: Pick<Project, "projectIcon" | "faviconPath">, favicon: string | null) {
  const state = {
    project: {
      id: projectId,
      title: "Studio",
      workspaceRoot: "/work/studio",
      defaultModelSelection: null,
      scripts: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      deletedAt: null,
      ...initial,
    } as Project,
  };
  const projects = Layer.mock(ProjectService.ProjectService)({
    getById: () => Effect.succeedSome(state.project),
    update: (input) =>
      Effect.sync(() => {
        state.project = { ...state.project, projectIcon: input.projectIcon ?? null };
        return state.project;
      }),
  });
  const favicons = Layer.mock(ProjectFaviconResolver.ProjectFaviconResolver)({
    resolvePath: () => Effect.succeed(favicon),
  });
  const layer = Layer.mergeAll(ProjectIcon.layer, Store.layer).pipe(
    Layer.provideMerge(Layer.mergeAll(projects, favicons, Changes.layer)),
    Layer.provideMerge(Sqlite.layerMemory),
  );
  return { state, layer };
}

const setup = Effect.gen(function* () {
  const store = yield* Store.Store;
  yield* store.mutate({ type: "save_lead", projectId, name: "Lead", brief: "" });
  return { store, icons: yield* ProjectIcon.ProjectIcon };
});

it.effect("sets a sanitized icon when the project has none, and lets the lead replace it", () => {
  const { state, layer } = fixture({ projectIcon: null, faviconPath: null }, null);
  return Effect.gen(function* () {
    const { icons } = yield* setup;
    expect(yield* icons.set(lead, svg)).toEqual({ projectId });
    expect(state.project.projectIcon).toEqual(drawn);
    const redrawn = svg.replace("#0ea5e9", "#f97316");
    yield* icons.set(lead, redrawn);
    expect(state.project.projectIcon).toEqual({
      kind: "generated",
      svg: drawn.svg.replace("#0ea5e9", "#f97316"),
    });
  }).pipe(Effect.provide(layer));
});

it.effect.each([
  ["a user's icon", { projectIcon: { kind: "emoji", emoji: "🌱" }, faviconPath: null }, null],
  ["a chosen favicon file", { projectIcon: null, faviconPath: "logo.png" }, "logo.png"],
  ["a favicon found in the workspace", { projectIcon: null, faviconPath: null }, "favicon.ico"],
] as const)("never replaces %s", ([_name, initial, favicon]) => {
  const { state, layer } = fixture(initial, favicon);
  return Effect.gen(function* () {
    const { icons } = yield* setup;
    const refused = yield* Effect.flip(icons.set(lead, svg));
    expect(refused._tag).toBe("ProjectIconRefused");
    expect(state.project.projectIcon).toEqual(initial.projectIcon);
  }).pipe(Effect.provide(layer));
});

it.effect("refuses unsafe SVG and callers that are not the project's lead", () => {
  const { state, layer } = fixture({ projectIcon: null, faviconPath: null }, null);
  return Effect.gen(function* () {
    const { icons } = yield* setup;
    const unsafe = yield* Effect.flip(
      icons.set(lead, '<svg viewBox="0 0 16 16"><script>alert(1)</script></svg>'),
    );
    expect(unsafe.reason).toContain("<script>");
    yield* Effect.flip(icons.set(ThreadId.make("some-other-thread"), svg));
    expect(state.project.projectIcon).toBeNull();
  }).pipe(Effect.provide(layer));
});

it.effect("asks the lead once, again after a redraw, and never over a user's icon", () => {
  const { state, layer } = fixture({ projectIcon: null, faviconPath: null }, null);
  return Effect.gen(function* () {
    const { store } = yield* setup;
    const projects = yield* ProjectService.ProjectService;
    const sql = yield* SqlClient.SqlClient;
    const request = (run: string) =>
      ProjectIcon.leadIconRequest(projectId, RunId.make(run), store, projects);
    const ended = (run: string, status: string) =>
      sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${run}, 'lead', ${Number(run.split("-")[1])}, 'codex', ${status}, 'now', '{}')`;
    const reached = (run: string) => ended(run, "completed");
    expect(yield* request("run-1")).toContain("t3_project_icon_set");
    // That turn was interrupted, so the next one asks again.
    yield* ended("run-1", "interrupted");
    expect(yield* request("run-2")).toContain("t3_project_icon_set");
    yield* reached("run-2");
    expect(yield* request("run-3")).toBe("");
    // Renaming the lead keeps the request it already made.
    yield* store.mutate({ type: "save_lead", projectId, name: "Renamed", brief: "" });
    expect(yield* request("run-4")).toBe("");
    state.project = { ...state.project, projectIcon: drawn };
    yield* store.mutate({ type: "redraw_project_icon", projectId });
    expect(yield* request("run-5")).toContain("t3_project_icon_set");
    yield* reached("run-5");
    state.project = { ...state.project, projectIcon: { kind: "emoji", emoji: "🌱" } };
    yield* store.mutate({ type: "redraw_project_icon", projectId });
    expect(yield* request("run-6")).toBe("");
  }).pipe(Effect.provide(layer));
});

it.effect("never asks again once the lead drew the icon, even if that turn was cancelled", () => {
  const { layer } = fixture({ projectIcon: null, faviconPath: null }, null);
  return Effect.gen(function* () {
    const { store, icons } = yield* setup;
    const projects = yield* ProjectService.ProjectService;
    const sql = yield* SqlClient.SqlClient;
    const request = (run: string) =>
      ProjectIcon.leadIconRequest(projectId, RunId.make(run), store, projects);
    expect(yield* request("run-1")).toContain("t3_project_icon_set");
    yield* icons.set(lead, svg);
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES ('run-1', 'lead', 1, 'codex', 'cancelled', 'now', '{}')`;
    expect(yield* request("run-2")).toBe("");
  }).pipe(Effect.provide(layer));
});
