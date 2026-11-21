import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { RunId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ConsumerApiGrants from "../persistence/ConsumerApiGrants.ts";
import migration from "../persistence/Migrations/110_ConsumerApiGrants.ts";
import * as Gateway from "./ConsumerAnthropicGateway.ts";

const model = "claude-haiku-4-5-20251001";
const grantInput = {
  runId: RunId.make("run-one"),
  threadId: ThreadId.make("thread-one"),
  model,
  maxRequestBytes: 7168,
  maxOutputTokens: 2048,
};
const request = (extra: object = {}) =>
  JSON.stringify({
    model,
    max_tokens: 2048,
    messages: [{ role: "user", content: "Write a short headline." }],
    ...extra,
  });
const db = Layer.effectDiscard(migration).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const grants = ConsumerApiGrants.layer.pipe(
  Layer.provideMerge(db),
  Layer.provideMerge(NodeCrypto.layer),
);
const testLayer = (fetch: typeof globalThis.fetch) =>
  Gateway.layer.pipe(
    Layer.provideMerge(db),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    Layer.provide(
      Layer.succeed(HostProcess.Environment, {
        T3_CONSUMER_CLAUDE_POLICY: "configured",
        ANTHROPIC_API_KEY: "test-server-secret",
      }),
    ),
  );
const sse = (overrides: object = {}, stop = true) =>
  [
    {
      type: "message_start",
      message: {
        model,
        usage: {
          input_tokens: 33,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          service_tier: "standard",
          ...overrides,
        },
      },
    },
    { type: "message_delta", usage: { output_tokens: 12 } },
    ...(stop ? [{ type: "message_stop" }] : []),
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");

const consume = (response: import("effect/http/HttpServerResponse").HttpServerResponse) =>
  response.body._tag === "Stream"
    ? Stream.runDrain(
        response.body.stream.pipe(
          Stream.mapError(
            () => new ConsumerApiGrants.ConsumerGrantError({ detail: "Response interrupted" }),
          ),
        ),
      )
    : Effect.void;

describe("consumer request grants", () => {
  it.effect("claims once atomically and never reissues a consumed grant", () =>
    Effect.gen(function* () {
      const store = yield* ConsumerApiGrants.ConsumerApiGrants;
      const first = yield* store.issue(grantInput);
      assert.equal((yield* store.issue(grantInput)).token, first.token);
      const results = yield* Effect.all(
        [store.claim(first.token, false), store.claim(first.token, false)],
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter(Boolean).length, 1);
      assert.equal((yield* store.read(grantInput.runId))?.status, "forwarding");
      assert.equal((yield* Effect.result(store.issue(grantInput)))._tag, "Failure");
      // A newly constructed repository using the same persisted database must see the claim too.
      const reopened = yield* ConsumerApiGrants.ConsumerApiGrants.pipe(
        Effect.provide(ConsumerApiGrants.layer),
      );
      assert.isNull(yield* reopened.claim(first.token, false));
    }).pipe(Effect.provide(grants)),
  );
  it.effect("retains the consumed grant after closing and reopening the database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const database = NodeSqliteClient.layer({ filename: `${directory}/grants.sqlite` });
      const token = yield* Effect.gen(function* () {
        yield* migration;
        const store = yield* ConsumerApiGrants.ConsumerApiGrants;
        const grant = yield* store.issue(grantInput);
        yield* store.claim(grant.token, false);
        return grant.token;
      }).pipe(
        Effect.provide(
          ConsumerApiGrants.layer.pipe(
            Layer.provideMerge(database),
            Layer.provide(NodeCrypto.layer),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const store = yield* ConsumerApiGrants.ConsumerApiGrants;
        assert.equal((yield* store.read(grantInput.runId))?.status, "forwarding");
        assert.isNull(yield* store.claim(token, false));
        assert.equal((yield* Effect.result(store.issue(grantInput)))._tag, "Failure");
      }).pipe(
        Effect.provide(
          ConsumerApiGrants.layer.pipe(Layer.provide(database), Layer.provide(NodeCrypto.layer)),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
  it.effect("atomically closes unconsumed grants before zero-usage settlement", () =>
    Effect.gen(function* () {
      const store = yield* ConsumerApiGrants.ConsumerApiGrants;
      const grant = yield* store.issue(grantInput);
      assert.equal((yield* store.rejectUnconsumed(grant.runId))?.status, "rejected");
      assert.isNull(yield* store.claim(grant.token, false));
      assert.equal((yield* store.read(grant.runId))?.consumedAt, null);
      const sent = yield* store.issue({ ...grantInput, runId: RunId.make("already-sent") });
      yield* store.claim(sent.token, false);
      assert.equal((yield* store.rejectUnconsumed(sent.runId))?.status, "forwarding");
    }).pipe(Effect.provide(grants)),
  );
  it.effect("rejects reused run identity with another thread", () =>
    Effect.gen(function* () {
      const store = yield* ConsumerApiGrants.ConsumerApiGrants;
      yield* store.issue(grantInput);
      assert.equal(
        (yield* Effect.result(store.issue({ ...grantInput, threadId: ThreadId.make("foreign") })))
          ._tag,
        "Failure",
      );
    }).pipe(Effect.provide(grants)),
  );
});

describe("bounded Anthropic gateway", () => {
  it.effect("strips cache controls and routing overrides; drops only old exchanges", () =>
    Effect.gen(function* () {
      const bounded = yield* Gateway.boundedConsumerRequest(
        request({
          system: [{ type: "text", text: "Brega assistant", cache_control: { type: "ephemeral" } }],
          service_tier: "auto",
          metadata: { private: "discard" },
          messages: [
            { role: "user", content: "old".repeat(3000) },
            { role: "assistant", content: "old answer" },
            { role: "user", content: "new question" },
          ],
        }),
        grantInput,
      );
      const parsed = JSON.parse(bounded.body);
      assert.isTrue(bounded.truncated);
      assert.equal(parsed.messages.length, 1);
      assert.equal(parsed.messages[0].content, "new question");
      assert.equal(parsed.service_tier, "standard_only");
      assert.isUndefined(parsed.system[0].cache_control);
      assert.isUndefined(parsed.metadata);
      for (const invalid of [
        request({ tools: [{ name: "shell" }] }),
        request({ model: "foreign" }),
        request({ max_tokens: 9999 }),
        request({ messages: [{ role: "user", content: "x".repeat(8000) }] }),
      ]) {
        assert.equal(
          (yield* Effect.result(Gateway.boundedConsumerRequest(invalid, grantInput)))._tag,
          "Failure",
        );
      }
    }),
  );
  it.effect("forwards exactly once and persists exact usage and standard tier", () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async (url, init) => {
      calls++;
      assert.equal(String(url), "https://api.anthropic.com/v1/messages");
      assert.equal(new Headers(init?.headers).get("x-api-key"), "test-server-secret");
      assert.equal(init?.redirect, "error");
      assert.equal(JSON.parse(String(init?.body)).service_tier, "standard_only");
      return new Response(sse(), { headers: { "content-type": "text/event-stream" } });
    };
    return Effect.gen(function* () {
      const gateway = yield* Gateway.ConsumerAnthropicGateway;
      const grant = yield* gateway.issue(grantInput);
      const response = yield* gateway.forward(grant.token, request());
      assert.equal(response.status, 200);
      yield* consume(response);
      const saved = yield* gateway.read(grant.runId);
      assert.equal(saved?.status, "completed");
      assert.equal(saved?.serviceTier, "standard");
      assert.deepInclude(JSON.parse(saved!.usageJson!), {
        inputTokens: 33,
        outputTokens: 12,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
      });
      assert.equal((yield* gateway.forward(grant.token, request())).status, 400);
      assert.equal(calls, 1);
    }).pipe(Effect.provide(testLayer(fetch)));
  });
  it.effect("keeps failed or unprovable provider results indeterminate without retry", () => {
    let calls = 0;
    const fetch: typeof globalThis.fetch = async () => {
      calls++;
      if (calls === 1) throw new Error("connection lost after provider accepted");
      return new Response(
        sse(
          calls === 2
            ? { cache_read_input_tokens: 10 }
            : calls === 3
              ? { service_tier: "priority" }
              : {},
          calls !== 4,
        ),
      );
    };
    return Effect.gen(function* () {
      const gateway = yield* Gateway.ConsumerAnthropicGateway;
      for (let i = 1; i <= 4; i++) {
        const grant = yield* gateway.issue({ ...grantInput, runId: RunId.make(`failed-${i}`) });
        yield* consume(yield* gateway.forward(grant.token, request()));
        assert.equal((yield* gateway.read(grant.runId))?.status, "indeterminate");
        assert.equal((yield* gateway.forward(grant.token, request())).status, 400);
      }
      assert.equal(calls, 4);
    }).pipe(Effect.provide(testLayer(fetch)));
  });
});
