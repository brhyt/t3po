import { T3poMemoryProcessing, T3poError, type T3poMemoryControl } from "@t3tools/contracts";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { ServerConfig } from "../config.ts";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

export type MemoryEvent = {
  id: string;
  kind: "project_brief" | "accepted_result" | "review_reopened";
  text: string;
  occurredAt: string;
};
const Response = Schema.Struct({
  acceptedIds: Schema.Array(Schema.String),
  context: Schema.String,
  available: Schema.Boolean,
});
const decodeProcessing = Schema.decodeEffect(Schema.fromJsonString(T3poMemoryProcessing));
const decodeConfiguration = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ url: Schema.String, token: Schema.String })),
);
const decodeResponse = Schema.decodeEffect(Schema.fromJsonString(Response));
const unavailable = { acceptedIds: [] as readonly string[], context: "", available: false };
export class MemoryBridge extends Context.Service<
  MemoryBridge,
  {
    readonly configured: boolean;
    readonly statuses: Effect.Effect<Readonly<Record<string, typeof T3poMemoryProcessing.Type>>>;
    readonly control: (input: T3poMemoryControl) => Effect.Effect<void, T3poError>;
    readonly exchange: (input: {
      projectId: string;
      query: string;
      events: readonly MemoryEvent[];
    }) => Effect.Effect<typeof Response.Type>;
  }
>()("t3/t3po/MemoryBridge") {}
const make = Effect.gen(function* () {
  const exchangeEnabled = yield* Config.Boolean("T3PO_MEMORY_EXCHANGE_ENABLED").pipe(
    Config.withDefault(true),
  );
  const disabledProjects = new Set(
    (yield* Config.String("T3PO_MEMORY_DISABLED_PROJECTS").pipe(Config.withDefault("")))
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
  let url = yield* Config.String("T3PO_MEMORY_URL").pipe(Config.withDefault(""));
  let token = yield* Config.Redacted("T3PO_MEMORY_TOKEN").pipe(
    Config.withDefault(Redacted.make("")),
  );
  if (!url && !Redacted.value(token)) {
    const config = yield* Effect.serviceOption(ServerConfig);
    const fs = yield* Effect.serviceOption(FileSystem.FileSystem);
    if (Option.isSome(config) && Option.isSome(fs)) {
      const file = yield* fs.value
        .readFileString(`${config.value.stateDir}/t3po-memory.json`)
        .pipe(Effect.flatMap(decodeConfiguration), Effect.option);
      if (Option.isSome(file)) {
        url = file.value.url;
        token = Redacted.make(file.value.token);
      }
    }
  }
  const statusRef = yield* Ref.make<Readonly<Record<string, typeof T3poMemoryProcessing.Type>>>({});
  const client = yield* HttpClient.HttpClient;
  const configured = url !== "" && Redacted.value(token) !== "";
  const exchange = Effect.fn("T3poMemory.exchange")(function* (input: {
    projectId: string;
    query: string;
    events: readonly MemoryEvent[];
  }) {
    if (!configured || !exchangeEnabled || disabledProjects.has(input.projectId))
      return unavailable;
    return yield* Effect.gen(function* () {
      const request = yield* HttpClientRequest.post(
        `${url.replace(/\/$/, "")}/memory/t3po/context`,
      ).pipe(HttpClientRequest.bearerToken(token), HttpClientRequest.bodyJson(input));
      const response = yield* client
        .execute(request)
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const body = yield* response.text;
      if (body.length > 50000) return unavailable;
      const result = yield* decodeResponse(body);
      const sent = new Set(input.events.map((event) => event.id));
      if (result.acceptedIds.some((id) => !sent.has(id))) return unavailable;
      return { ...result, context: result.context.slice(0, 6000) };
    }).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => unavailable),
    );
  });
  const control = Effect.fn("T3poMemory.control")(
    function* (input: T3poMemoryControl) {
      if (!configured) return yield* new T3poError({ operation: "save" });
      const request = yield* HttpClientRequest.post(
        `${url.replace(/\/$/, "")}/memory/t3po/control`,
      ).pipe(
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.bodyJson({ projectId: input.projectId, action: input.action }),
      );
      const response = yield* client
        .execute(request)
        .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
      const body = yield* response.text;
      if (body.length > 10000) return yield* new T3poError({ operation: "read" });
      const status = yield* decodeProcessing(body);
      yield* Ref.update(statusRef, (statuses) => ({ ...statuses, [input.projectId]: status }));
    },
    Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
    Effect.timeout("10 seconds"),
    Effect.mapError(() => new T3poError({ operation: "save" })),
  );
  return MemoryBridge.of({ configured, exchange, control, statuses: Ref.get(statusRef) });
});
export const layer = Layer.effect(MemoryBridge, make).pipe(Layer.provide(FetchHttpClient.layer));
