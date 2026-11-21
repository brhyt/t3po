import { assert, describe, it } from "@effect/vitest";
import * as NodeZlib from "node:zlib";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  type ConsumerImageAuthorization,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Images from "../persistence/ConsumerImages.ts";
import textMigration from "../persistence/Migrations/110_ConsumerApiGrants.ts";
import imageMigration from "../persistence/Migrations/111_ConsumerImages.ts";
import * as Generation from "./ConsumerImageGeneration.ts";
import { boundedConsumerRequest } from "./ConsumerAnthropicGateway.ts";
import { consumerImageToolDefinition } from "./ConsumerImageGeneration.ts";

const authorization: ConsumerImageAuthorization = {
  grant: {
    protocolVersion: 1,
    policy: "brega-text-image-v1",
    reservationId: "reservation-1",
    imageRequestId: "reservation-1:image",
    profile: "openai-image-square-v1",
  },
  requestNamespace: "client:worker",
  messageId: MessageId.make("message-1"),
  threadId: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  model: "claude-haiku-4-5-20251001",
  message: "Create a breakfast photo.",
};
const runId = RunId.make("run-1");
const usage = {
  input_tokens: 50,
  output_tokens: 1200,
  total_tokens: 1250,
  input_tokens_details: { text_tokens: 50, image_tokens: 0 },
  output_tokens_details: { text_tokens: 0, image_tokens: 1200 },
};
function png() {
  const chunk = (name: string, bytes: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(bytes.byteLength);
    const data = Buffer.concat([Buffer.from(name), bytes]);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(NodeZlib.crc32(data));
    return Buffer.concat([length, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1024, 0);
  header.writeUInt32BE(1024, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", header),
    chunk("IDAT", NodeZlib.deflateSync(Buffer.alloc(1024 * (4096 + 1)))),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
const db = Layer.effectDiscard(textMigration.pipe(Effect.andThen(imageMigration))).pipe(
  Layer.provideMerge(NodeSqliteClient.layer({ filename: ":memory:" })),
);
const store = Images.layer.pipe(Layer.provideMerge(db));
const environment = {
  T3_CONSUMER_CLAUDE_POLICY: "configured",
  T3_CONSUMER_IMAGE_POLICY: '{"profile":"openai-image-square-v1"}',
  OPENAI_API_KEY: "fake-provider-key",
};
const layer = (fetch: typeof globalThis.fetch, imageConfigured = true, storeLayer = store) =>
  Generation.layer.pipe(
    Layer.provideMerge(storeLayer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
    Layer.provide(Layer.succeed(HostProcess.Environment, imageConfigured ? environment : {})),
    Layer.provide(
      Layer.succeed(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("runtime-1")),
        getDescriptor: Effect.die("unused descriptor"),
      }),
    ),
  );
const prepare = Effect.gen(function* () {
  const images = yield* Images.ConsumerImages;
  yield* images.authorize(authorization);
  yield* images.bind(authorization.messageId, runId, authorization.threadId, authorization.model);
  return images;
});
const response = (overrideUsage: unknown = usage) =>
  new Response(
    JSON.stringify({
      created: 1,
      data: [{ b64_json: png().toString("base64") }],
      usage: overrideUsage,
    }),
    { headers: { "x-request-id": "req_fake_image" } },
  );

describe("consumer image grants and artifacts", () => {
  it.effect("binds immutable reservation arguments and seals unused grants before refund", () =>
    Effect.gen(function* () {
      const images = yield* Images.ConsumerImages;
      yield* images.authorize(authorization);
      yield* images.authorize(authorization);
      for (const changed of [
        { ...authorization, message: "changed" },
        { ...authorization, requestNamespace: "client:other" },
        { ...authorization, grant: { ...authorization.grant, reservationId: "other" } },
      ])
        assert.equal((yield* Effect.result(images.authorize(changed)))._tag, "Failure");
      assert.equal(
        (yield* Effect.result(images.requireNoGrant(authorization.messageId)))._tag,
        "Failure",
      );
      assert.equal(
        (yield* Effect.result(
          images.bind(authorization.messageId, runId, "other-thread", authorization.model),
        ))._tag,
        "Failure",
      );
      const closed = yield* images.execution(runId, true, authorization.messageId);
      assert.equal(closed?.status, "rejected");
      assert.equal(closed?.upstreamRequests, 0);
      assert.equal(
        (yield* Effect.result(
          images.bind(authorization.messageId, runId, authorization.threadId, authorization.model),
        ))._tag,
        "Failure",
      );
      assert.equal((yield* Effect.result(images.claim(runId, "A photo")))._tag, "Failure");
    }).pipe(Effect.provide(store)),
  );

  it.effect(
    "forwards one pinned image request, retains bytes, and denies cross-scope retrieval",
    () => {
      let calls = 0;
      const fetch: typeof globalThis.fetch = async (input, init) => {
        calls++;
        const request = new Request(input, init);
        assert.equal(request.url, "https://api.openai.com/v1/images/generations");
        assert.equal(request.headers.get("authorization"), "Bearer fake-provider-key");
        assert.deepEqual(await request.json(), {
          model: Generation.CONSUMER_IMAGE_MODEL,
          prompt: "A breakfast platter",
          n: 1,
          size: "1024x1024",
          quality: "medium",
          output_format: "png",
          background: "opaque",
          moderation: "auto",
          stream: false,
          partial_images: 0,
        });
        return response();
      };
      return Effect.gen(function* () {
        const images = yield* prepare;
        const generator = yield* Generation.ConsumerImageGeneration;
        const results = yield* Effect.forEach(
          [0, 1],
          () => generator.generate(runId, "A breakfast platter").pipe(Effect.result),
          { concurrency: "unbounded" },
        );
        assert.equal(calls, 1);
        assert.equal(results.filter((entry) => entry._tag === "Success").length, 1);
        const execution = yield* images.execution(runId, true);
        assert.equal(execution?.status, "completed");
        assert.deepEqual(execution?.usage, usage);
        assert.isDefined(execution?.artifact);
        const source = execution!.artifact!;
        const input = {
          projectId: authorization.projectId,
          threadId: authorization.threadId,
          runId,
          artifactId: source.artifactId,
          offset: 0,
          limit: 100,
        };
        const chunks: Buffer[] = [];
        let offset = 0;
        while (offset < source.byteLength) {
          const chunk = yield* images.readArtifact(authorization.requestNamespace, {
            ...input,
            offset,
          });
          assert.deepEqual(chunk.source, source);
          chunks.push(Buffer.from(chunk.data, "base64"));
          offset = chunk.nextOffset;
        }
        assert.deepEqual(Buffer.concat(chunks), png());
        assert.equal(
          (yield* Effect.result(images.readArtifact("client:other", input)))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.result(
            images.readArtifact(authorization.requestNamespace, {
              ...input,
              projectId: ProjectId.make("foreign"),
            }),
          ))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.result(
            images.readArtifact(authorization.requestNamespace, { ...input, limit: 262145 }),
          ))._tag,
          "Failure",
        );
        const reopened = yield* Images.ConsumerImages.pipe(Effect.provide(Images.layer));
        assert.equal((yield* reopened.execution(runId))?.artifact?.sha256, source.sha256);
        assert.equal((yield* Effect.result(reopened.claim(runId, "Regenerate")))._tag, "Failure");
      }).pipe(Effect.provide(layer(fetch)));
    },
  );

  it.effect.each([
    ["unknown billing modalities", { ...usage, audio_tokens: 1 }],
    [
      "unknown nested billing modalities",
      { ...usage, output_tokens_details: { ...usage.output_tokens_details, audio_tokens: 1 } },
    ],
    ["absent usage", undefined],
    ["incomplete output usage", { ...usage, output_tokens_details: undefined }],
    [
      "mismatched output usage",
      { ...usage, output_tokens_details: { image_tokens: 1, text_tokens: 0 } },
    ],
  ] as const)("retains the artifact with reconciliation pending for %s", ([name, providerUsage]) =>
    Effect.gen(function* () {
      const images = yield* prepare;
      const generator = yield* Generation.ConsumerImageGeneration;
      const artifact = yield* generator.generate(runId, "A breakfast photo");
      const result = yield* images.execution(runId, true);
      assert.equal(result?.status, "indeterminate");
      if (name.includes("unknown") || name === "absent usage") assert.isNull(result?.usage);
      assert.equal(result?.artifact?.artifactId, artifact.artifactId);
      const read = yield* images.readArtifact(authorization.requestNamespace, {
        projectId: authorization.projectId,
        threadId: authorization.threadId,
        runId,
        artifactId: artifact.artifactId,
        offset: 0,
      });
      assert.equal(read.eof, true);
      assert.equal((yield* Effect.result(generator.generate(runId, "Retry")))._tag, "Failure");
    }).pipe(
      Effect.provide(
        layer(async () => {
          const value = response(providerUsage);
          return providerUsage === undefined
            ? new Response(JSON.stringify({ data: [{ b64_json: png().toString("base64") }] }), {
                headers: { "x-request-id": "req_fake_image" },
              })
            : value;
        }),
      ),
    ),
  );

  it.effect("retains completed bytes and grant consumption across database close and reopen", () =>
    Effect.gen(function* () {
      const directory = yield* (yield* FileSystem.FileSystem).makeTempDirectoryScoped({
        prefix: "t3-consumer-images-",
      });
      const filename = `${directory}/state.sqlite`;
      const database = NodeSqliteClient.layer({ filename });
      const initial = Images.layer.pipe(
        Layer.provideMerge(
          Layer.effectDiscard(textMigration.pipe(Effect.andThen(imageMigration))).pipe(
            Layer.provideMerge(database),
          ),
        ),
      );
      const source = yield* Effect.gen(function* () {
        yield* prepare;
        return yield* (yield* Generation.ConsumerImageGeneration).generate(
          runId,
          "A breakfast photo",
        );
      }).pipe(Effect.provide(layer(async () => response(), true, initial)));
      yield* Effect.gen(function* () {
        const reopened = yield* Images.ConsumerImages;
        assert.equal((yield* reopened.execution(runId))?.artifact?.sha256, source.sha256);
        const chunk = yield* reopened.readArtifact(authorization.requestNamespace, {
          projectId: authorization.projectId,
          threadId: authorization.threadId,
          runId,
          artifactId: source.artifactId,
          offset: 0,
        });
        assert.deepEqual(Buffer.from(chunk.data, "base64"), png());
        assert.equal((yield* Effect.result(reopened.claim(runId, "Regenerate")))._tag, "Failure");
      }).pipe(Effect.provide(Images.layer.pipe(Layer.provide(database))));
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("holds an uncertain provider outcome and refuses retry after reconstruction", () => {
    let calls = 0;
    return Effect.gen(function* () {
      const images = yield* prepare;
      const generator = yield* Generation.ConsumerImageGeneration;
      assert.equal((yield* Effect.result(generator.generate(runId, "A photo")))._tag, "Failure");
      assert.equal((yield* images.execution(runId, true))?.status, "indeterminate");
      assert.equal((yield* images.execution(runId))?.upstreamRequests, 1);
      assert.equal((yield* Effect.result(generator.generate(runId, "Retry")))._tag, "Failure");
      assert.equal(calls, 1);
    }).pipe(
      Effect.provide(
        layer(async () => {
          calls++;
          throw new TypeError("fake provider interrupted");
        }),
      ),
    );
  });

  it.effect("leaves image generation unavailable without host opt-in", () =>
    Effect.gen(function* () {
      const generator = yield* Generation.ConsumerImageGeneration;
      assert.equal(generator.configured, false);
      assert.equal((yield* Effect.result(generator.generate(runId, "An image")))._tag, "Failure");
    }).pipe(
      Effect.provide(
        layer(async () => {
          throw new Error("must not reach provider");
        }, false),
      ),
    ),
  );

  it.effect(
    "exposes only the image tool on authorized text grants and removes old tool payloads",
    () =>
      Effect.gen(function* () {
        const grant = {
          model: authorization.model,
          maxRequestBytes: 7168,
          maxOutputTokens: 2048,
          imageRequestId: authorization.grant.imageRequestId,
        };
        const request = {
          model: grant.model,
          max_tokens: 2048,
          tools: [{ name: consumerImageToolDefinition.name, input_schema: { dangerous: true } }],
          messages: [
            {
              role: "assistant",
              content: [{ type: "tool_use", name: "Bash", input: { command: "unsafe" } }],
            },
            { role: "user", content: "Create an image" },
          ],
        };
        const result = JSON.parse(
          (yield* boundedConsumerRequest(JSON.stringify(request), grant)).body,
        );
        assert.deepEqual(result.tools, [consumerImageToolDefinition]);
        assert.equal(JSON.stringify(result).includes("unsafe"), false);
        assert.equal(result.tool_choice.disable_parallel_tool_use, true);
        assert.equal(
          (yield* Effect.result(
            boundedConsumerRequest(JSON.stringify(request), { ...grant, imageRequestId: null }),
          ))._tag,
          "Failure",
        );
        assert.equal(
          (yield* Effect.result(
            boundedConsumerRequest(
              JSON.stringify({ ...request, tools: [{ name: "Bash" }] }),
              grant,
            ),
          ))._tag,
          "Failure",
        );
      }),
  );
});
