import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ExternalActionService from "../../../t3po/ExternalActionService.ts";
import { ExternalActionsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const service = yield* ExternalActionService.ExternalActionService;
  return {
    propose_pull_request_draft: McpToolAccess.actsAsCaller(
      Effect.fn("ExternalActions.proposeDraft")(function* (input: {
        number: number;
        requestKey: string;
      }) {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        if (!scope.capabilities.has("pull-requests") || !scope.thread?.proposalExecution)
          return yield* new OrchestratorMcpFailure({
            code: "capability_denied",
            message:
              "This operation requires a run-bound proposal credential and configured job authority.",
          });
        return yield* service
          .proposeDraft({ ...input, caller: scope.thread })
          .pipe(
            Effect.mapError(
              (cause) =>
                new OrchestratorMcpFailure({ code: "invalid_request", message: cause.message }),
            ),
          );
      }),
    ),
  } satisfies McpToolAccess.Handlers<typeof ExternalActionsToolkit.tools>;
});
export const layer = McpToolAccess.toLayer(ExternalActionsToolkit, make);
