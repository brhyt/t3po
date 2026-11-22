import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import type { PrivacyJournal } from "@t3tools/contracts";
import { render } from "../../../test/render";
import { PrivacyPage } from "./PrivacyPage";

vi.mock(import("../chat/GlobalVoiceInputIndicator"), () => ({
  GlobalVoiceInputIndicator: () => null,
}));

const state = vi.hoisted(() => ({
  read: true,
  write: true,
  calls: [] as unknown[],
  data: null as PrivacyJournal | null,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  usePrimaryEnvironmentId: (() => "local") as never,
  useEnvironments: (() => ({
    environments: [
      { environmentId: "local", label: "Local" },
      { environmentId: "remote", label: "Remote" },
    ],
  })) as never,
}));
vi.mock(import("../../state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => state.read,
}));
vi.mock(import("../../state/t3po"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const snapshots = Atom.family((json: string) => Atom.make(AsyncResult.success(JSON.parse(json))));
  const permissions = Atom.family((allowed: boolean) => Atom.make(allowed));
  return {
    t3po: {
      privacySnapshot: ({ environmentId }: { environmentId: string }) =>
        snapshots(JSON.stringify(environmentId === "local" ? state.data : null)),
      privacyChange: { permissionAtom: () => permissions(state.write) },
    },
  } as never;
});
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => async (input: unknown) => {
    state.calls.push(input);
    return { _tag: "Success" };
  }) as never,
}));

function setup() {
  state.read = true;
  state.write = true;
  state.calls = [];
  state.data = {
    label: "test provider",
    coverage: "routed traffic only",
    observed: 2,
    blocked: [],
    events: [
      {
        id: 1,
        time: 1,
        source: "test provider",
        host: "inference.example",
        method: "POST",
        status: "response 200",
        category: "conversation / inference (inferred)",
        fields: ["messages"],
        bodyBytes: 1200,
        scanTruncated: true,
        inspection: "text patterns",
        findings: [{ kind: "email", location: "body", count: 1, expected: false }],
      },
      {
        id: 2,
        time: 2,
        source: "test provider",
        host: "auth.example",
        method: "POST",
        status: "response 200",
        category: "unclassified",
        fields: [],
        bodyBytes: 10,
        scanTruncated: false,
        inspection: "text patterns",
        findings: [
          { kind: "authentication material", location: "header", count: 1, expected: true },
        ],
      },
    ],
  };
}

it("filters sensitive traffic, sends scoped block and unblock actions, and clears the view on machine change", async () => {
  setup();
  state.data = { ...state.data!, blocked: ["blocked.example"] };
  await using _screen = await render(<PrivacyPage />, { router: "/privacy" });
  await expect.element(page.getByRole("heading", { name: "Where your data goes" })).toBeVisible();
  await expect.element(page.getByText("Only the first 1 MiB was scanned.")).toBeVisible();
  await expect.element(page.getByText(/Value masked/)).toBeVisible();
  await userEvent.click(page.getByRole("checkbox", { name: "Possible sensitive data" }));
  await expect.element(page.getByRole("cell", { name: /auth.example/ })).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Unblock", exact: true }));
  await userEvent.fill(page.getByRole("textbox", { name: "Exact hostname" }), "new.example");
  await userEvent.click(page.getByRole("button", { name: "Block", exact: true }).first());
  expect(state.calls).toEqual([
    { environmentId: "local", input: { action: "unblock", host: "blocked.example" } },
    { environmentId: "local", input: { action: "block", host: "new.example" } },
  ]);
  await userEvent.selectOptions(page.getByRole("combobox", { name: "Machine" }), "remote");
  await expect.element(page.getByRole("heading", { name: "Connect the observer" })).toBeVisible();
  await expect
    .element(page.getByRole("cell", { name: /inference.example/ }))
    .not.toBeInTheDocument();
});

it("keeps observations readable without granting rule changes", async () => {
  setup();
  state.write = false;
  await using _screen = await render(<PrivacyPage />, { router: "/privacy" });
  await expect.element(page.getByRole("cell", { name: /inference.example/ })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Clear observations" })).toBeDisabled();
  await expect.element(page.getByRole("textbox", { name: "Exact hostname" })).toBeDisabled();
  expect(state.calls).toEqual([]);
});

it("hides observations when diagnostics access is absent", async () => {
  setup();
  state.read = false;
  await using _screen = await render(<PrivacyPage />, { router: "/privacy" });
  await expect
    .element(page.getByRole("status"))
    .toHaveTextContent("Diagnostics permission is required to view this machine's traffic.");
  await expect.element(page.getByRole("table")).not.toBeInTheDocument();
});
