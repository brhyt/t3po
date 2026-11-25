// @effect-diagnostics-next-line nodeBuiltinImport:off -- The test decrypts as a browser would.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { ProjectId, type T3poPushPayload } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Changes from "./Changes.ts";
import * as Store from "./Store.ts";
import * as Push from "./Push.ts";

const projectId = ProjectId.make("project");
const titles = {
  completed: "Fertig",
  failed: "Fehlgeschlagen",
  approval: "Freigabe",
  question: "Frage",
  test: "Test",
};

/** A browser's side of a subscription: its keys, and decryption of what reaches it. */
function browser(endpoint: string) {
  const ecdh = NodeCrypto.createECDH("prime256v1");
  const publicKey = ecdh.generateKeys();
  const auth = NodeCrypto.randomBytes(16);
  const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: string | Uint8Array, length: number) =>
    Buffer.from(NodeCrypto.hkdfSync("sha256", ikm, salt, info, length));
  return {
    subscribe: {
      type: "subscribe" as const,
      endpoint,
      p256dh: publicKey.toString("base64url"),
      auth: auth.toString("base64url"),
      label: endpoint,
      titles,
    },
    decrypt(body: Uint8Array) {
      const data = Buffer.from(body);
      const salt = data.subarray(0, 16);
      const sender = data.subarray(21, 21 + data[20]!);
      const record = data.subarray(21 + data[20]!);
      const ikm = hkdf(
        ecdh.computeSecret(sender),
        auth,
        Buffer.concat([Buffer.from("WebPush: info\0"), publicKey, sender]),
        32,
      );
      const decipher = NodeCrypto.createDecipheriv(
        "aes-128-gcm",
        hkdf(ikm, salt, "Content-Encoding: aes128gcm\0", 16),
        hkdf(ikm, salt, "Content-Encoding: nonce\0", 12),
      );
      decipher.setAuthTag(record.subarray(-16));
      const padded = Buffer.concat([decipher.update(record.subarray(0, -16)), decipher.final()]);
      return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString()) as T3poPushPayload;
    },
  };
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

const vapidSecret = NodeCrypto.randomBytes(32);
const pushLayer = (sent: Sent[], status = (_url: string) => 201) =>
  Layer.effect(Push.Push, Push.make).pipe(
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            sent.push({
              url: request.url,
              headers: request.headers,
              body: request.body._tag === "Uint8Array" ? request.body.body : new Uint8Array(),
            });
            return HttpClientResponse.fromWeb(
              request,
              new Response(null, { status: status(request.url) }),
            );
          }),
        ),
      ),
    ),
    Layer.provide(
      Layer.succeed(ServerSecretStore.ServerSecretStore, {
        getOrCreateRandom: () => Effect.succeed(vapidSecret),
      } as unknown as ServerSecretStore.ServerSecretStore["Service"]),
    ),
  );
const fixture = Store.layer.pipe(
  Layer.provideMerge(Changes.layer),
  Layer.provideMerge(Sqlite.layerMemory),
);

const seed = Effect.gen(function* () {
  const store = yield* Store.Store;
  yield* store.mutate({ type: "save_lead", projectId, name: "Lead", brief: "Ship it" });
  yield* store.mutate({ type: "create_channel", projectId, id: "quiet", name: "Quiet" });
  for (const [id, channelId] of [
    ["done", null],
    ["broken", null],
    ["stopped", null],
    ["muted", "quiet"],
  ] as const)
    yield* store.mutate({
      type: "create_task",
      projectId,
      id,
      channelId,
      title: `Job ${id}`,
      brief: "Do it",
      workspace: { type: "worktree" },
    });
});
const finish = (task: string, ordinal: number, status: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const runId = `${task}:${ordinal}`;
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${runId}, ${`t3po-task:${task}`}, ${ordinal}, 'codex', ${status}, 'now', '{}')`;
    yield* sql`INSERT INTO t3po_task_executions (run_id, task_id, revision, result_json) VALUES (${runId}, ${task}, 1, json_object('status', ${status}, 'text', 'report'))`;
  });
const request = (id: string, threadId: string, kind: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json) VALUES (${id}, ${threadId}, 'node', ${kind}, 'pending', 'now', '{}')`;
  });

it("encrypts payloads a browser can read and signs VAPID for the push origin", () => {
  const device = browser("https://push.example/send/1");
  const keys = Push.vapidKeys(vapidSecret);
  const body = Push.encryptPayload(
    Buffer.from(JSON.stringify({ title: "Hi", body: "", threadId: "", tag: "" })),
    device.subscribe.p256dh,
    device.subscribe.auth,
  );
  expect(device.decrypt(body)).toEqual({ title: "Hi", body: "", threadId: "", tag: "" });
  const header = Push.vapidAuthorization(device.subscribe.endpoint, keys, 1_000);
  const [, token, publicKey] = /^vapid t=(\S+), k=(\S+)$/.exec(header) ?? [];
  const [head, claims, signature] = token!.split(".");
  expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toMatchObject({
    aud: "https://push.example",
    exp: 1_000 + 12 * 60 * 60,
  });
  const verifier = NodeCrypto.createPublicKey({
    key: Buffer.concat([
      // SPKI prefix for an uncompressed P-256 point.
      Buffer.from("3059301306072a8648ce3d020106082a8648ce3d030107034200", "hex"),
      Buffer.from(publicKey!, "base64url"),
    ]),
    format: "der",
    type: "spki",
  });
  expect(
    NodeCrypto.verify(
      "sha256",
      Buffer.from(`${head}.${claims}`),
      { key: verifier, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    ),
  ).toBe(true);
});

it.effect("stores devices and mutes, and refuses non-https endpoints", () =>
  Effect.gen(function* () {
    const sent: Sent[] = [];
    const push = yield* Push.Push.pipe(Effect.provide(pushLayer(sent)));
    const phone = browser("https://push.example/phone");
    yield* push.change(phone.subscribe);
    yield* push.change({ ...phone.subscribe, label: "Phone" });
    yield* push.change(browser("https://push.example/laptop").subscribe);
    const refused = yield* push
      .change(browser("http://push.example/plain").subscribe)
      .pipe(Effect.flip);
    expect(refused.operation).toBe("invalid");
    yield* push.change({ type: "mute", projectId, channelId: "quiet", muted: true });
    yield* push.change({ type: "mute", projectId, channelId: null, muted: true });
    yield* push.change({ type: "mute", projectId, channelId: null, muted: false });
    yield* push.change({ type: "unsubscribe", endpoint: "https://push.example/laptop" });
    const state = yield* push.state;
    expect(state.publicKey).toBe(Push.vapidKeys(vapidSecret).publicKey);
    expect(state.devices.map(({ endpoint, label }) => ({ endpoint, label }))).toEqual([
      { endpoint: "https://push.example/phone", label: "Phone" },
    ]);
    expect(state.mutes).toEqual([{ projectId, channelId: "quiet" }]);
    yield* push.change({ type: "test", endpoint: "https://push.example/phone" });
    expect(sent.map((entry) => phone.decrypt(entry.body))).toEqual([
      { title: "Test", body: "Phone", threadId: "", tag: "t3po-test" },
    ]);
  }).pipe(Effect.provide(fixture)),
);

it.effect("notifies once per job outcome and pending request, across restarts", () =>
  Effect.gen(function* () {
    yield* seed;
    const sent: Sent[] = [];
    const device = browser("https://push.example/device");
    const push = yield* Push.Push.pipe(Effect.provide(pushLayer(sent)));
    yield* push.change(device.subscribe);
    yield* push.change({ type: "mute", projectId, channelId: "quiet", muted: true });

    yield* finish("done", 1, "completed");
    yield* finish("broken", 1, "failed");
    yield* finish("stopped", 1, "cancelled");
    yield* finish("muted", 1, "completed");
    // Only the latest run of a job reports.
    yield* finish("done", 2, "running");
    yield* finish("broken", 2, "completed");
    yield* request("ask", "t3po-task:stopped", "user_input");
    yield* request("approve", `t3po-lead:${projectId}`, "command_approval");
    yield* request("elsewhere", "ordinary-thread", "command_approval");
    yield* request("muted-ask", "t3po-task:muted", "user_input");
    yield* push.scan;
    yield* push.scan;
    const received = () =>
      sent
        .filter((entry) => entry.url === device.subscribe.endpoint)
        .map((entry) => device.decrypt(entry.body))
        .map(({ title, body, threadId }) => ({ title, body, threadId }))
        .toSorted((a, b) => a.threadId.localeCompare(b.threadId) || a.title.localeCompare(b.title));
    expect(received()).toEqual([
      { title: "Freigabe", body: "Lead", threadId: "t3po-lead:project" },
      { title: "Fertig", body: "Job broken", threadId: "t3po-task:broken" },
      { title: "Frage", body: "Job stopped", threadId: "t3po-task:stopped" },
    ]);
    expect(sent[0]?.headers).toMatchObject({ "content-encoding": "aes128gcm", ttl: "86400" });

    // A restarted server keeps what it already sent, and a gone device is dropped.
    sent.length = 0;
    const restarted = yield* Push.Push.pipe(
      Effect.provide(pushLayer(sent, (url) => (url.endsWith("/gone") ? 410 : 201))),
    );
    yield* restarted.change(browser("https://push.example/gone").subscribe);
    yield* restarted.scan;
    expect(sent).toEqual([]);
    yield* finish("done", 3, "failed");
    yield* restarted.scan;
    expect(received()).toEqual([
      { title: "Fehlgeschlagen", body: "Job done", threadId: "t3po-task:done" },
    ]);
    expect(sent.map((entry) => entry.url).toSorted()).toEqual([
      "https://push.example/device",
      "https://push.example/gone",
    ]);
    expect((yield* restarted.state).devices.map((entry) => entry.endpoint)).toEqual([
      "https://push.example/device",
    ]);
  }).pipe(Effect.provide(fixture)),
);
