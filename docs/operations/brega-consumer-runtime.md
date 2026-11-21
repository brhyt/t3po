# Brega consumer runtime pilot

This is an opt-in policy for a dedicated Brega service. It does not change internal desktop providers when `T3_CONSUMER_CLAUDE_POLICY` is absent. Do not enable it on an operator's full-access runtime.

The first release supports bounded Anthropic text chat. It does not generate or import images. Hosted generated-image persistence is a separate Brega module; an explicitly metered image tool and retained artifact endpoint are still required.

## Dedicated service configuration

Use `brega-ai`, a private home/state directory, the existing `/var/lib/brega-ai/workspace`, and port 3874 bound to loopback. Supply these through a mode-0600 systemd EnvironmentFile; never through browser configuration or command-line credentials:

```ini
ANTHROPIC_API_KEY=<server-only paid API credential>
T3_CONSUMER_CLAUDE_POLICY={"workspaceRoot":"/var/lib/brega-ai/workspace","models":["claude-haiku-4-5-20251001"],"maxPromptChars":6000,"maxOutputTokens":2048,"maxQueryBudgetUsd":0.5}
```

Enable the dedicated Claude provider, point its `binaryPath` at the release's `bin/claude`, and use the pinned model ID above. Provider settings and the host environment must make the API credential available to the adapter. Keep any operator OAuth accounts out of this service. The SDK subprocess receives an opaque per-run gateway token instead of the provider key.

The gateway accepts only `/api/consumer/anthropic/v1/messages`, verifies a durable opaque grant, strips caching/routing options, rejects tools, sets `service_tier: standard_only`, and forwards once to the fixed Anthropic global endpoint. All previous conversation messages share a 7,168-byte serialized request limit; older complete exchanges are dropped when necessary, and the receipt indicates truncation. Current prompt bytes are capped at 6,000. Output is capped at 2,048 tokens. The API window provides the input cost bound, not an assumed bytes-to-tokens conversion.

Documented model windows used for maximum reservation:

- `claude-haiku-4-5-20251001`: 200,000 tokens.
- `claude-sonnet-4-6`: 1,000,000 tokens (only if explicitly added to the host policy).

Brega must quote and acknowledge the maximum temporary credit hold before launch, reserve once, persist the native request ID and payload, and settle actual matching provider receipts. The SDK dollar budget is a secondary stop, not a spending guarantee. No automatic provider retries are allowed. A request with unknown outcome retains its reservation for reconciliation; never mark it refunded merely because HTTP timed out.
