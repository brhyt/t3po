import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as ServerConfig from "../config.ts";
import { ProjectId, T3poError } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as MemoryBridge from "./MemoryBridge.ts";

it.effect.each([
  { acceptedIds: ["unknown-event"], context: "Wrong acknowledgement", available: true },
  { acceptedIds: [], context: 42, available: true },
])("retains the local queue for an invalid gateway response: %j", (response) =>
  Effect.gen(function* () {
    const bridge = yield* MemoryBridge.MemoryBridge;
    expect(yield* bridge.exchange({ projectId: "project", query: "", events: [] })).toEqual({
      acceptedIds: [],
      context: "",
      available: false,
    });
  }).pipe(
    Effect.provide(
      MemoryBridge.layer.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              T3RO_MEMORY_URL: "http://memory.test",
              T3RO_MEMORY_TOKEN: "test-token",
            }),
          ),
        ),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, async () => Response.json(response)),
  ),
);
it.effect("keeps memory local when no service is configured", () =>
  Effect.gen(function* () {
    const bridge = yield* MemoryBridge.MemoryBridge;
    expect(bridge.configured).toBe(false);
    expect(yield* bridge.exchange({ projectId: "project", query: "", events: [] })).toEqual({
      acceptedIds: [],
      context: "",
      available: false,
    });
  }).pipe(
    Effect.provide(
      MemoryBridge.layer.pipe(Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    ),
  ),
);

it.effect("refreshes processing state and retains it when the service is unavailable", () =>
  Effect.gen(function* () {
    const bridge = yield* MemoryBridge.MemoryBridge;
    const projectId = ProjectId.make("project");
    yield* bridge.control({ type: "memory_control", projectId, action: "pause" });
    expect((yield* bridge.statuses)[projectId]?.paused).toBe(true);
    expect(
      yield* bridge
        .control({ type: "memory_control", projectId, action: "retry" })
        .pipe(Effect.flip),
    ).toBeInstanceOf(T3poError);
    expect((yield* bridge.statuses)[projectId]?.paused).toBe(true);
  }).pipe(
    Effect.provide(
      MemoryBridge.layer.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              T3RO_MEMORY_URL: "http://memory.test",
              T3RO_MEMORY_TOKEN: "test-token",
            }),
          ),
        ),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, async (_url, init) => {
      const input = JSON.parse(String(init?.body));
      return input.action === "pause"
        ? Response.json({ ready: true, paused: true, reason: "manual", counts: { queued: 2 } })
        : new Response("offline", { status: 503 });
    }),
  ),
);

it.effect("loads a private userdata configuration when environment credentials are absent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const folder = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${folder}/userdata`);
    yield* fs.writeFileString(
      `${folder}/userdata/t3po-memory.json`,
      '{"url":"http://memory.test","token":"fixture-token"}',
    );
    const configured = yield* MemoryBridge.MemoryBridge.pipe(
      Effect.map((bridge) => bridge.configured),
      Effect.provide(
        MemoryBridge.layer.pipe(Layer.provide(ServerConfig.layerTest(folder, folder))),
      ),
    );
    expect(configured).toBe(true);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    ),
  ),
);

it.effect.each([
  { T3RO_MEMORY_EXCHANGE_ENABLED: "false" },
  { T3RO_MEMORY_DISABLED_PROJECTS: "other,project" },
])("stops both delivery and recall without discarding queued events: %j", (settings) => {
  const fetch = vi.fn(async () => Response.json({ acceptedIds: [], context: "", available: true }));
  return Effect.gen(function* () {
    const bridge = yield* MemoryBridge.MemoryBridge;
    expect(
      yield* bridge.exchange({
        projectId: "project",
        query: "private query",
        events: [
          { id: "pending", kind: "project_brief", text: "private brief", occurredAt: "now" },
        ],
      }),
    ).toEqual({ acceptedIds: [], context: "", available: false });
    expect(fetch).not.toHaveBeenCalled();
  }).pipe(
    Effect.provide(
      MemoryBridge.layer.pipe(
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              T3RO_MEMORY_URL: "http://memory.test",
              T3RO_MEMORY_TOKEN: "fixture",
              ...settings,
            }),
          ),
        ),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
});
