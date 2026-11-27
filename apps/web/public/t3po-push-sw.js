// Shows t3po push notifications while no T3RO window is open. Registered once per environment,
// at scope /t3po-push/<environmentId>/, so each server keeps its own push subscription. It has no
// fetch handler and never controls app pages.

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    // An undecodable message still shows, untitled.
  }
  const text = (value) => (typeof value === "string" ? value : "");
  event.waitUntil(
    self.registration.showNotification(text(data.title) || "T3RO", {
      body: text(data.body),
      tag: text(data.tag) || undefined,
      icon: "/ro-192.png",
      data: { threadId: text(data.threadId) },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const environmentId = decodeURIComponent(
    new URL(self.registration.scope).pathname.split("/").filter(Boolean).at(-1) ?? "",
  );
  const threadId = event.notification.data?.threadId ?? "";
  const path =
    environmentId && threadId
      ? `/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}`
      : "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows[0];
      if (!open) return self.clients.openWindow(path);
      // Client.postMessage has no targetOrigin; the client is same-origin by definition.
      // oxlint-disable-next-line unicorn/require-post-message-target-origin
      open.postMessage({ type: "t3po-push-open", environmentId, threadId });
      return open.focus();
    }),
  );
});
