# T3PO project work

Open **Ro** to see work across projects. You can rename this entry; its name is saved in this browser. Add a workspace with **Add project**, select it in the sidebar, and choose **Set up lead**. Save a name and the project goals your lead should keep in mind. Selecting the project opens its continuing lead conversation. Choose **Tasks & context** from the chat to manage tasks, memory, the lead brief, and allowances.

Existing chats appear under **Conversations** beneath their project in the sidebar. Choose a conversation to continue its saved history, or **Show more** for older chats. Task conversations remain accessible through **Open work**, and the lead by selecting its project.

The lead's identity and brief are saved on the server. Each turn receives the current project brief and recent task references, including after restarting or changing models. Saved brief changes, reviewed results, and reopened reviews also enter a durable local continuity journal. When `T3PO_MEMORY_URL` and `T3PO_MEMORY_TOKEN` are configured, the server automatically delivers pending records to apps/memory, and lead turns retrieve project-scoped Honcho context. Without a connection, the lead continues with its local records.

Channels appear beneath their project in the sidebar. Use **New channel** there to group work by topic, then select a channel to open its continuing chat with the project lead. Each channel keeps a separate conversation, including after renaming or restarting. The lead receives the shared project brief and memory plus that channel’s recent tasks. **Tasks & context** opens the board filtered to the channel; **All channels** shows the whole project. Use **New task** to save a brief and expected outcome in **Up next**, then **Start task** when ready. **Edit** changes its title, brief, and channel without replacing its history. Brief changes reach the worker on its next turn. The model selector applies to new executions; existing conversations retain their own model settings. New work starts with approvals required, subject to the provider's supported permissions.

Local tasks delegated by a project lead, channel conversation, or task worker through T3's delegation tools also appear on the task board. They keep T3's existing completion callbacks and inherit the channel they came from. Provider-native subagents and cross-machine delegations are not yet represented as separate board tasks.

Expand **Native children** beneath a lead or task to inspect provider-reported child work, including its parent, provider, and status. A child links to its conversation when that conversation exists on the same environment. Children without a local conversation remain visible without a link; this panel does not create editable tasks or grant execution authority.

**Active** shows work in progress, tasks needing your input, and results ready for review. **Open work** opens the conversation, where you can respond to questions, inspect changes, stop execution, or request a revision. **Outputs** keeps the final response from the latest completed run visible while you ask for revisions or new work runs. Each result shows its run number and completion date, and file links open in that task’s workspace. Use **Result history** to browse earlier completed responses, ten at a time. Long responses show an excerpt; **Open work** retains the full response and execution history. Results come from saved execution history and survive restarts and task archiving; deleting or rolling back that execution history can remove them. Linked files remain live workspace files, not immutable artifact copies.

Mark a result complete after reviewing it. Reopen it to return it to review. A later execution needs a new review even if you approved an earlier result.

Use the rename and archive controls beside each sidebar channel. Archived channels can be restored from **Archived channels**. Archiving a channel leaves its tasks visible in the project-wide board and lets you move them elsewhere. It prevents adding new work to that channel.

Archive tasks you want to put aside, then restore them from the board’s **Archived** tab. Stop running work before archiving it. History and files are preserved; archiving does not delete worktrees. Resuming an archived task’s conversation brings it back to the live board.

New tasks default to an isolated Git worktree. The default base follows the repository’s default branch, fetched from its remote when available. Choose a specific base and turn off **Fetch remote base** for a local commit or branch. Worktrees include committed files only. Choose **Project folder** for non-Git folders or work that needs the existing checkout. The workspace choice locks when launch begins; task cards show the actual path and branch after preparation. Existing tasks keep their previous workspace.

Boards update when work changes. Use **Previous** and **Next** to browse pages of up to 50 tasks, including completed and archived work.

Projects currently use one existing T3 workspace each, with optional worktrees for tasks. Cross-project coordination, scheduling, messaging channels and automatic conversation-wide memory extraction are subsequent work. The new interface is available on web and its desktop wrapper; the native mobile application still uses the upstream interface.

## Appearance

Choose **ro**, **droid**, or **lab** for a dark palette, or **paper** for a light palette in Appearance settings. Existing theme selections and installation defaults are preserved.

## Project run budgets

Before starting task work, enter **Task run budget** and **Concurrent task runs** on the project page and choose **Save budget**. There are no default allowances. These are counts of T3 runs, not tokens, subscription quotas, or dollar costs. The run budget is a lifetime ceiling, including existing task history; increase it to authorize more work. Zero prevents new admissions. Lowering a limit does not stop already admitted work. Used and active counts are shown beside the controls; archiving tasks or restarting the server does not replenish the allowance.

Starting a task, revising it in its conversation, and local T3 delegations (including nested workers) share the budget. Queued and waiting runs occupy concurrent slots. Successful, failed, interrupted, and cancelled runs retain their lifetime charge and release their active slot. Retrying the same launch does not charge twice; a new run does. Provider attempts within one run are not separately metered. Ordinary conversations and direct conversations with the lead, including channel chats, remain manual work outside this task allowance; delegated-completion wake runs on the lead are charged.

Project leads and workers require approval-required mode. Continue to ask the user before external actions. This mode preserves the provider's approval behavior; it is not a universal external-action firewall. Provider-native subagents, remote delegations, detached/background processes, scheduling into unrelated threads, and direct CLI or external MCP calls are not comprehensively charged to this local project budget. Do not use those paths to claim budget-controlled autonomous operation. Native mobile does not yet expose budget configuration; configure it in web or desktop first.

## Lead continuity

The lead card shows local continuity, a connected memory service, or a recall unavailable/not-yet-checked state. Pending counts refer to records not yet acknowledged by apps/memory; Honcho reasoning may still be processing acknowledged records. Delivery wakes after local edits and recovers pending records on server startup. Requests contain at most 20 records, rotate across eligible projects, and retry unacknowledged records with delays capped at one minute. Delivery status updates reach the board automatically. Sending a message to the lead still retrieves recall.

The journal captures saved lead briefs and user-reviewed task results. Reopening a task, or editing a completed task's brief, appends a correction. Existing briefs are backfilled on migration; previous conversations and old accepted results are not bulk imported. Raw tool output and failed executions are not automatically promoted into memory. Decisions, blockers, and next actions carry forward when included in the brief or reviewed result; automatic structured extraction from every conversation is future work.

Recall is limited to the current project. Workers receive local project context but do not call Honcho independently. Recalled text is reference data, and current task state remains authoritative. Each gateway request has a ten-second budget; a lead turn may first wait for an in-flight delivery request. Forgetting/deleting memory and cross-project sharing are not exposed yet.

Deployment lives in brhyt-studio at `apps/memory/deploy`. Its scoped service grants are separate from interactive Clerk authentication. Each environment needs a private service token authorized for its project IDs. Configure the URL and token in the launch process environment, then restart that process. Do not place tokens in committed configuration.

The roc deployment now connects Honcho to the existing Codex login through a local adapter, with CPU embeddings. The [compatibility proof](../../evals/honcho-codex/README.md) covers extraction. The live adapter also translates summary and consolidation requests, serializes inference, retains queued jobs, and pauses on subscription quota errors. It does not use a model API-key fallback.

After setting up a lead, use **Refresh memory status** to check inference jobs. Operator-authorized projects can **Pause memory**, **Resume memory**, or **Retry memory jobs**. These controls apply to the shared memory service, not just the selected project. Pause allows active inference to finish; local capture and background delivery continue. Status is a snapshot refreshed on demand; counts describe adapter inference jobs, while Honcho may still be collecting a batch for up to one minute. A durable receipt does not mean reasoning is finished.

A private `t3po-memory.json` in the server userdata directory can supply `url` and `token` without changing the launcher. The backend reads it at startup, only when neither environment setting is supplied. Keep it mode 600. New project IDs require an explicit gateway grant; current installation grants expire after 90 days and need renewal.

## ro connect private beta

ro connect links your devices to T3PO using the existing T3 Code connection protocols. The private source beta has its own installer, service name and data directory; use the [ro connect runbook](../operations/ro-connect-beta.md) for install, start, status, stop, update and pairing. Account-based access requires shared Brhyt sign-in with ro-specific relay configuration and an operator-provisioned relay. The hosted beta is not configured for that flow yet.

## Workstreams in chat

Ask the lead to take on work in the normal chat composer. It can continue an existing job, add an independent job to a matching workstream, or start a new workstream. Ordinary conversation does not need a job. When the intent materially changes scope or permissions, the lead should ask for clarification.

The **Work** panel groups jobs under workstreams and links to their conversations. **Move** corrects a grouping without replacing the job. Workstream completion is independent of job completion; completed and archived streams can be reopened. Archiving pauses undispatched work but does not stop a running job—stop that job explicitly if needed.

Routed jobs use isolated worktrees on the current environment and wait for the project allowance, a concurrency slot, or machine capacity. Queued requests survive server restarts. Follow-ups reuse the job's conversation. Routine successful jobs finish without acceptance; explicitly requested reviews, failures, and approval requests still need attention. The lead should include verification criteria in each brief; a completed provider run is not independent proof that its claims are correct. This routing currently supports local execution, not automatic cross-machine dispatch. Web and desktop show the Work panel; native mobile retains the existing interface.

## Inspect and correct local memory

Open **Project memory** in a project to inspect captured records, twenty at a time. Receipt acceptance confirms that the gateway accepted a record; Honcho delivery and processing are not yet verified in this view.

Operators can correct a record locally. The correction keeps its history, replaces the original in local journal recall, and suppresses any pending delivery of that original. Previously delivered Honcho memory can still be recalled; this does not edit project briefs, erase remote memory, or retract prior conversations. If saving fails, retry the same correction before making another edit.

## Save deliverables and find work that needs you

In a completed result, open **Saved versions** to save its response and selected workspace files. Enter workspace-relative paths, one per line. Files are captured when you save, not reconstructed from the earlier run. Each version preserves its bytes and provenance even after source files or execution history are removed. Limits are twenty files, 1 MiB per file, and 5 MiB total. Download saved files from the version; historical text links still refer to the original workspace. Saving another time creates another version.

The project’s **Needs you** list collects pending questions, plans, failed work, and completed results awaiting review. Its first page also shows an exhausted task-run allowance, disabled new task runs, and pending memory records with an unsuccessful delivery attempt. **Review run budget** opens the existing allowance controls; **Review memory delivery** opens the local memory inspector. These notices clear when the blocking condition is resolved. A temporarily full concurrency limit is not a decision request, and a missing delivery receipt does not establish whether Honcho processing succeeded. Open an item to respond or review through its existing task conversation. It does not approve actions or start work. Lists are paginated, and a page can be empty while further pages remain. Reviewing an earlier run does not dismiss a newer result.
