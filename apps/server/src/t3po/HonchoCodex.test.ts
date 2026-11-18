import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CodexClient from "effect-codex-app-server/client";
import * as HonchoCodex from "./HonchoCodex.ts";

const request = {
  model: "test-model",
  messages: [{ role: "user" as const, content: "Extract the decision." }],
  response_format: {
    type: "json_schema" as const,
    json_schema: { name: "result", schema: { type: "object" } },
  },
};
it("rejects tool calls and streaming requests at the extraction boundary", () => {
  const valid = Schema.is(HonchoCodex.ExtractionRequest);
  expect(valid(request)).toBe(true);
  expect(valid({ ...request, tools: [{ type: "function" }] })).toBe(false);
  expect(valid({ ...request, stream: true })).toBe(false);
  expect(valid({ ...request, messages: [{ role: "tool", content: "output" }] })).toBe(false);
});
it.effect.each(["completed", "failed", "interrupted"] as const)(
  "accepts output only after terminal success: %s",
  (status) => {
    const handlers = new Map<string, (payload: unknown) => Effect.Effect<void>>();
    // The fixture implements only the protocol operations this isolated worker uses.
    const client = {
      awaitTermination: Effect.never,
      handleServerNotification: (
        method: string,
        handler: (payload: unknown) => Effect.Effect<void>,
      ) =>
        Effect.sync(() => {
          handlers.set(method, handler);
        }),
      request: (method: string) =>
        Effect.gen(function* () {
          if (method === "thread/start") return { thread: { id: "proof" } };
          if (method !== "turn/start") return yield* Effect.die("Unexpected RPC method");
          yield* handlers.get("item/completed")!({
            threadId: "another-project",
            item: { type: "agentMessage", text: "wrong project" },
          });
          yield* handlers.get("item/completed")!({
            threadId: "proof",
            item: { type: "agentMessage", text: '{"explicit":[]}' },
          });
          yield* handlers.get("turn/completed")!({ threadId: "proof", turn: { status } });
          return {};
        }),
    } as unknown as CodexClient.CodexAppServerClient["Service"];
    return Effect.gen(function* () {
      const bridge = yield* HonchoCodex.HonchoCodex;
      const result = yield* bridge.extract(request, "/tmp/isolated").pipe(Effect.result);
      expect(result._tag).toBe(status === "completed" ? "Success" : "Failure");
      if (result._tag === "Success") expect(result.success).toBe('{"explicit":[]}');
    }).pipe(
      Effect.provide(HonchoCodex.layer),
      Effect.provideService(CodexClient.CodexAppServerClient, client),
    );
  },
);
