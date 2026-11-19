import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  T3poMemoryError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type { AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as Inspector from "./MemoryInspector.ts";

// These sessions grant environment-wide access. Project existence is checked on this
// environment; no account or actor supplied in an RPC payload grants access.
export const layer = (session: Pick<AuthenticatedSession, "sessionId" | "scopes">) =>
  Layer.effect(
    Inspector.MemoryAccess,
    Effect.gen(function* () {
      const projects = yield* ProjectStore.ProjectStoreV2;
      return Inspector.MemoryAccess.of({
        authorize: Effect.fn("MemoryAccess.authorize")(function* (projectId, write) {
          const required = write ? AuthOrchestrationOperateScope : AuthOrchestrationReadScope;
          if (!session.scopes.includes(required))
            return yield* new T3poMemoryError({ reason: "forbidden" });
          const project = yield* projects
            .get(projectId)
            .pipe(Effect.mapError(() => new T3poMemoryError({ reason: "storage" })));
          if (Option.isNone(project)) return yield* new T3poMemoryError({ reason: "forbidden" });
          return session.sessionId;
        }),
      });
    }),
  );
