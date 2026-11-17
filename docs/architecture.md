# First-release technical architecture

Design decisions · November 17, 2026

This document describes the agreed architecture and delivery milestones for the first release. The [product design](design.md) defines the user experience, permissions, and two remaining product questions. The first release centers on a browser conversation with a dedicated administrator agent, followed by creation and scheduled execution of a daily usage-report assignment.

## Stack and process boundaries

Use TypeScript throughout, React for the browser, and Node.js on a supported LTS release for the server and runner. A common language and toolchain lets contributors follow work from the interface through dispatch and execution. Build and type-check TypeScript before shipping JavaScript. Pin the development and CI runtime, and include a compatible Node runtime and required native dependencies in each platform release package.

The server serves the compiled browser assets and owns orchestration. Each runner is a separate process, including when installed alongside the server on the same machine. Runners can continue approved work through a server restart.

| Component | Responsibilities |
| --- | --- |
| Browser | Conversations, folders, assignments, approvals, mentions, and inspection of agent activity. Sends commands and displays server-owned state. |
| Server | Agent definitions, assignments, schedules, conversations, scoped memory, permissions, dispatch, and durable results. |
| Runner | Local workspaces, provider sessions, tool execution, cached assignment context and grants, and durable records of accepted work and undelivered results. |
| Provider adapter | Translates runner operations into provider-specific session requests and translates provider events into Arthegall activity and approval requests. |

Each runner hosts provider sessions on the machine whose workspace and tools they use. An assignment spanning multiple machines uses local sessions on those machines and brings the results back into its central history.

## Persistence and delivery

The server and every runner own separate SQLite databases on their local disks. Communication between them goes through the application protocol. The server stores current state in ordinary tables, accompanied by an append-only activity history. History records who made a change, its assignment context, and the reason or source where applicable. Retention rules govern how long detailed execution events remain available.

State changes, associated history, and pending deliveries commit together in a database transaction. For example, accepting a user approval records the grant, the approval history, and the pending runner notification atomically. A background worker delivers pending records and retries until acknowledged. External calls and provider execution happen outside database transactions.

The runner uses the same pattern for accepted commands, execution state, and results awaiting delivery. Durable commands and results have stable identifiers. Receiving the same delivery again returns the recorded acknowledgment and avoids repeating the accepted operation. An acknowledgment means the receiving side has saved the delivery. Completion is a separate recorded outcome.

For a scheduled report, the server records the run and pending dispatch together. The runner saves the run before acknowledging it, executes the assignment, and retains the result until the server acknowledges receipt. The server records the report message and run completion together. Delivery retries reuse the result identifier.

## HTTP, WebSockets, and shared contracts

Use HTTP with JSON for browser commands and queries, including history retrieval, messages, and approvals. WebSockets deliver live messages, mentions, and assignment updates. The browser reloads missed state from the server after reconnecting.

Each runner initiates an authenticated WebSocket connection to the server. Dispatches and revocations travel to the runner, while acknowledgments, progress, and results travel back. Pairing and update downloads use HTTP. Persistent queues and acknowledgment records supply recovery across broken connections.

A shared TypeScript package defines message schemas, runtime validation, and an explicit protocol version. Server and runner compatibility must be checked as part of reconnecting after an update.

The initial deployment uses a private network, including LAN or tailnet connectivity. Each browser pairs once with a short-lived server-generated code and keeps its session across visits. The user can revoke a browser's pairing. Standalone runners use one-time pairing or SSH installation and pairing.

## Assignments, runs, and sessions

An agent has a stable identity and definition. An assignment describes its responsibility. A run tracks an execution of that responsibility. Provider sessions supply the working context for agent turns within a run.

- Ongoing interactive work resumes its existing session when available.
- Each recurring run starts a fresh session with the assignment instructions and relevant context.
- One agent can have sessions for several assignments active concurrently.
- A follow-up to a report can resume the report's session. If that session is unavailable, a replacement session receives the saved report and conversation.

The runner persists the mapping between Arthegall runs and provider threads. Session replacement, provider changes, and actual runner, model, and effort choices appear in run history. The agent's preferred provider, model, and effort form its default configuration. It may select another permitted, available combination to suit the work.

Each assignment has a dedicated workspace on each runner it uses. Recurring runs get separate working directories. Existing project work records its target explicitly and can use a managed Git worktree when an independent checkout is needed. Usage sources remain in their existing locations and are read by the usage tool. Supporting output belongs in the run workspace.

## Context and memory retrieval

Before starting a session, Arthegall assembles a bounded context containing the agent definition, current assignment instructions, trigger, applicable grants, pending decisions, recent relevant messages, and selected assignment, personal, project, and machine notes. Record the versions of instructions and notes supplied to the run.

Search and read tools let the agent retrieve older conversations, previous results, and additional memory as needed. The tools enforce visibility rules. Personal notes belong to their agent and are inspectable by the user. Colleagues use information shared with them or published into shared memory.

Assignment guidance remains scoped to that assignment unless the user broadens it. Conflicting shared observations retain their evidence and conditions while agents investigate where each applies. A decision that requires the user is raised in the relevant conversation.

## Triggers and concurrency

The server durably records events that require agent attention. DMs and direct mentions wake the addressed agent. Replies in an exchange route to the associated assignment. Schedules start recurring runs. Completion of delegated work wakes the agent waiting for it. Channel membership alone does not trigger a response to every message.

Messages arriving during active work retain their order and are delivered at the next supported opportunity. An execution context processes one agent turn at a time. Separate assignments may execute concurrently.

Each runner has a configurable concurrency limit. The server maintains a durable dispatch queue, favors interactive work over scheduled background work, and increases the priority of waiting jobs so they eventually execute. Already-running work continues. Agents waiting for user input or delegated results release their execution slots while preserving their sessions. This allows a colleague's task to start when the requesting agent is waiting.

Recurring assignments normally catch up with one current run and record missed occurrences. Explicit backfill instructions can require a run for each missed occurrence.

## Codex integration and account ownership

The first provider adapter launches Codex app-server as a local child process and communicates over standard input and output. It manages thread creation and resumption, turns, streamed activity, approval requests, and interruption. It translates these operations into the runner's provider-independent interface. Claude execution support can add another adapter later. The documented Codex interface supports these lifecycle operations. [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)

Each runner has one configured Codex account, shared by agents authorized to execute there. Credentials stay on that machine. The central server records connection status and available capabilities. Arthegall attributes execution to its agent and assignment independently of the shared provider account.

When authentication expires, the runner reports that setup is needed, affected work waits, and the browser surfaces the action required to restore access.

## Tools and permissions

Each runner manages a local MCP service that exposes Arthegall tools to provider sessions. A session's authenticated connection is bound to its agent, assignment, and grants. Caller identity comes from that binding. Tools include memory retrieval and updates, messaging, delegation, agent-definition proposals, run outcomes, and local usage reading.

Arthegall enforces permissions in its tool and dispatch paths and carries applicable grants and action rules into provider execution. The administrator can make routine definition edits with a recorded history. New tools, machine access, and expansion of independent authority require user approval. An approval proposal is saved and presented to the user, and the server applies the grant after the user approves it.

Approving a machine for an assignment grants use of the agent's existing tools there within that assignment. Standing action-specific approval requirements continue to apply. The default grant lasts through assignment completion, including retries. A recurring assignment's approval explicitly covers future runs. The user can instead grant access for one run or across assignments.

Local tools execute on the runner. Central operations go through the server. While disconnected, supported writes can queue with an explicit pending result. Reads use available local context or report that the server is unavailable. Queued operations undergo the server's checks when delivered, and the runner records whether they were accepted.

## Run outcomes and recovery

Agents explicitly report outcomes through structured tools.

| Outcome | Recorded context |
| --- | --- |
| Completed | Result and deliverables. |
| Waiting for the user | The question or approval request. |
| Waiting for delegated work | The assignments whose results are needed. |
| Blocked | The reason and what would allow work to resume. |

A result and its completion commit together on the server. Completing a recurring run leaves the recurring assignment active. Provider failures are recorded separately. A provider turn ending without an explicit outcome requires reconciliation before the run is marked complete.

A disconnected runner continues work within its existing approval scope, retains results locally, and waits at steps requiring new approval. The server marks the outcome unknown and holds off on duplicate dispatch. On reconnect, the runner reports its progress and results to the original assignment.

Revocation blocks new server dispatches immediately. An offline runner applies the revocation on reconnect before taking another step requiring the grant. The UI shows when runner acknowledgment is pending, and the runner reports work performed while disconnected.

Provider failures receive bounded automatic recovery with increasing delays for transient errors. Recovery inspects saved session state and completed actions before resuming the same run. Repeated failures mark the run blocked. If an external action may have succeeded before its response was recorded, recovery checks its outcome before retrying. An unresolved outcome pauses the affected work. The agent may choose another permitted configuration, with the change recorded and replacement context assembled from saved history.

## Dedicated usage-reading tool

The reporting agent uses a read-only runner tool that accepts a date range and returns structured usage data. It parses source records, deduplicates responses, applies time-zone boundaries, calculates totals, and identifies source coverage and unknown figures. The agent presents the findings and answers follow-up questions using these results.

The tool can support comparisons and breakdowns where the source records provide the necessary fields. Scheduling, presentation preferences, and delivery belong to the assignment. Synthetic fixtures verify calculations and failure cases without placing personal usage data into the public repository.

The feasibility check established local Codex input, output, and total token counts, with cached input and reasoning output as included subtotals. Actual spend was unavailable in the inspected records. Missing Claude records produce an explicit unknown. The [product design](design.md#what-the-local-records-support) records this coverage and the remaining Claude verification question.

## Installation and updates

The default installation starts the server and a local runner, enrolls that runner as part of installation, and supplies a short-lived code for the first browser. Setup checks Codex availability and authentication and guides the user through missing prerequisites. A bundled definition creates the dedicated administrator and opens its DM. From there the user creates other agents conversationally.

Standalone runner installation adds other machines through pairing or SSH deployment. Runners fetch signed updates and restart after active work finishes. Local reinstallation or SSH deployment supplies a repair path, preserving pairing and grants on the same machine. Platform packages include the runtime and required dependencies.

## Backups and retention

Provide automatic daily server backups and an on-demand backup command, with a user-selected destination and configurable retention. Backups include a consistent SQLite snapshot and server-managed files referenced by it. SQLite's online backup facilities support creating a database snapshot while the server is running. [SQLite backup documentation](https://sqlite.org/backup.html)

A restored server starts with dispatch paused, reconciles with runners, and surfaces unresolved outcomes before resuming assignments. Runners may have completed work since the backup, so an older server record requires reconciliation before redispatch. Runner workspaces and provider credentials are covered by backups of their respective machines.

Retain conversations, reports, agent definitions and revisions, memories, approvals, and assignment summaries until the user explicitly deletes them. Archiving preserves channel contents. Detailed execution records and intermediate workspace files default to 30 days of retention after a run closes. The period is configurable, and the user can pin a run to preserve its evidence. Explicit deliverables remain with the conversation.

Cleanup preserves records needed by active work, pending delivery, and recovery. Compact records identifying completed commands and results outlive detailed logs so delayed retries can still be recognized.

## Delivery milestones

These milestones are checkpoints toward the first release. The product design supplies the full behavior, including channels, delegation, memory, and approvals.

### 1. Durable administrator DM

Install the server and local runner and pair a browser. Send a message to the bundled administrator, persist and dispatch it, execute through the Codex adapter, and display the response in the browser.

Acceptance covers restarting the server and runner and continuing the same conversation. Exercise a connection drop and verify that the completed response is delivered once after reconnecting. This validates the process boundaries, persistence, session resumption, and application delivery protocol together.

### 2. Create and run the reporting assignment

Use the administrator conversation to create a reporting agent and assignment, obtain required approvals, and run the usage report on demand through the dedicated tool. Save its result and completion and deliver the report as a DM. Ask a follow-up in that conversation and verify it uses the report's context. Verify that missing sources and unavailable spend remain explicit.

### 3. Scheduled reporting and catch-up

Schedule the same assignment to report the previous local calendar day's usage. Execute while the browser is closed and deliver into the existing DM. Verify that a new recurring run receives a fresh provider session with the current instructions and relevant memory. A preference expressed in a reply must carry forward to the next report.

Exercise missed occurrences and confirm that the default produces one current report while recording the missed runs. Verify that explicit backfill follows the assignment's instructions and delivery retries preserve one copy of each result.

### Release verification

Verify the supporting behavior defined above, including waiting agents releasing capacity, bounded recovery, offline execution and revocation, permission-checked tools, and pending central operations. Verify backup restoration with dispatch reconciliation, retention with pinned evidence and durable deduplication records, and platform installation and update behavior. Public samples and fixtures use synthetic data. These checks substantiate release behavior beyond the initial three milestones.
