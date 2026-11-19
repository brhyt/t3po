import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { EnvironmentId, ProjectId, type T3poSnapshot } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { SidebarProvider } from "../ui/sidebar";
import { SpaceConnections } from "./SpaceConnections";
import { ProjectSidebar } from "./ProjectSidebar";

const state = vi.hoisted(() => ({
  data: undefined as typeof T3poSnapshot.Type | undefined,
  calls: [] as unknown[],
  archived: false,
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
  useOrchestrationCommand: (() => async (input: unknown) => {
    state.calls.push(input);
    return { _tag: "Success" };
  }) as never,
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
      archivedAt: state.archived ? "2026-11-19T00:00:00Z" : null,
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
  state.archived = false;
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

it("revokes the selected incoming direction and shares a reference with one space", async () => {
  state.archived = false;
  state.calls = [];
  state.data = {
    spaces: [
      { id: "personal", name: "Personal" },
      { id: "business", name: "Business" },
    ],
    projectSpaces: [{ projectId: ProjectId.make("project"), spaceId: "personal" }],
    spaceConnections: [
      {
        sourceSpaceId: "business",
        targetSpaceId: "personal",
        targetProjectId: ProjectId.make("project"),
      },
    ],
    sharedResources: [],
    conversations: [],
    memory: [],
    leads: [],
    channels: [],
    tasks: [],
    nextCursor: null,
  };
  await using screen = await render(
    <SpaceConnections
      environmentId={EnvironmentId.make("roc")}
      projectId={ProjectId.make("project")}
      space={{ id: "personal", name: "Personal" }}
      onClose={() => {}}
    />,
  );
  const grant = screen.getByRole("checkbox", { name: "Business → Personal / Studio" });
  await expect.element(grant).toBeChecked();
  await userEvent.click(grant);
  await vi.waitFor(() =>
    expect(state.calls).toEqual([
      {
        environmentId: "roc",
        input: {
          type: "connect_space",
          projectId: "project",
          sourceSpaceId: "business",
          targetSpaceId: "personal",
          targetProjectId: "project",
          enabled: false,
        },
      },
    ]),
  );
  await userEvent.fill(screen.getByRole("textbox", { name: "Resource name" }), "Design files");
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Folder path or HTTPS address" }),
    "/srv/shared/design",
  );
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Share with" }), "business");
  await userEvent.click(screen.getByRole("button", { name: "Share resource", exact: true }));
  await vi.waitFor(() => expect(state.calls).toHaveLength(2));
  expect(state.calls[1]).toMatchObject({
    environmentId: "roc",
    input: {
      type: "share_resource",
      projectId: "project",
      ownerSpaceId: "personal",
      targetSpaceId: "business",
      name: "Design files",
      location: "/srv/shared/design",
    },
  });
  await expect.element(screen.getByRole("textbox", { name: "Resource name" })).toHaveValue("");
});

it("opens space settings and autosaves rules on blur", async () => {
  state.archived = false;
  state.calls = [];
  state.data = {
    spaces: [{ id: "personal", name: "Personal" }],
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
  await userEvent.click(screen.getByRole("button", { name: "Space settings", exact: true }));
  await userEvent.click(screen.getByRole("button", { name: "Rules", exact: true }));
  await userEvent.fill(
    screen.getByRole("textbox", { name: "Space rules" }),
    "Keep personal purchases separate.",
  );
  await userEvent.click(screen.getByRole("button", { name: "Connections", exact: true }));
  await vi.waitFor(() =>
    expect(state.calls).toEqual([
      {
        environmentId: "roc",
        input: {
          type: "save_space_rules",
          projectId: "project",
          id: "personal",
          rules: "Keep personal purchases separate.",
        },
      },
    ]),
  );
});

it("reveals an archived project through the archive view", async () => {
  state.archived = true;
  state.calls = [];
  state.data = {
    spaces: [],
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
  await expect.element(screen.getByRole("link", { name: /Studio/ })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Archived projects", exact: true }));
  await expect.element(screen.getByRole("link", { name: /Studio/ })).toBeVisible();
  await userEvent.click(screen.getByRole("button", { name: "Active projects", exact: true }));
  await expect.element(screen.getByRole("link", { name: /Studio/ })).not.toBeInTheDocument();
});
