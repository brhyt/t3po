import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import {
  EnvironmentId,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
  type T3poSnapshot,
} from "@t3tools/contracts";
import { render } from "../../../test/render";
import { WorkPanel } from "./WorkPanel";

const state = vi.hoisted(() => ({
  data: undefined as typeof T3poSnapshot.Type | undefined,
  scheduled: [] as ReadonlyArray<ScheduledTask>,
  toggle: vi.fn(),
  remove: vi.fn(),
  mutate: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock(import("../../state/query"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentQuery: ((atom: unknown) =>
    atom === "scheduled-tasks"
      ? { data: { tasks: state.scheduled, timeZone: "UTC" }, isPending: false, error: null }
      : { data: atom === "push" ? null : state.data, isPending: false, error: null }) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomCommand: ((command: { name?: string }) =>
    command.name === "toggle"
      ? state.toggle
      : command.name === "remove"
        ? state.remove
        : state.mutate) as never,
}));
vi.mock(import("../../confirmDialog"), async (importOriginal) => ({
  ...(await importOriginal()),
  requestConfirmDialog: (async () => true) as never,
}));
vi.mock(import("../../state/t3po"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    t3po: {
      snapshot: () => undefined,
      mutate: { permissionAtom: () => Atom.make(true) },
      push: () => "push",
      pushChange: { permissionAtom: () => Atom.make(true) },
    } as never,
  };
});
vi.mock(import("../../state/server"), async (importOriginal) => {
  const { Atom } = await import("effect/reactivity");
  const original = await importOriginal();
  return {
    ...original,
    serverEnvironment: {
      ...original.serverEnvironment,
      scheduledTasksLive: () => "scheduled-tasks",
      setScheduledTaskEnabled: { name: "toggle", permissionAtom: () => Atom.make(true) },
      deleteScheduledTask: { name: "remove" },
    } as never,
  };
});
const projectId = ProjectId.make("project");
const environmentId = EnvironmentId.make("environment");
function setup() {
  state.mutate = vi.fn(async () => ({ _tag: "Success" }));
  state.scheduled = [];
  state.toggle.mockReset().mockResolvedValue({ _tag: "Success" });
  state.remove.mockReset().mockResolvedValue({ _tag: "Success" });
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
it("lists this chat's schedules with pause and delete", async () => {
  setup();
  const scheduled = (id: string, threadId: string, title: string): ScheduledTask =>
    ({
      id: ScheduledTaskId.make(id),
      threadId: ThreadId.make(threadId),
      projectId,
      title,
      prompt: title,
      enabled: true,
      schedule: { type: "fixed_time", timeOfDay: "09:00", weekdays: [1] },
      nextRunAt: "2999-01-07T09:00:00.000Z",
      lastRunAt: "2026-11-23T09:00:00.000Z",
      lastRunStatus: "succeeded",
      lastRunError: null,
    }) as unknown as ScheduledTask;
  state.scheduled = [
    scheduled("signups", "t3po-channel:research", "Weekly signups"),
    scheduled("elsewhere", "t3po-channel:other", "Other chat schedule"),
  ];
  await using screen = await render(
    <WorkPanel
      environmentId={environmentId}
      projectId={projectId}
      threadId={ThreadId.make("t3po-channel:research")}
    />,
  );
  const section = screen.getByRole("region", { name: "Scheduled" });
  await expect.element(section.getByText("Weekly signups")).toBeVisible();
  await expect.element(section.getByText(/at 09:00/)).toBeVisible();
  await expect.element(section.getByText(/Succeeded/)).toBeVisible();
  await expect.element(screen.getByText("Other chat schedule")).not.toBeInTheDocument();
  // The small switch has no layout box here, so click it through the DOM.
  (screen.getByRole("switch", { name: "Pause Weekly signups" }).element() as HTMLElement).click();
  await vi.waitFor(() =>
    expect(state.toggle).toHaveBeenCalledWith({
      environmentId,
      input: { id: "signups", enabled: false },
    }),
  );
  await screen.getByRole("button", { name: "Delete Weekly signups" }).click();
  await vi.waitFor(() =>
    expect(state.remove).toHaveBeenCalledWith({ environmentId, input: { id: "signups" } }),
  );
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
