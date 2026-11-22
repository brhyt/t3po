import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { OrchestratorMcpFailure, PositiveInt, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as McpSchema from "effect/ai/McpSchema";
import * as Tool from "effect/ai/Tool";
import * as Toolkit from "effect/ai/Toolkit";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ExternalActionService from "../../../t3po/ExternalActionService.ts";

const ProposeDraft = Tool.make("propose_pull_request_draft", {
  description:
    "Ask the user to approve converting a pull request in this job's configured GitHub repository to draft. Does not perform the action. Requires a job grant and run-bound proposal credential. Reuse requestKey when retrying the same proposal; a new intentional proposal needs a new key.",
  parameters: Schema.Struct({
    number: PositiveInt,
    requestKey: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
  }),
  success: Schema.Struct({
    operationId: Schema.String,
    requestId: Schema.String,
    state: Schema.String,
  }),
  failure: OrchestratorMcpFailure,
  dependencies: [
    ThreadManagementService.ThreadManagementService,
    McpInvocationContext.McpInvocationContext,
    ExternalActionService.ExternalActionService,
  ],
})
  .annotate(Tool.Title, "Propose pull request draft")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWithoutProposal);
export const ExternalActionsToolkit = Toolkit.make(ProposeDraft);
