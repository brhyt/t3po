import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as CodexClient from "effect-codex-app-server/client";
import * as HonchoCodex from "../src/t3po/HonchoCodex.ts";

const decodeServers = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Array(Schema.Struct({ name: Schema.String }))),
);
const encodeUsage = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const encodeName = Schema.encodeEffect(Schema.fromJsonString(Schema.String));
const decodeRequest = Schema.decodeEffect(Schema.fromJsonString(HonchoCodex.ExtractionRequest));

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const spawn = yield* ChildProcessSpawner.ChildProcessSpawner;
  const inputPath = process.argv[2];
  const outputPath = process.argv[3];
  if (!inputPath || !outputPath)
    return yield* new HonchoCodex.InferenceError({
      detail: "Usage: honcho-codex-worker.ts request.json response.json",
    });
  const input = yield* fs.readFileString(inputPath).pipe(Effect.flatMap(decodeRequest));
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "honcho-codex-" });
  const args = [
    "-c",
    "features.plugins=false",
    "-c",
    "features.apps=false",
    "-c",
    "features.hooks=false",
  ];
  const listing = yield* spawn.spawn(
    ChildProcess.make("codex", [...args, "mcp", "list", "--json"], { cwd }),
  );
  const [list, code] = yield* Effect.all(
    [
      listing.stdout.pipe(Stream.decodeText(), Stream.mkString),
      listing.exitCode,
      listing.stderr.pipe(Stream.runDrain),
    ],
    { concurrency: "unbounded" },
  );
  if (code !== 0)
    return yield* new HonchoCodex.InferenceError({
      detail: "Cannot enumerate MCP servers; refusing to start extraction.",
    });
  const servers = yield* decodeServers(list);
  const names = yield* Effect.forEach(servers, ({ name }) => encodeName(name));
  args.push("-c", `mcp_servers={${names.map((name) => `${name}={enabled=false}`).join(",")}}`);
  for (const feature of [
    "shell_tool",
    "unified_exec",
    "multi_agent",
    "multi_agent_v2",
    "browser_use",
  ])
    args.push("-c", `features.${feature}=false`);
  args.push("-c", 'web_search="disabled"', "-c", "project_doc_max_bytes=0", "app-server");
  const child = yield* spawn.spawn(
    ChildProcess.make("codex", args, { cwd, forceKillAfter: "1 second" }),
  );
  yield* Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    yield* client.request("initialize", {
      clientInfo: { name: "t3po-honcho", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    yield* client.notify("initialized", undefined);
    const account = yield* client.request("account/read", {});
    if (account.account?.type !== "chatgpt")
      return yield* new HonchoCodex.InferenceError({
        detail:
          "Memory inference requires the existing ChatGPT login; API-key fallback is disabled.",
      });
    const catalog = yield* client.request("model/list", {});
    const selected = yield* Config.String("T3RO_MEMORY_MODEL").pipe(Config.withDefault(""));
    const model = selected || catalog.data.find((entry) => entry.isDefault)?.model;
    if (!model || !catalog.data.some((entry) => entry.model === model))
      return yield* new HonchoCodex.InferenceError({
        detail: "Requested model is not in this account's catalog.",
      });
    yield* Console.log(`Using authenticated Codex model: ${model}`);
    let usage:
      | { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      | undefined;
    yield* client.handleServerNotification("thread/tokenUsage/updated", (event) => {
      const total = event.tokenUsage.total;
      usage = {
        prompt_tokens: total.inputTokens,
        completion_tokens: total.outputTokens,
        total_tokens: total.totalTokens,
      };
      return Effect.void;
    });
    const bridge = yield* HonchoCodex.HonchoCodex;
    const result = yield* bridge.extract({ ...input, model }, cwd);
    yield* fs.writeFileString(outputPath, result);
    if (usage) yield* fs.writeFileString(`${outputPath}.usage.json`, yield* encodeUsage(usage));
    yield* Console.log("Completed extraction; structured response written for Honcho validation.");
  }).pipe(
    Effect.provide(
      HonchoCodex.layer.pipe(Layer.provideMerge(CodexClient.layerChildProcess(child))),
    ),
  );
});
program.pipe(Effect.scoped, Effect.provide(NodeServices.layer), NodeRuntime.runMain);
