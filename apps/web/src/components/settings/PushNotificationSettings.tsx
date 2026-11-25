import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, T3poPushChange } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { t3po } from "../../state/t3po";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  deviceLabel,
  devicePushEndpoint,
  pushSupport,
  subscribeDevicePush,
  unsubscribeDevicePush,
} from "../../t3poPush";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";

export function PushNotificationSettings() {
  const searchableSetting = useSearchableSetting();
  const gt = useGT();
  const { targets } = useSettingsScope();
  const support = pushSupport();
  const environments = [
    ...new Map(targets.map((target) => [target.environmentId, target.label])).entries(),
  ];
  return (
    <SettingsRow
      {...searchableSetting("push-notifications")}
      description={
        support === "desktop"
          ? gt(
              "The desktop app notifies you while it runs. To be notified when it is closed, turn this on in a browser or the installed web app.",
            )
          : support === "unsupported"
            ? gt(
                "This browser cannot be notified when T3 Code is closed. On iPhone and iPad, add T3 Code to your Home Screen first.",
              )
            : gt(
                "Notify this device when a job finishes, fails, or needs your approval or answer, even when T3 Code is closed.",
              )
      }
    >
      {support === "supported"
        ? environments.map(([environmentId, label]) => (
            <PushEnvironment
              key={environmentId}
              environmentId={environmentId}
              label={environments.length > 1 ? label : null}
            />
          ))
        : null}
    </SettingsRow>
  );
}

function PushEnvironment({
  environmentId,
  label,
}: {
  environmentId: EnvironmentId;
  label: string | null;
}) {
  const gt = useGT();
  const query = useEnvironmentQuery(t3po.push({ environmentId, input: {} }));
  const change = useAtomCommand(t3po.pushChange);
  const canChange = useAtomValue(t3po.pushChange.permissionAtom(environmentId));
  // undefined while this browser's subscription is still being read.
  const [endpoint, setEndpoint] = useState<string | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The push subscription lives in the browser, outside React.
  useEffect(() => {
    let live = true;
    void devicePushEndpoint(environmentId).then(
      (current) => live && setEndpoint(current),
      () => live && setEndpoint(null),
    );
    return () => {
      live = false;
    };
  }, [environmentId]);
  const devices = query.data?.devices ?? [];
  const enabled = !!endpoint && devices.some((device) => device.endpoint === endpoint);

  const send = async (input: T3poPushChange) =>
    (await change({ environmentId, input }))._tag === "Success";
  async function run(task: () => Promise<string | null>) {
    setBusy(true);
    setMessage(null);
    try {
      setMessage(await task());
    } catch {
      setMessage(gt("Could not change notifications on this device."));
    }
    setBusy(false);
    query.refresh();
  }
  const enable = (publicKey: string) =>
    run(async () => {
      if ((await Notification.requestPermission()) !== "granted")
        return gt("Allow notifications in your browser or system settings, then try again.");
      const keys = await subscribeDevicePush(environmentId, publicKey);
      setEndpoint(keys.endpoint);
      const saved = await send({
        type: "subscribe",
        ...keys,
        label: deviceLabel(navigator.userAgent),
        titles: {
          completed: gt("Job finished"),
          failed: gt("Job failed"),
          approval: gt("Approval needed"),
          question: gt("Question for you"),
          test: gt("Notifications are on"),
        },
      });
      return saved ? null : gt("Could not change notifications on this device.");
    });
  const remove = (target: string) =>
    run(async () => {
      const removed = await send({ type: "unsubscribe", endpoint: target });
      if (removed && target === endpoint) {
        await unsubscribeDevicePush(environmentId);
        setEndpoint(null);
      }
      return removed ? null : gt("Could not remove the device.");
    });

  return (
    <div className="mt-3 space-y-2 text-xs">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-sm">{label ?? <T>This device</T>}</span>
        <div className="flex shrink-0 items-center gap-2">
          {enabled && endpoint ? (
            <Button
              size="xs"
              variant="outline"
              disabled={busy || !canChange}
              onClick={() =>
                void run(async () =>
                  (await send({ type: "test", endpoint }))
                    ? null
                    : gt("The test notification could not be sent."),
                )
              }
            >
              <T>Send test</T>
            </Button>
          ) : null}
          <Switch
            checked={enabled}
            disabled={busy || !canChange || !query.data || endpoint === undefined}
            aria-label={gt("Notifications on this device")}
            onCheckedChange={(checked) => {
              if (!query.data) return;
              if (checked) void enable(query.data.publicKey);
              else if (endpoint) void remove(endpoint);
            }}
          />
        </div>
      </div>
      {message || query.error ? (
        <p role="alert" className="text-destructive">
          {message ?? query.error}
        </p>
      ) : null}
      {devices.length > 0 ? (
        <ul aria-label={gt("Notified devices")} className="space-y-1 text-muted-foreground">
          {devices.map((device) => (
            <li key={device.endpoint} className="flex items-center justify-between gap-2">
              <span className="min-w-0 truncate">
                {device.label || gt("Unnamed device")}
                {device.endpoint === endpoint ? <T> (this device)</T> : null}
              </span>
              <Button
                size="xs"
                variant="ghost-destructive"
                disabled={busy || !canChange}
                onClick={() => void remove(device.endpoint)}
              >
                <T>Remove</T>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
