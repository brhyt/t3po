import { expect, it } from "vitest";

import { claudeBlockedCommandHook } from "./ClaudeAdapterV2.ts";

it("refuses a Bash command the space blocks and lets others run", async () => {
  const hook = claudeBlockedCommandHook(["git push --force"]);
  const call = (command: string) =>
    hook(
      {
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command },
      } as never,
      undefined,
      { signal: new AbortController().signal } as never,
    );
  expect(await call("git push --force origin main")).toMatchObject({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny" },
  });
  expect(await call("git status")).toEqual({});
});
