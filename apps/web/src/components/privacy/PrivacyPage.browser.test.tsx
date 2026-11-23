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
  catalog: null as unknown,
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
      controls: () =>
        snapshots(
          JSON.stringify({
            serverTelemetry: "off",
            serverRelayTracing: "off",
            customDiagnostics: [],
            hostAllowlist: null,
            providers: [],
          }),
        ),
      activity: () => snapshots("null"),
      activityChange: { permissionAtom: () => permissions(state.write) },
      providerChange: { permissionAtom: () => permissions(state.write) },
      privacySources: () => snapshots(JSON.stringify(state.catalog)),
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
  state.catalog = null;
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

it("isolates views and search state when switching machines", async () => {
  setup();
  await using _screen = await render(<PrivacyPage />, { router: "/privacy" });
  await expect.element(page.getByRole("heading", { name: "Evidence at a glance" })).toBeVisible();
  await expect.element(page.getByRole("table")).not.toBeInTheDocument();
  await userEvent.click(page.getByRole("button", { name: "Data flows", exact: true }));
  await userEvent.click(page.getByText("Inspect masked metadata").last());
  await expect.element(page.getByText("Only the first 1 MiB was scanned.")).toBeVisible();
  await userEvent.click(page.getByRole("checkbox", { name: "Possible sensitive data" }));
  await expect.element(page.getByRole("cell", { name: /auth.example/ })).toBeVisible();
  await userEvent.click(page.getByRole("button", { name: "Block", exact: true }).last());
  expect(state.calls).toEqual([
    { environmentId: "local", input: { action: "block", host: "inference.example" } },
  ]);
  await userEvent.fill(
    page.getByRole("textbox", { name: "Search source, destination or fields" }),
    "missing.example",
  );
  await userEvent.selectOptions(page.getByRole("combobox", { name: "Machine" }), "remote");
  await expect.element(page.getByRole("heading", { name: "Connect the observer" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Overview", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await userEvent.selectOptions(page.getByRole("combobox", { name: "Machine" }), "local");
  await userEvent.click(page.getByRole("button", { name: "Data flows", exact: true }));
  await expect
    .element(page.getByRole("textbox", { name: "Search source, destination or fields" }))
    .toHaveValue("");
  await expect.element(page.getByRole("cell", { name: /auth.example/ })).toBeVisible();
});

it("keeps observations readable without granting rule changes", async () => {
  setup();
  state.write = false;
  await using _screen = await render(<PrivacyPage />, { router: "/privacy" });
  await userEvent.click(page.getByRole("button", { name: "Data flows", exact: true }));
  await expect.element(page.getByRole("cell", { name: /inference.example/ })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Clear observations" })).toBeDisabled();
  await userEvent.click(page.getByRole("button", { name: "Experiments", exact: true }));
  await expect.element(page.getByRole("button", { name: "Start timed block" })).toBeDisabled();
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

it("starts a scoped timed block and restores access without inferring task success", async () => {
  setup();
  state.data = {
    ...state.data!,
    component: { name: "observer", version: "fixture", identityKind: "source-hash" },
    policyStorage: { status: "ready", persistenceError: false },
    experiments: [
      {
        id: "fixture",
        host: "inference.example",
        startedAt: 1,
        expiresAt: 301,
        recoveryAt: null,
        finishedAt: null,
        phase: "blocked",
        baselineStartedAt: 1,
        baselineEndedAt: 1,
        evidenceIncomplete: false,
        outcome: "unknown",
        evidence: "bounded-proxy-observations",
        baseline: { observed: 1, blocked: 0, responses: 1, errors: 0 },
        blocked: { observed: 1, blocked: 1, responses: 0, errors: 0 },
        recovery: { observed: 0, blocked: 0, responses: 0, errors: 0 },
      },
    ],
  };
  await using _screen = await render(<PrivacyPage />, { router: "/privacy" });
  await userEvent.click(page.getByRole("button", { name: "Experiments", exact: true }));
  await expect.element(page.getByRole("button", { name: "Save outcome" })).not.toBeInTheDocument();
  await expect
    .element(page.getByRole("textbox", { name: "Safe task reference" }))
    .not.toBeInTheDocument();
  await userEvent.fill(page.getByRole("textbox", { name: "Exact hostname" }), "new.example");
  await userEvent.click(page.getByRole("button", { name: "Start timed block" }));
  await userEvent.click(page.getByRole("button", { name: "Restore access and collect recovery" }));
  await expect.element(page.getByText(/Task outcome unknown/)).toBeVisible();
  expect(state.calls).toEqual([
    {
      environmentId: "local",
      input: { action: "start-experiment", host: "new.example", durationSeconds: 300 },
    },
    { environmentId: "local", input: { action: "stop-experiment", experimentId: "fixture" } },
  ]);
});

it.each([true, false])(
  "records a user outcome separately and requires confirmation to delete finished evidence (write=%s)",
  async (write) => {
    setup();
    state.write = write;
    state.data = {
      ...state.data!,
      supportedActions: ["experiment-metadata", "experiment-outcome", "delete-experiment"],
      policyStorage: { status: "ready", persistenceError: false },
      experiments: [
        {
          id: "finished",
          host: "inference.example",
          startedAt: 1,
          expiresAt: 301,
          recoveryAt: 2,
          finishedAt: 3,
          phase: "finished",
          baselineStartedAt: 1,
          baselineEndedAt: 1,
          evidenceIncomplete: true,
          outcome: "unknown",
          evidence: "bounded-proxy-observations",
          baseline: { observed: 1, blocked: 0, responses: 1, errors: 0 },
          blocked: { observed: 1, blocked: 1, responses: 0, errors: 0 },
          recovery: { observed: 1, blocked: 0, responses: 1, errors: 0 },
        },
      ],
    };
    await using _screen = await render(<PrivacyPage />, { router: "/privacy" });
    await userEvent.click(page.getByRole("button", { name: "Experiments", exact: true }));
    await expect.element(page.getByText(/Task outcome unknown/)).toBeVisible();
    if (!write) {
      await expect.element(page.getByRole("button", { name: "Save outcome" })).toBeDisabled();
      await expect
        .element(page.getByRole("button", { name: "Delete experiment", exact: true }))
        .toBeDisabled();
      expect(state.calls).toEqual([]);
      return;
    }

    await userEvent.selectOptions(
      page.getByRole("combobox", { name: "User-reported outcome" }),
      "failed",
    );
    await userEvent.click(page.getByRole("button", { name: "Save outcome" }));
    expect(state.calls).toEqual([
      {
        environmentId: "local",
        input: { action: "experiment-outcome", experimentId: "finished", outcome: "failed" },
      },
    ]);
    await userEvent.click(page.getByRole("button", { name: "Delete experiment", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Cancel", exact: true }));
    expect(state.calls).toHaveLength(1);
    await userEvent.click(page.getByRole("button", { name: "Delete experiment", exact: true }));
    await userEvent.selectOptions(page.getByRole("combobox", { name: "Machine" }), "remote");
    await expect
      .element(page.getByRole("button", { name: "Confirm deletion" }))
      .not.toBeInTheDocument();
    await userEvent.selectOptions(page.getByRole("combobox", { name: "Machine" }), "local");
    await userEvent.click(page.getByRole("button", { name: "Experiments", exact: true }));
    await expect
      .element(page.getByRole("button", { name: "Confirm deletion" }))
      .not.toBeInTheDocument();
    await userEvent.click(page.getByRole("button", { name: "Delete experiment", exact: true }));
    await userEvent.click(page.getByRole("button", { name: "Confirm deletion" }));
    expect(state.calls).toEqual([
      {
        environmentId: "local",
        input: { action: "experiment-outcome", experimentId: "finished", outcome: "failed" },
      },
      { environmentId: "local", input: { action: "delete-experiment", experimentId: "finished" } },
    ]);
  },
);
