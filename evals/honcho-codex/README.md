# Honcho → Codex compatibility proof

This is an experimental extraction adapter in T3PO, using its existing `effect-codex-app-server` client and the user's locally authenticated Codex runtime. It does not read, copy, or proxy OAuth tokens. API-key-only accounts are rejected. No paid API fallback is configured.

Source of the case: the request to preserve decisions, blockers, and next actions through self-hosted Honcho using T3PO's subscription-backed runtime. The synthetic case contains these three facts plus an unrelated peer's database choice. The proof uses Honcho's actual prompt function and Pydantic classes, extracted from the pinned source AST to avoid booting its database or importing unrelated infrastructure. It does not duplicate their prompt text. Codex's strict-output schema requires all object properties, while the original Honcho validator checks the response unchanged.

## Run

From the repository root, clone Honcho v3.6.1 into `.t3/honcho-source` if absent. The case verifies commit `70c67624169683b9e265517aec95a51b8077cabc` before loading source. Then:

```sh
TMPDIR="$PWD/.t3/tmp" uv run --with pydantic python evals/honcho-codex/run.py --out .t3/honcho-proof
```

Optional `--model` selects an exact model from the account catalog; unavailable selections fail. Without it, the account's default is used. `--source` selects another checkout of that exact Honcho commit. `--samples` defaults to three.

Each sample uses an ephemeral, read-only Codex thread in a temporary empty directory. Plugins, apps, hooks, shell, web search and multi-agent features are disabled. Configured MCP servers are enumerated and disabled; enumeration failure stops the proof. The process and temporary directory are scoped to the run. This is a model-protocol test, not a delegated coding task or a new T3 conversation.

The runner writes request, response, validator output, per-sample logs and `summary.json`. A passing case requires the original Honcho validator to accept the result, correct message-source indices, the three intended facts, and no unrelated MongoDB observation. These checks establish compatibility for this fixture, not overall memory quality. Four unit tests separately cover unsupported inputs and terminal success/failure handling.

## Cost and limits

Each sample consumes the signed-in account's Codex allowance. Token usage is not collected by this proof; do not interpret it as zero-cost or unlimited inference. Quota failures fail the run. No retry loop, credential rotation, API fallback, or limit bypass is used.

## What this does not enable

The adapter is not wired into the everyday board or Honcho's running backend. Streaming and tool-calling Honcho requests are rejected. Embeddings, summaries, dreaming, background queue fairness, durable inference receipts and UI configuration remain integration work. This proof validates extraction output with Honcho's real schema; it does not persist that output to Honcho's database. The previously staged Docker deployment remains inactive until its host storage issue is resolved.
