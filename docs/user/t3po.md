# T3PO project work

Open the home screen to see work across projects. Add a workspace with **Add project**, select it in the sidebar, and choose **Set up lead**. Save a name and the project goals your lead should keep in mind. **Talk to lead** opens its continuing conversation.

Existing chats appear under **Conversations** beneath their project in the sidebar. Choose a conversation to continue its saved history, or **Show more** for older chats. Task conversations remain accessible through **Open work**, and the lead through **Talk to lead**.

The lead's identity and brief are saved on the server. Each turn receives the current project brief and recent task references, including after restarting or changing models. Saved brief changes, reviewed results, and reopened reviews also enter a durable local continuity journal. When `T3PO_MEMORY_URL` and `T3PO_MEMORY_TOKEN` are configured, the server automatically delivers pending records to apps/memory, and lead turns retrieve project-scoped Honcho context. Without a connection, the lead continues with its local records.

Channels appear beneath their project in the sidebar. Use **New channel** there to group work by topic, then select a channel to see its tasks. Select the project to see work across all its channels. Use **New task** to save a brief and expected outcome in **Up next**, then **Start task** when ready. **Edit** changes its title, brief, and channel without replacing its history. Brief changes reach the worker on its next turn. The model selector applies to new executions; existing conversations retain their own model settings. New work starts with approvals required, subject to the provider's supported permissions.

Local tasks delegated by a project lead through T3's delegation tools also appear on the task board. They keep T3's existing completion callbacks. Provider-native subagents and cross-machine delegations are not yet represented as separate board tasks.

**Active** shows work in progress, tasks needing your input, and results ready for review. **Open work** opens the conversation, where you can respond to questions, inspect changes, stop execution, or request a revision. **Outputs** keeps the final response from the latest completed run visible while you ask for revisions or new work runs. Each result shows its run number and completion date, and file links open in that task’s workspace. Use **Result history** to browse earlier completed responses, ten at a time. Long responses show an excerpt; **Open work** retains the full response and execution history. Results come from saved execution history and survive restarts and task archiving; deleting or rolling back that execution history can remove them. Linked files remain live workspace files, not immutable artifact copies.

Mark a result complete after reviewing it. Reopen it to return it to review. A later execution needs a new review even if you approved an earlier result.

Use the rename and archive controls beside each sidebar channel. Archived channels can be restored from **Archived channels**. Archiving a channel leaves its tasks visible in the project-wide board and lets you move them elsewhere. It prevents adding new work to that channel.

Archive tasks you want to put aside, then restore them from the board’s **Archived** tab. Stop running work before archiving it. History and files are preserved; archiving does not delete worktrees. Resuming an archived task’s conversation brings it back to the live board.

New tasks default to an isolated Git worktree. The default base follows the repository’s default branch, fetched from its remote when available. Choose a specific base and turn off **Fetch remote base** for a local commit or branch. Worktrees include committed files only. Choose **Project folder** for non-Git folders or work that needs the existing checkout. The workspace choice locks when launch begins; task cards show the actual path and branch after preparation. Existing tasks keep their previous workspace.

Boards update when work changes. Use **Previous** and **Next** to browse pages of up to 50 tasks, including completed and archived work.

Projects currently use one existing T3 workspace each, with optional worktrees for tasks. Cross-project coordination, scheduling, messaging channels and automatic conversation-wide memory extraction are subsequent work. The new interface is available on web and its desktop wrapper; the native mobile application still uses the upstream interface.

## Lead continuity

The lead card shows local continuity, a connected memory service, or an awaiting-connection state. Pending counts refer to records not yet acknowledged by apps/memory; Honcho reasoning may still be processing acknowledged records. Delivery wakes after local edits and recovers pending records on server startup. Requests contain at most 20 records, rotate across eligible projects, and retry unacknowledged records with delays capped at one minute. Delivery status updates reach the board automatically. Sending a message to the lead still retrieves recall.

The journal captures saved lead briefs and user-reviewed task results. Reopening a task, or editing a completed task's brief, appends a correction. Existing briefs are backfilled on migration; previous conversations and old accepted results are not bulk imported. Raw tool output and failed executions are not automatically promoted into memory. Decisions, blockers, and next actions carry forward when included in the brief or reviewed result; automatic structured extraction from every conversation is future work.

Recall is limited to the current project. Workers receive local project context but do not call Honcho independently. Recalled text is reference data, and current task state remains authoritative. Each gateway request has a ten-second budget; a lead turn may first wait for an in-flight delivery request. Forgetting/deleting memory and cross-project sharing are not exposed yet.

Deployment lives in brhyt-studio at `apps/memory/deploy`. Its scoped service grants are separate from interactive Clerk authentication. Each environment needs a private service token authorized for its project IDs. Configure the URL and token in the launch process environment, then restart that process. Do not place tokens in committed configuration.

The roc deployment now connects Honcho to the existing Codex login through a local adapter, with CPU embeddings. The [compatibility proof](../../evals/honcho-codex/README.md) covers extraction. The live adapter also translates summary and consolidation requests, serializes inference, retains queued jobs, and pauses on subscription quota errors. It does not use a model API-key fallback.

After setting up a lead, use **Refresh memory status** to check inference jobs. Operator-authorized projects can **Pause memory**, **Resume memory**, or **Retry memory jobs**. These controls apply to the shared memory service, not just the selected project. Pause allows active inference to finish; local capture and background delivery continue. Status is a snapshot refreshed on demand; counts describe adapter inference jobs, while Honcho may still be collecting a batch for up to one minute. A durable receipt does not mean reasoning is finished.

A private `t3po-memory.json` in the server userdata directory can supply `url` and `token` without changing the launcher. The backend reads it at startup, only when neither environment setting is supplied. Keep it mode 600. New project IDs require an explicit gateway grant; current installation grants expire after 90 days and need renewal.
