import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { AnyRouter } from "@tanstack/react-router";

const WORKER_URL = "/t3po-push-sw.js";

/** One registration per environment: a registration holds one subscription, bound to one server key. */
export function pushScope(environmentId: EnvironmentId): string {
  return `/t3po-push/${encodeURIComponent(environmentId)}/`;
}

export type PushSupport = "supported" | "desktop" | "unsupported";

export function pushSupport(): PushSupport {
  // Electron has no push service; the desktop app notifies while it runs.
  if (window.desktopBridge) return "desktop";
  return window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    typeof Notification !== "undefined"
    ? "supported"
    : "unsupported";
}

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
const fromBase64Url = (value: string) =>
  Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );

export function sameServerKey(key: ArrayBuffer | null | undefined, publicKey: string): boolean {
  return key ? toBase64Url(new Uint8Array(key)) === publicKey : false;
}

/** A recognizable name for this browser in the device list, such as "Chrome · macOS". */
export function deviceLabel(userAgent: string): string {
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /Firefox\//.test(userAgent)
      ? "Firefox"
      : /Chrome\//.test(userAgent)
        ? "Chrome"
        : /Safari\//.test(userAgent)
          ? "Safari"
          : "Web";
  const system = /iPhone|iPad/.test(userAgent)
    ? "iOS"
    : /Android/.test(userAgent)
      ? "Android"
      : /Mac OS X/.test(userAgent)
        ? "macOS"
        : /Windows/.test(userAgent)
          ? "Windows"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  return system ? `${browser} · ${system}` : browser;
}

function registration(environmentId: EnvironmentId) {
  return navigator.serviceWorker.getRegistration(
    new URL(pushScope(environmentId), window.location.origin).href,
  );
}

/** This device's current subscription endpoint for an environment, if it has one. */
export async function devicePushEndpoint(environmentId: EnvironmentId): Promise<string | null> {
  if (pushSupport() !== "supported") return null;
  const subscription = await (await registration(environmentId))?.pushManager.getSubscription();
  return subscription?.endpoint ?? null;
}

function activated(worker: ServiceWorker): Promise<void> {
  if (worker.state === "activated") return Promise.resolve();
  return new Promise((resolve) => {
    worker.addEventListener("statechange", () => {
      if (worker.state === "activated") resolve();
    });
  });
}

export async function subscribeDevicePush(environmentId: EnvironmentId, publicKey: string) {
  const registered = await navigator.serviceWorker.register(WORKER_URL, {
    scope: pushScope(environmentId),
  });
  const worker = registered.active ?? registered.waiting ?? registered.installing;
  if (worker) await activated(worker);
  let subscription = await registered.pushManager.getSubscription();
  // A server whose key changed cannot reach the old subscription.
  if (subscription && !sameServerKey(subscription.options.applicationServerKey, publicKey)) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registered.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: fromBase64Url(publicKey),
  });
  const keys = subscription.toJSON().keys ?? {};
  return { endpoint: subscription.endpoint, p256dh: keys.p256dh ?? "", auth: keys.auth ?? "" };
}

export async function unsubscribeDevicePush(environmentId: EnvironmentId) {
  const registered = await registration(environmentId);
  await (await registered?.pushManager.getSubscription())?.unsubscribe();
  await registered?.unregister();
}

/** A clicked notification focuses an open window, which then opens the thread itself. */
export function startPushNavigation(router: AnyRouter) {
  if (pushSupport() !== "supported") return;
  navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    if (typeof data !== "object" || data === null) return;
    const { type, environmentId, threadId } = data as Record<string, unknown>;
    if (type !== "t3po-push-open" || typeof environmentId !== "string") return;
    if (typeof threadId !== "string" || threadId === "") return;
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId: environmentId as EnvironmentId, threadId: threadId as ThreadId },
    });
  });
  navigator.serviceWorker.startMessages();
}
