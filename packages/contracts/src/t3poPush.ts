import * as Schema from "effect/Schema";
import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";

const PushEndpoint = TrimmedNonEmptyString.check(Schema.isMaxLength(2048));

export const T3poPushDevice = Schema.Struct({
  endpoint: Schema.String,
  label: Schema.String,
  createdAt: Schema.String,
});
export type T3poPushDevice = typeof T3poPushDevice.Type;

/** A muted space: the project's lead and jobs (`channelId: null`), or one channel and its jobs. */
export const T3poPushMute = Schema.Struct({
  projectId: ProjectId,
  channelId: Schema.NullOr(Schema.String),
});
export type T3poPushMute = typeof T3poPushMute.Type;

export const T3poPushState = Schema.Struct({
  /** VAPID application server key, base64url. */
  publicKey: Schema.String,
  devices: Schema.Array(T3poPushDevice),
  mutes: Schema.Array(T3poPushMute),
});
export type T3poPushState = typeof T3poPushState.Type;

const Title = Schema.String.check(Schema.isMaxLength(200));
/** Notification titles in the subscribing device's language. */
export const T3poPushTitles = Schema.Struct({
  completed: Title,
  failed: Title,
  approval: Title,
  question: Title,
  test: Title,
});
export type T3poPushTitles = typeof T3poPushTitles.Type;

export const T3poPushChange = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("subscribe"),
    endpoint: PushEndpoint,
    p256dh: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    auth: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
    label: Schema.String.check(Schema.isMaxLength(200)),
    titles: T3poPushTitles,
  }),
  Schema.Struct({ type: Schema.Literal("unsubscribe"), endpoint: PushEndpoint }),
  Schema.Struct({ type: Schema.Literal("test"), endpoint: PushEndpoint }),
  Schema.Struct({
    type: Schema.Literal("mute"),
    projectId: ProjectId,
    channelId: Schema.NullOr(Schema.String),
    muted: Schema.Boolean,
  }),
]);
export type T3poPushChange = typeof T3poPushChange.Type;

/** What the service worker receives; it opens `/<environmentId>/<threadId>` on click. */
export const T3poPushPayload = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  threadId: Schema.String,
  tag: Schema.String,
});
export type T3poPushPayload = typeof T3poPushPayload.Type;
