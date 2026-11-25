import "~/index.css";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";
import { PushNotificationSettings } from "./PushNotificationSettings";

const state = vi.hoisted(() => ({
  calls: [] as unknown[],
  local: null as string | null,
  devices: [] as Array<{ endpoint: string; label: string; createdAt: string }>,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    targets: [{ environmentId: "local", label: "Local" }],
  })) as never,
}));
vi.mock(import("../../t3poPush"), async (original) => ({
  ...(await original()),
  pushSupport: () => "supported",
  devicePushEndpoint: async () => state.local,
  subscribeDevicePush: async () => {
    state.local = "https://push.example/me";
    return { endpoint: state.local, p256dh: "key", auth: "secret" };
  },
  unsubscribeDevicePush: async () => {
    state.local = null;
  },
}));
vi.mock(import("../../state/t3po"), async () => {
  const { Atom, AsyncResult } = await import("effect/reactivity");
  const permissions = Atom.family((allowed: boolean) => Atom.make(allowed));
  const pushState = Atom.make(() =>
    AsyncResult.success({ publicKey: "server-key", devices: state.devices, mutes: [] }),
  );
  return {
    t3po: {
      push: () => pushState,
      pushChange: { permissionAtom: () => permissions(true) },
    },
  } as never;
});
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() =>
    async ({ input }: { input: { type: string; endpoint: string; label?: string } }) => {
      state.calls.push(input);
      if (input.type === "subscribe")
        state.devices = [{ endpoint: input.endpoint, label: input.label ?? "", createdAt: "now" }];
      if (input.type === "unsubscribe")
        state.devices = state.devices.filter((device) => device.endpoint !== input.endpoint);
      return { _tag: "Success" };
    }) as never,
}));

it("subscribes this device, sends a test, and turns it off again", async () => {
  state.calls = [];
  state.local = null;
  state.devices = [];
  using _permission = vi.spyOn(Notification, "requestPermission").mockResolvedValue("granted");
  await using _screen = await render(<PushNotificationSettings />);
  const toggle = page.getByRole("switch", { name: "Notifications on this device" });
  await expect.element(toggle).toBeEnabled();
  await userEvent.click(toggle);
  await expect.element(toggle).toBeChecked();
  expect(state.calls[0]).toMatchObject({
    type: "subscribe",
    endpoint: "https://push.example/me",
    p256dh: "key",
    auth: "secret",
    titles: { completed: "Job finished", approval: "Approval needed" },
  });
  await expect
    .element(page.getByRole("list", { name: "Notified devices" }).getByRole("button"))
    .toHaveTextContent("Remove");

  await userEvent.click(page.getByRole("button", { name: "Send test" }));
  await vi.waitFor(() =>
    expect(state.calls.at(-1)).toEqual({ type: "test", endpoint: "https://push.example/me" }),
  );

  await userEvent.click(toggle);
  await expect.element(toggle).not.toBeChecked();
  expect(state.calls.at(-1)).toEqual({ type: "unsubscribe", endpoint: "https://push.example/me" });
  expect(state.local).toBeNull();
});
