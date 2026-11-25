// @effect-diagnostics-next-line nodeBuiltinImport:off -- Web Push needs P-256 ECDH, HKDF and AES-GCM, which only node:crypto provides here.
import * as NodeCrypto from "node:crypto";
import {
  ProjectId,
  T3poError,
  isT3poError,
  type T3poPushChange,
  type T3poPushPayload,
  type T3poPushState,
  T3poPushTitles,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

const VAPID_SECRET = "t3po-push-vapid-key";
// Apple rejects VAPID tokens without a mailto: or https: subject; push services contact this page.
const VAPID_SUBJECT = "https://t3po.ro.computer";
const RECORD_SIZE = 4096;

const b64u = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number) =>
  Buffer.from(NodeCrypto.hkdfSync("sha256", ikm, salt, info, length));

export interface VapidKeys {
  readonly publicKey: string;
  readonly key: NodeCrypto.KeyObject;
}

/** Derives the server's VAPID keypair from a stored 32-byte P-256 private scalar. */
export function vapidKeys(privateKey: Uint8Array): VapidKeys {
  const ecdh = NodeCrypto.createECDH("prime256v1");
  ecdh.setPrivateKey(privateKey);
  const point = ecdh.getPublicKey();
  const key = NodeCrypto.createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      d: b64u(privateKey),
      x: b64u(point.subarray(1, 33)),
      y: b64u(point.subarray(33)),
    },
    format: "jwk",
  });
  return { publicKey: b64u(point), key };
}

/** RFC 8292 `Authorization` header for one push service origin. */
export function vapidAuthorization(endpoint: string, keys: VapidKeys, nowSeconds: number) {
  const encode = (value: object) => b64u(Buffer.from(JSON.stringify(value)));
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({
    aud: new URL(endpoint).origin,
    exp: nowSeconds + 12 * 60 * 60,
    sub: VAPID_SUBJECT,
  })}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(unsigned), {
    key: keys.key,
    dsaEncoding: "ieee-p1363",
  });
  return `vapid t=${unsigned}.${b64u(signature)}, k=${keys.publicKey}`;
}

/** Whether a browser's keys can encrypt a message: a P-256 point and a 16-byte auth secret. */
function validSubscriptionKeys(p256dh: string, auth: string): boolean {
  try {
    const receiver = Buffer.from(p256dh, "base64url");
    if (receiver.length !== 65 || receiver[0] !== 4) return false;
    if (Buffer.from(auth, "base64url").length !== 16) return false;
    const ecdh = NodeCrypto.createECDH("prime256v1");
    ecdh.generateKeys();
    ecdh.computeSecret(receiver);
    return true;
  } catch {
    return false;
  }
}

/** RFC 8291 `aes128gcm` message encryption for a browser's subscription keys. */
export function encryptPayload(plaintext: Uint8Array, p256dh: string, auth: string): Buffer {
  const receiver = Buffer.from(p256dh, "base64url");
  const ecdh = NodeCrypto.createECDH("prime256v1");
  const sender = ecdh.generateKeys();
  const salt = NodeCrypto.randomBytes(16);
  const ikm = hkdf(
    ecdh.computeSecret(receiver),
    Buffer.from(auth, "base64url"),
    Buffer.concat([Buffer.from("WebPush: info\0"), receiver, sender]),
    32,
  );
  const cek = hkdf(ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12);
  const cipher = NodeCrypto.createCipheriv("aes-128-gcm", cek, nonce);
  const record = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(sender.length, 20);
  return Buffer.concat([header, sender, record]);
}

interface Subscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  label: string;
  titles: string;
  createdAt: string;
}

export interface Signal {
  key: string;
  kind: "completed" | "failed" | "approval" | "question";
  threadId: string;
  title: string | null;
  projectId: string | null;
  channelId: string | null;
}

const FALLBACK_TITLES: T3poPushTitles = {
  completed: "Job finished",
  failed: "Job failed",
  approval: "Approval needed",
  question: "Question for you",
  test: "Notifications are on",
};

/** New job outcomes and pending requests in t3po threads that no notification has covered yet. */
const pendingSignals = Effect.fn("T3poPush.pendingSignals")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const jobs = yield* sql<Signal>`SELECT 'job:' || e.run_id AS key,
      CASE json_extract(e.result_json, '$.status') WHEN 'completed' THEN 'completed' ELSE 'failed' END AS kind,
      json_extract(t.data, '$.threadId') AS threadId, json_extract(t.data, '$.title') AS title,
      t.project_id AS projectId, json_extract(t.data, '$.channelId') AS channelId
    FROM t3po_task_executions e
    JOIN t3po_tasks t ON t.id = e.task_id
    JOIN orchestration_v2_projection_runs r ON r.run_id = e.run_id
    WHERE json_extract(e.result_json, '$.status') IN ('completed', 'failed')
      AND NOT EXISTS (SELECT 1 FROM t3po_push_sent s WHERE s.key = 'job:' || e.run_id)
      AND r.ordinal = (SELECT max(ordinal) FROM orchestration_v2_projection_runs WHERE thread_id = r.thread_id)
    LIMIT 50`;
  // Requests outside t3po threads are recorded too, so they are not rescanned while pending.
  const requests = yield* sql<Signal>`SELECT 'request:' || q.runtime_request_id AS key,
      CASE q.kind WHEN 'user_input' THEN 'question' ELSE 'approval' END AS kind,
      q.thread_id AS threadId, COALESCE(json_extract(t.data, '$.title'), th.title, json_extract(l.data, '$.name'), json_extract(c.data, '$.name')) AS title,
      COALESCE(t.project_id, l.project_id, c.project_id, v.project_id) AS projectId,
      CASE WHEN t.id IS NOT NULL THEN json_extract(t.data, '$.channelId') ELSE COALESCE(c.id, v.channel_id) END AS channelId
    FROM orchestration_v2_projection_runtime_requests q
    LEFT JOIN orchestration_v2_projection_threads th ON th.thread_id = q.thread_id
    LEFT JOIN t3po_tasks t ON json_extract(t.data, '$.threadId') = q.thread_id
    LEFT JOIN t3po_leads l ON json_extract(l.data, '$.threadId') = q.thread_id
    LEFT JOIN t3po_channels c ON 't3po-channel:' || c.id = q.thread_id
    LEFT JOIN t3po_conversations v ON v.thread_id = q.thread_id
    WHERE q.status = 'pending'
      AND NOT EXISTS (SELECT 1 FROM t3po_push_sent s WHERE s.key = 'request:' || q.runtime_request_id)
    LIMIT 50`;
  return [...jobs, ...requests];
});

export class Push extends Context.Service<
  Push,
  {
    readonly state: Effect.Effect<T3poPushState, T3poError>;
    readonly change: (input: T3poPushChange) => Effect.Effect<void, T3poError>;
    /** Sends one notification per new signal to every subscribed device. */
    readonly scan: Effect.Effect<void, T3poError>;
  }
>()("t3/t3po/Push") {}

const encodePayload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const encodeTitles = Schema.encodeEffect(Schema.fromJsonString(T3poPushTitles));
const decodeTitles = Schema.decodeOption(Schema.fromJsonString(T3poPushTitles));
const titleFor = (device: Subscription, kind: keyof T3poPushTitles) =>
  Option.getOrElse(decodeTitles(device.titles), () => FALLBACK_TITLES)[kind];

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const client = yield* HttpClient.HttpClient;
  const keys = yield* Effect.cached(
    secrets.getOrCreateRandom(VAPID_SECRET, 32).pipe(Effect.map(vapidKeys)),
  );
  const subscriptions = sql<Subscription>`SELECT endpoint, p256dh, auth, label, titles, created_at AS createdAt FROM t3po_push_subscriptions ORDER BY created_at`;

  const deliver = Effect.fn("T3poPush.deliver")(function* (
    device: Subscription,
    kind: keyof T3poPushTitles,
    content: Omit<T3poPushPayload, "title">,
  ) {
    const payload = { ...content, title: titleFor(device, kind) };
    const now = DateTime.toEpochMillis(yield* DateTime.now);
    const authorization = vapidAuthorization(device.endpoint, yield* keys, Math.floor(now / 1000));
    // A throw here would end the scan for every device, so an unusable subscription is dropped instead.
    const body = yield* Effect.try({
      try: () => encryptPayload(Buffer.from(encodePayload(payload)), device.p256dh, device.auth),
      catch: (cause) => new T3poError({ operation: "invalid", cause }),
    }).pipe(Effect.option);
    if (Option.isNone(body)) {
      yield* sql`DELETE FROM t3po_push_subscriptions WHERE endpoint = ${device.endpoint}`;
      yield* Effect.logWarning("Dropped a push subscription whose keys cannot encrypt");
      return false;
    }
    const response = yield* client.execute(
      HttpClientRequest.post(device.endpoint).pipe(
        HttpClientRequest.setHeaders({
          TTL: String(24 * 60 * 60),
          Urgency: "high",
          "Content-Encoding": "aes128gcm",
          Authorization: authorization,
        }),
        HttpClientRequest.bodyUint8Array(body.value, "application/octet-stream"),
      ),
    );
    // The browser dropped this subscription; stop sending to it.
    if (response.status === 404 || response.status === 410)
      yield* sql`DELETE FROM t3po_push_subscriptions WHERE endpoint = ${device.endpoint}`;
    else if (response.status >= 400)
      yield* Effect.logWarning("Push service rejected a notification", {
        status: response.status,
        origin: new URL(device.endpoint).origin,
      });
    return response.status < 400;
  });

  const state = Effect.gen(function* () {
    const devices = yield* subscriptions;
    const mutes = yield* sql<{
      projectId: string;
      channelId: string;
    }>`SELECT project_id AS projectId, channel_id AS channelId FROM t3po_push_mutes`;
    return {
      publicKey: (yield* keys).publicKey,
      devices: devices.map(({ endpoint, label, createdAt }) => ({ endpoint, label, createdAt })),
      mutes: mutes.map((mute) => ({
        projectId: ProjectId.make(mute.projectId),
        channelId: mute.channelId || null,
      })),
    };
  }).pipe(
    Effect.mapError((cause) => new T3poError({ operation: "read", cause })),
    Effect.withSpan("T3poPush.state"),
  );

  const change = Effect.fn("T3poPush.change")(
    function* (input: T3poPushChange) {
      switch (input.type) {
        case "subscribe": {
          if (
            !URL.canParse(input.endpoint) ||
            new URL(input.endpoint).protocol !== "https:" ||
            !validSubscriptionKeys(input.p256dh, input.auth)
          )
            return yield* new T3poError({ operation: "invalid" });
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          const titles = yield* encodeTitles(input.titles);
          yield* sql`INSERT INTO t3po_push_subscriptions (endpoint, p256dh, auth, label, titles, created_at) VALUES (${input.endpoint}, ${input.p256dh}, ${input.auth}, ${input.label}, ${titles}, ${createdAt}) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, label = excluded.label, titles = excluded.titles`;
          return;
        }
        case "unsubscribe":
          yield* sql`DELETE FROM t3po_push_subscriptions WHERE endpoint = ${input.endpoint}`;
          return;
        case "test": {
          const device = (yield* subscriptions).find((row) => row.endpoint === input.endpoint);
          if (!device) return yield* new T3poError({ operation: "invalid" });
          const delivered = yield* deliver(device, "test", {
            body: device.label,
            threadId: "",
            tag: "t3po-test",
          });
          if (!delivered) return yield* new T3poError({ operation: "save" });
          return;
        }
        case "mute":
          yield* input.muted
            ? sql`INSERT OR IGNORE INTO t3po_push_mutes (project_id, channel_id) VALUES (${input.projectId}, ${input.channelId ?? ""})`
            : sql`DELETE FROM t3po_push_mutes WHERE project_id = ${input.projectId} AND channel_id = ${input.channelId ?? ""}`;
          return;
      }
    },
    Effect.mapError((cause) =>
      isT3poError(cause) ? cause : new T3poError({ operation: "save", cause }),
    ),
  );

  const scan = Effect.gen(function* () {
    const signals = yield* pendingSignals().pipe(Effect.provideService(SqlClient.SqlClient, sql));
    if (signals.length === 0) return;
    const muted = new Set(
      (yield* sql<{
        key: string;
      }>`SELECT project_id || ':' || channel_id AS key FROM t3po_push_mutes`).map((row) => row.key),
    );
    const devices = yield* subscriptions;
    const sentAt = DateTime.formatIso(yield* DateTime.now);
    for (const signal of signals) {
      // Recording first keeps delivery at most once across restarts and overlapping scans.
      const claimed =
        yield* sql`INSERT OR IGNORE INTO t3po_push_sent (key, sent_at) VALUES (${signal.key}, ${sentAt}) RETURNING key`;
      if (claimed.length === 0 || signal.projectId === null) continue;
      if (muted.has(`${signal.projectId}:${signal.channelId ?? ""}`)) continue;
      const payload = {
        body: signal.title ?? "",
        threadId: signal.threadId,
        tag: signal.key,
      };
      yield* Effect.forEach(
        devices,
        (device) =>
          deliver(device, signal.kind, payload).pipe(
            Effect.catch((cause) => Effect.logWarning("Push delivery failed", cause)),
          ),
        { concurrency: 4, discard: true },
      );
    }
  }).pipe(
    Effect.mapError((cause) => new T3poError({ operation: "save", cause })),
    Effect.withSpan("T3poPush.scan"),
  );

  return Push.of({ state, change, scan });
});

export const layer = Layer.effect(Push, make).pipe(Layer.provide(FetchHttpClient.layer));

export const run = Effect.gen(function* () {
  const push = yield* Push;
  while (true) {
    yield* push.scan.pipe(Effect.catch((cause) => Effect.logWarning("Push scan retry", cause)));
    yield* Effect.sleep("5 seconds");
  }
});
