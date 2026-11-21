# T3PO authority boundary

Task admission belongs in the event sink transaction, not launch preflight: separate clients, services, MCP delegation, and follow-up turns can all race. Admission rejects the entire event/receipt/outbox transaction. The durable ledger is separate from projections so deleting history, task archival, and retries cannot refund usage. Migration seeds existing task history and local descendants. Run IDs are idempotency keys; a fresh run spends another unit, while provider attempts within that run do not. This is an orchestration-run allowance, not a cost or resource sandbox. Queued runs reserve concurrency; terminal runs release it. Lowering limits stops future admission without cancelling current work. There is no automatic budget reset.

Direct lead/channel manual turns and ordinary chats remain outside the allowance. Lead and channel delegated-completion wakes consume the existing run allowance and reserve concurrency. Local descendant lineage carries task authority even before the board records its task, and nested app-owned delegations are recorded on the board. Project budgets are configured through the existing authenticated T3PO mutation RPC, not an agent-facing budget-grant tool. Runtime-mode escalation is rejected for managed task workers and their descendants, including on thread creation and provider switching. Direct lead and channel conversations retain their selected mode, including delegated-completion wakes. Budget accounting does not confer worker ancestry; managed task workers and descendants still require approval-required mode at callback admission. Space membership itself imposes no runtime-mode requirement. Existing running sessions at upgrade are not retroactively stopped or sandboxed.

## Approval coverage

Approval-required preserves existing adapter policy. It cannot decide whether arbitrary code, shell commands, or MCP requests have an external side effect. Asking before external actions remains a user instruction backed by provider approval boundaries, not a claim that every action is classified.

| Provider     | Existing approval-required boundary                                                     |
| ------------ | --------------------------------------------------------------------------------------- |
| Codex        | `untrusted`, user reviewer, read-only sandbox defaults                                  |
| Claude       | Default permission mode and existing tool permission callbacks                          |
| Cursor       | Automatic review plus platform-supported sandbox; Windows has no SDK filesystem sandbox |
| OpenCode     | Permission rules ask; no OS sandbox                                                     |
| Grok         | Explicit default permission mode and ACP callbacks                                      |
| Kiro         | Autopilot off and ACP permission requests                                               |
| Antigravity  | Default mode and ACP permission callbacks                                               |
| Pi           | Injected permission hook, including without MCP credentials                             |
| Muse         | Native ask-me mode and prompt handling                                                  |
| fx           | Ask mode and ACP permission callbacks                                                   |
| ACP Registry | Agent-specific native capabilities plus client ACP policy; no uniform sandbox guarantee |

Provider allowlists, remembered grants, explicit policy overrides and provider-native tools retain their existing semantics. Automatic review (notably Cursor) is not equivalent to explicit human approval for every external action. Full-access, auto, and auto-accept-edits are rejected for new managed task execution; merely using a supported mode is not proof of human review.

## Remaining gaps

The local ledger cannot account for provider-native subagents or detached processes that do not create T3 runs, remote environments, unrelated top-level threads created through MCP, external schedulers, or direct CLI/API access. Existing MCP authorization restricts callers and destinations, but does not propagate this project allowance to those paths or classify all their side effects. Native/background work may outlive a terminal T3 run; the concurrency count is active T3 runs, not live processes. A credentialed agent with unrestricted filesystem/database access can also bypass application policy. Those paths must not be presented as covered autonomous project authority. A later slice needs authenticated authority propagation and admission at remote/top-level launch boundaries, native-provider accounting or explicit rejection, and user-owned external-action approval grants.
