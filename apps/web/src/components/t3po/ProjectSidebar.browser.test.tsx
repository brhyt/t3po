import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ProjectId, type T3poSnapshot } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { ProjectSidebar } from "./ProjectSidebar";

const state = vi.hoisted(() => ({
  data: undefined as typeof T3poSnapshot.Type | undefined,
  calls: [] as unknown[],
}));
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: state.data,
    isPending: false,
    error: null,
    refresh: () => {},
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => async (input: unknown) => {
    state.calls.push(input);
    return { _tag: "Success" };
  }) as never,
}));
vi.mock(import("../../state/use-orchestration-command"), () => ({
  useOrchestrationCommand: (() => vi.fn()) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: (() => true) as never,
}));
vi.mock(import("../../state/t3po"), async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    t3po: { snapshot: () => undefined, mutate: { permissionAtom: () => Atom.make(true) } } as never,
  };
});
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    {
      environmentId: "roc",
      id: "project",
      title: "Studio",
      workspaceRoot: "/home/grr/Studio",
      archivedAt: null,
    },
  ]) as never,
  useThreadShell: (() => undefined) as never,
  useThreadShellsForProjectRefs: (() => []) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({ environments: [{ environmentId: "roc", label: "roc" }] })) as never,
}));

it("renames a Space inline on Enter once and cancels an unsaved rename with Escape", async () => {
  state.calls = [];
  state.data = {
    spaces: [
      { id: "personal", name: "Personal" },
      { id: "business", name: "Business" },
    ],
    projectSpaces: [],
    conversations: [],
    memory: [],
    leads: [],
    channels: [],
    tasks: [],
    nextCursor: null,
  };
  await using screen = await render(
    <SidebarProvider>
      <ProjectSidebar />
    </SidebarProvider>,
  );
  const space = screen.getByRole("button", { name: "Personal", exact: true });
  await userEvent.click(space);
  await userEvent.keyboard("{F2}");
  const editor = screen.getByRole("textbox", { name: "Space name" });
  await expect.element(editor).toBeVisible();
  await userEvent.fill(editor, "Private");
  await userEvent.keyboard("{Enter}");
  await expect.element(editor).not.toBeInTheDocument();
  expect(state.calls).toEqual([
    {
      environmentId: EnvironmentId.make("roc"),
      input: {
        type: "save_space",
        projectId: ProjectId.make("project"),
        id: "personal",
        name: "Private",
      },
    },
  ]);
  await userEvent.click(space);
  await userEvent.keyboard("{F2}");
  await userEvent.fill(screen.getByRole("textbox", { name: "Space name" }), "Discard");
  await userEvent.keyboard("{Escape}");
  await expect.element(screen.getByRole("textbox", { name: "Space name" })).not.toBeInTheDocument();
  expect(state.calls).toHaveLength(1);
});
