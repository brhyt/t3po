import { expect, it } from "@effect/vitest";
import {
  AuthSessionId,
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  EventId,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Access from "./MemoryAccess.ts";
import * as Inspector from "./MemoryInspector.ts";

it.effect(
  "derives correction identity from the session and denies missing projects and insufficient scopes",
  () =>
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      const projectId = ProjectId.make("project-a");
      yield* projects.apply({
        sequence: 1,
        eventId: EventId.make("created"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: "2026-11-18T00:00:00Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "A",
          workspaceRoot: "/fixture",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-11-18T00:00:00Z",
          updatedAt: "2026-11-18T00:00:00Z",
        },
      });
      const reader = yield* Inspector.MemoryAccess.pipe(
        Effect.provide(
          Access.layer({
            sessionId: AuthSessionId.make("reader"),
            scopes: [AuthOrchestrationReadScope],
          }),
        ),
      );
      expect(yield* reader.authorize(projectId, false)).toBe("reader");
      expect(yield* reader.authorize(projectId, true).pipe(Effect.flip)).toMatchObject({
        reason: "forbidden",
      });
      expect(
        yield* reader.authorize(ProjectId.make("missing"), false).pipe(Effect.flip),
      ).toMatchObject({ reason: "forbidden" });
      const operator = yield* Inspector.MemoryAccess.pipe(
        Effect.provide(
          Access.layer({
            sessionId: AuthSessionId.make("trusted-session"),
            scopes: [AuthOrchestrationReadScope, AuthOrchestrationOperateScope],
          }),
        ),
      );
      expect(yield* operator.authorize(projectId, true)).toBe("trusted-session");
      const denied = yield* Inspector.MemoryAccess.pipe(
        Effect.provide(Access.layer({ sessionId: AuthSessionId.make("denied"), scopes: [] })),
      );
      expect(yield* denied.authorize(projectId, false).pipe(Effect.flip)).toMatchObject({
        reason: "forbidden",
      });
    }).pipe(Effect.provide(ProjectStore.layer.pipe(Layer.provide(Sqlite.layerMemory)))),
);
