import {
  createSdkMcpServer,
  tool,
  type Options,
  type SDKMessage,
  type SDKResultSuccess,
} from "@anthropic-ai/claude-agent-sdk";
import type { ConsumerImageSource } from "@t3tools/contracts";
import { z } from "zod";
import {
  CONSUMER_IMAGE_TOOL,
  consumerImageToolDefinition,
} from "../../provider/ConsumerImageGeneration.ts";

export function consumerImageQueryOverrides(
  generate: (prompt: string) => Promise<ConsumerImageSource>,
) {
  return {
    allowedTools: [CONSUMER_IMAGE_TOOL],
    disallowedTools: [],
    mcpServers: {
      brega: createSdkMcpServer({
        name: "brega",
        version: "1.0.0",
        tools: [
          tool(
            "generate_image",
            consumerImageToolDefinition.description,
            { prompt: z.string().min(1).max(6000) },
            async ({ prompt }) => ({
              content: [{ type: "text", text: JSON.stringify(await generate(prompt)) }],
            }),
          ),
        ],
      }),
    },
    canUseTool: async (name, input) =>
      name === CONSUMER_IMAGE_TOOL
        ? { behavior: "allow", updatedInput: input }
        : { behavior: "deny", message: "Only image generation is available." },
    systemPrompt:
      "You are Brega's workspace assistant. Help with writing and planning. When the user requests a new image, call brega.generate_image once with a self-contained prompt. This is your only tool. Do not claim to read files, edit existing images or publish content. Generated images are retained by this runtime; saving to Brega is separate and can fail or be retried. Do not claim an image was saved unless Brega confirms it. After generation do not request another tool or model turn.",
  } satisfies Partial<Options>;
}

export function consumerImageTerminalMessage(
  message: SDKMessage,
  artifact: ConsumerImageSource | undefined,
): SDKMessage {
  // maxTurns stops the SDK after executing the tool; completing the retained artifact needs no second model call.
  if (artifact && message.type === "result" && message.subtype === "error_max_turns") {
    const result: SDKResultSuccess = {
      ...message,
      subtype: "success",
      is_error: false,
      result: "Generated an image.",
      stop_reason: "end_turn",
      terminal_reason: "completed",
    };
    return result;
  }
  return message;
}
