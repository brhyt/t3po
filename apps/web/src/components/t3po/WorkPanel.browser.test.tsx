import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ProjectId, ThreadId, type T3poSnapshot } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { WorkPanel } from "./WorkPanel";

const state = vi.hoisted(() => ({
  data: undefined as typeof T3poSnapshot.Type | undefined,
  mutate: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock(import("../../state/query"), () => ({
  useEnvironmentQuery: (() => ({ data: state.data, isPending: false, error: null })) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => state.mutate) as never,
}));
vi.mock(import("../../state/t3po"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    t3po: { snapshot: () => undefined, mutate: { permissionAtom: () => Atom.make(true) } } as never,
  };
});
const projectId = ProjectId.make("project");
const environmentId = EnvironmentId.make("environment");
function setup() {
  state.mutate = vi.fn(async () => ({ _tag: "Success" }));
  state.data = {
    memory: [],
    leads: [],
    channels: [],
    nextCursor: null,
    workstreams: [
      {
        id: "latency",
        projectId,
        channelId: "research",
        title: "Latency",
        goal: "Reduce latency",
        state: "active",
      },
      {
        id: "other",
        projectId,
        channelId: "other-channel",
        title: "Other channel work",
        goal: "Separate scope",
        state: "active",
      },
    ],
    tasks: [
      {
        id: "measure",
        projectId,
        channelId: "research",
        workstreamId: "latency",
        title: "Measure cold starts",
        brief: "Measure cold starts",
        threadId: ThreadId.make("measure-thread"),
        completed: false,
        reviewedRunId: null,
        createdAt: "now",
        status: "up_next",
        latestResult: null,
        executionExists: false,
        workspaceLocked: false,
        workspacePath: null,
        branch: null,
        dispatch: {
          id: "route",
          jobId: "measure",
          workstreamId: "latency",
          state: "queued",
          reason: "Waiting for machine capacity.",
        },
      },
    ],
  };
}
it("shows queued jobs under their workstream without leaking another channel", async () => {
  setup();
  await using screen = await render(
    <WorkPanel
      environmentId={environmentId}
      projectId={projectId}
      threadId={ThreadId.make("t3po-channel:research")}
    />,
  );
  await expect.element(screen.getByRole("region", { name: "Work" })).toBeVisible();
  await expect.element(screen.getByText("Measure cold starts")).toBeVisible();
  await expect.element(screen.getByText("Waiting for machine capacity.")).toBeVisible();
  await expect.element(screen.getByText("Other channel work")).not.toBeInTheDocument();
  await expect
    .element(screen.getByRole("combobox", { name: "Move job to workstream" }))
    .toBeVisible();
});
it("keeps a workstream active when its routine job is complete", async () => {
  setup();
  state.data = {
    ...state.data!,
    tasks: state.data!.tasks.map((task) => ({
      ...task,
      status: "completed",
      completed: true,
      executionExists: true,
      dispatch: { ...task.dispatch!, state: "sent", reason: "" },
    })),
  };
  await using screen = await render(
    <WorkPanel
      environmentId={environmentId}
      projectId={projectId}
      threadId={ThreadId.make("t3po-channel:research")}
    />,
  );
  await expect.element(screen.getByRole("link", { name: "Measure cold starts" })).toBeVisible();
  await expect
    .element(screen.getByRole("combobox", { name: "Workstream status" }))
    .toHaveValue("active");
  await expect.element(screen.getByRole("button", { name: "Accept" })).not.toBeInTheDocument();
});
it("edits this channel's notes from the revision the user started on", async () => {
  setup();
  state.data = {
    ...state.data!,
    notes: [
      {
        projectId,
        channelId: null,
        text: "Lead chat notes",
        revision: 1,
        updatedAt: "2026-11-24T10:00:00.000Z",
        updatedBy: "user",
      },
      {
        projectId,
        channelId: "research",
        text: "Decision: measure p95",
        revision: 3,
        updatedAt: "2026-11-24T10:00:00.000Z",
        updatedBy: "lead",
      },
    ],
  };
  await using screen = await render(
    <WorkPanel
      environmentId={environmentId}
      projectId={projectId}
      threadId={ThreadId.make("t3po-channel:research")}
    />,
  );
  const notes = screen.getByRole("textbox", { name: "Notes" });
  await expect.element(notes).toHaveValue("Decision: measure p95");
  await expect.element(screen.getByText(/by the lead$/)).toBeVisible();
  await userEvent.fill(notes, "Decision: measure p99");
  await userEvent.click(screen.getByRole("button", { name: "Save notes" }));
  expect(state.mutate).toHaveBeenCalledWith({
    environmentId,
    input: {
      type: "save_notes",
      projectId,
      channelId: "research",
      text: "Decision: measure p99",
      expectedRevision: 3,
    },
  });
  await expect.element(screen.getByRole("button", { name: "Save notes" })).not.toBeInTheDocument();
});
