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
  projectIcon: null as unknown,
  menu: [] as unknown[],
  menuChoice: null as string | null,
  secondMachine: false,
  scratch: false,
  projectChat: false,
  started: [] as unknown[],
  palette: [] as unknown[],
  archived_threads: [] as unknown[],
  deleted_threads: [] as unknown[],
  confirm: true,
  confirmAsked: 0,
}));
vi.mock(import("../../localApi"), async (original) => ({
  ...(await original()),
  readLocalApi: (() => ({
    contextMenu: {
      show: async (items: unknown[]) => {
        state.menu = items;
        return state.menuChoice;
      },
    },
    dialogs: {
      confirm: async () => {
        state.confirmAsked += 1;
        return state.confirm;
      },
    },
  })) as never,
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
vi.mock(import("../../hooks/useThreadActions"), () => ({
  useThreadActions: (() => ({
    archiveThread: async (ref: unknown) => {
      state.archived_threads.push(ref);
      return { _tag: "Success" };
    },
    confirmAndDeleteThread: async (ref: unknown) => {
      state.deleted_threads.push(ref);
      return { _tag: "Success" };
    },
  })) as never,
}));
vi.mock(import("../../commandPaletteBus"), async (original) => ({
  ...(await original()),
  openCommandPalette: ((input: unknown) => {
    state.palette.push(input);
  }) as never,
}));
vi.mock(import("../../hooks/useScratchProject"), () => ({
  useScratchProject: (() => ({
    scratchEnvironmentId: () => "roc",
    scratchWorkspaceRootFor: (id: string) => (id === "roc" ? "/data/scratch" : null),
    openScratchProject: async () => null,
    startScratchThread: async (environmentId: string) => {
      state.started.push(environmentId);
    },
  })) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    {
      environmentId: "roc",
      id: "project",
      title: "Studio",
      workspaceRoot: "/home/grr/Studio",
      archivedAt: state.archived ? "2026-11-19T00:00:00Z" : null,
      projectIcon: state.projectIcon,
      faviconPath: null,
    },
    ...(state.scratch
      ? [
          {
            environmentId: "roc",
            id: "scratch",
            title: "No project",
            workspaceRoot: "/data/scratch",
            archivedAt: null,
            projectIcon: null,
            faviconPath: null,
            isScratch: true,
          },
        ]
      : []),
    ...(state.secondMachine
      ? [
          {
            environmentId: "1421",
            id: "mac-project",
            title: "Mac Notes",
            workspaceRoot: "/Users/me/Notes",
            archivedAt: null,
            projectIcon: null,
            faviconPath: null,
          },
        ]
      : []),
  ]) as never,
  useThreadShell: (() => undefined) as never,
  useThreadShellsForProjectRefs: ((refs: ReadonlyArray<{ projectId: string }>) =>
    state.projectChat && refs.some((ref) => ref.projectId === "project")
      ? [
          {
            id: "studio-chat",
            environmentId: "roc",
            projectId: "project",
            title: "Pick a color palette",
            archivedAt: null,
            lineage: { relationshipToParent: null },
            delegatedFrom: null,
            visibleItemCount: 2,
            latestUserMessageAt: "2026-11-26T02:00:00Z",
            updatedAt: "2026-11-26T02:00:00Z",
            worktreePath: null,
          },
        ]
      : state.scratch && refs.some((ref) => ref.projectId === "scratch")
        ? [
            {
              id: "loose-chat",
              environmentId: "roc",
              projectId: "scratch",
              title: "Quick question about taxes",
              archivedAt: null,
              lineage: { relationshipToParent: null },
              delegatedFrom: null,
              visibleItemCount: 2,
              latestUserMessageAt: "2026-11-26T01:00:00Z",
              updatedAt: "2026-11-26T01:00:00Z",
              worktreePath: null,
            },
          ]
        : []) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironments: (() => ({
    environments: [
      {
        environmentId: "roc",
        label: "roc",
        serverConfig: null,
        connection: { phase: "disconnected" },
      },
      {
        environmentId: "1421",
        label: "1421",
        serverConfig: null,
        connection: { phase: "disconnected" },
      },
    ],
  })) as never,
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
  await expect.element(screen.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Privacy dashboard", exact: true }))
    .toBeVisible();
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

it("turns the browser off for one space from its Tools tab", async () => {
  state.archived = false;
  state.calls = [];
  state.data = {
    spaces: [{ id: "personal", name: "Personal" }],
    projectSpaces: [],
    spaceTools: [],
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
  await userEvent.click(screen.getByRole("button", { name: "Tools", exact: true }));
  await userEvent.selectOptions(screen.getByRole("combobox", { name: "Browser" }), "off");
  await vi.waitFor(() =>
    expect(state.calls).toEqual([
      {
        environmentId: "roc",
        input: {
          type: "set_space_tool",
          projectId: "project",
          spaceId: "personal",
          tool: "browser",
          enabled: false,
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

it("shows a lead-drawn icon and offers to redraw or remove it", async () => {
  state.archived = false;
  state.calls = [];
  state.projectIcon = {
    kind: "generated",
    svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#243047"/></svg>',
  };
  state.menuChoice = "redraw-icon";
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
  const row = screen.getByRole("link", { name: /Studio/ });
  await expect.element(row).toBeVisible();
  // A project in no space is listed under the section that is not kept in memory.
  await expect.element(screen.getByText("Off Record", { exact: true })).toBeVisible();
  expect(row.element().querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/svg\+xml/);
  row.element().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  await vi.waitFor(() =>
    expect(state.calls).toContainEqual({
      environmentId: "roc",
      input: { type: "redraw_project_icon", projectId: "project" },
    }),
  );
  expect(state.menu).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: "redraw-icon" }),
      expect.objectContaining({ id: "remove-icon" }),
    ]),
  );
  state.projectIcon = null;
  state.menuChoice = null;
});

it("lists projects in no space from every machine under one Off Record section", async () => {
  state.archived = false;
  state.secondMachine = true;
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
  try {
    await using screen = await render(
      <SidebarProvider>
        <ProjectSidebar />
      </SidebarProvider>,
    );
    await expect.element(screen.getByRole("link", { name: /Studio/ })).toBeVisible();
    await expect.element(screen.getByRole("link", { name: /Mac Notes/ })).toBeVisible();
    expect(screen.getByText("Off Record", { exact: true }).elements()).toHaveLength(1);
    // Spaces stay per machine, so each machine keeps its own.
    expect(screen.getByText("Personal", { exact: true }).elements()).toHaveLength(2);
    const sections = [...document.querySelectorAll("a")].map((link) => link.textContent ?? "");
    const offRecord = [...document.querySelectorAll("*")].find(
      (node) => node.textContent === "Off Record" && node.children.length === 0,
    )!;
    for (const name of ["Studio", "Mac Notes"]) {
      const link = [...document.querySelectorAll("a")].find((node) =>
        node.textContent?.includes(name),
      )!;
      expect(
        offRecord.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
    expect(sections.some((text) => text.includes("Mac Notes"))).toBe(true);
  } finally {
    state.secondMachine = false;
  }
});

it("keeps conversations with no project under Off Record and starts new ones there", async () => {
  state.archived = false;
  state.scratch = true;
  state.started = [];
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
  try {
    await using screen = await render(
      <SidebarProvider>
        <ProjectSidebar />
      </SidebarProvider>,
    );
    await expect
      .element(screen.getByRole("link", { name: /Quick question about taxes/ }))
      .toBeVisible();
    // The No project itself is not shown as a project with a lead and channels.
    await expect
      .element(screen.getByRole("region", { name: "No project" }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Add to Off Record", exact: true }));
    await userEvent.click(screen.getByRole("menuitem", { name: "New conversation" }));
    await vi.waitFor(() => expect(state.started).toEqual(["roc"]));
    await userEvent.click(screen.getByRole("button", { name: "Add to Off Record", exact: true }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Add project" }));
    await vi.waitFor(() => expect(state.palette).toContainEqual({ open: "add-project" }));
  } finally {
    state.scratch = false;
  }
});

it("archives and deletes conversations, deletes channels and removes projects from their menus", async () => {
  state.archived = false;
  state.scratch = true;
  state.calls = [];
  state.archived_threads = [];
  state.deleted_threads = [];
  state.confirm = true;
  state.data = {
    spaces: [],
    projectSpaces: [],
    conversations: [],
    memory: [],
    leads: [],
    channels: [
      { id: "research", projectId: ProjectId.make("project"), name: "Research", archived: false },
    ],
    tasks: [],
    nextCursor: null,
  };
  const rightClick = (element: Element) =>
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  try {
    await using screen = await render(
      <SidebarProvider>
        <ProjectSidebar />
      </SidebarProvider>,
    );
    const chat = screen.getByRole("link", { name: /Quick question about taxes/ });
    await expect.element(chat).toBeVisible();
    state.menuChoice = "archive";
    rightClick(chat.element());
    await vi.waitFor(() =>
      expect(state.archived_threads).toEqual([{ environmentId: "roc", threadId: "loose-chat" }]),
    );
    state.menuChoice = "delete";
    rightClick(chat.element());
    await vi.waitFor(() => expect(state.deleted_threads).toHaveLength(1));

    state.menuChoice = "delete";
    rightClick(screen.getByRole("link", { name: "Research" }).element());
    await vi.waitFor(() =>
      expect(state.calls).toContainEqual({
        environmentId: "roc",
        input: { type: "delete_channel", projectId: "project", id: "research" },
      }),
    );

    // Declining the confirmation leaves the project alone.
    state.confirm = false;
    state.menuChoice = "remove-project";
    const asked = state.confirmAsked;
    rightClick(screen.getByRole("link", { name: /Studio/ }).element());
    await vi.waitFor(() => expect(state.confirmAsked).toBe(asked + 1));
    expect(JSON.stringify(state.calls)).not.toContain("force");
    state.confirm = true;
    rightClick(screen.getByRole("link", { name: /Studio/ }).element());
    await vi.waitFor(() =>
      expect(state.calls).toContainEqual({
        environmentId: "roc",
        input: { projectId: "project", force: true },
      }),
    );
  } finally {
    state.scratch = false;
    state.menuChoice = null;
  }
});

it("only offers to remove a project in a space once it is archived", async () => {
  state.calls = [];
  state.data = {
    spaces: [{ id: "personal", name: "Personal" }],
    projectSpaces: [{ projectId: ProjectId.make("project"), spaceId: "personal" }],
    conversations: [],
    memory: [],
    leads: [],
    channels: [],
    tasks: [],
    nextCursor: null,
  };
  const menuIds = () => (state.menu as ReadonlyArray<{ id: string }>).map((item) => item.id);
  const rightClick = (element: Element) =>
    element.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  try {
    state.archived = false;
    state.menu = [];
    await using active = await render(
      <SidebarProvider>
        <ProjectSidebar />
      </SidebarProvider>,
    );
    rightClick(active.getByRole("link", { name: /Studio/ }).element());
    await vi.waitFor(() => expect(menuIds()).toContain("archive"));
    expect(menuIds()).not.toContain("remove-project");
  } finally {
    state.menu = [];
  }
  state.archived = true;
  await using archived = await render(
    <SidebarProvider>
      <ProjectSidebar />
    </SidebarProvider>,
  );
  await userEvent.click(archived.getByRole("button", { name: "Archived projects", exact: true }));
  rightClick(archived.getByRole("link", { name: /Studio/ }).element());
  await vi.waitFor(() => expect(menuIds()).toContain("remove-project"));
  state.archived = false;
});

it("moves a conversation with no project into a project on the same machine", async () => {
  state.archived = false;
  state.scratch = true;
  state.secondMachine = true;
  state.calls = [];
  state.menu = [];
  state.menuChoice = "project:project";
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
  try {
    await using screen = await render(
      <SidebarProvider>
        <ProjectSidebar />
      </SidebarProvider>,
    );
    const row = screen.getByRole("link", { name: /Quick question about taxes/ });
    await expect.element(row).toBeVisible();
    row.element().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(state.calls).toContainEqual({
        environmentId: "roc",
        input: {
          type: "move_conversation_project",
          projectId: "scratch",
          threadId: "loose-chat",
          targetProjectId: "project",
        },
      }),
    );
    // Only this machine's other projects are offered; the Mac's project is not.
    expect((state.menu as unknown[])[0]).toEqual({
      id: "move-project",
      label: "Move to project",
      disabled: false,
      children: [{ id: "project:project", label: "Studio" }],
    });
  } finally {
    state.scratch = false;
    state.secondMachine = false;
    state.menuChoice = null;
  }
});

it("moves a project conversation back to No project from its menu", async () => {
  state.archived = false;
  state.scratch = true;
  state.projectChat = true;
  state.calls = [];
  state.menu = [];
  state.menuChoice = "project:scratch";
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
  try {
    await using screen = await render(
      <SidebarProvider>
        <ProjectSidebar />
      </SidebarProvider>,
    );
    const row = screen.getByRole("link", { name: /Pick a color palette/ });
    await expect.element(row).toBeVisible();
    row.element().dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    await vi.waitFor(() =>
      expect(state.calls).toContainEqual({
        environmentId: "roc",
        input: {
          type: "move_conversation_project",
          projectId: "project",
          threadId: "studio-chat",
          targetProjectId: "scratch",
        },
      }),
    );
    expect(state.menu).toContainEqual({
      id: "move-project",
      label: "Move to project",
      disabled: false,
      children: [{ id: "project:scratch", label: "No project" }],
    });
    // Choosing a project does not also move it between channels.
    expect(state.calls).toHaveLength(1);
  } finally {
    state.scratch = false;
    state.projectChat = false;
    state.menuChoice = null;
  }
});
