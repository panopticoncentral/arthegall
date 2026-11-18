# Milestone 1 implementation plan

Reviewed plan · November 17, 2026

## Outcome and review scope

Milestone 1 delivers a durable conversation with the built-in administrator. A user pairs a browser, sends a message, receives a Codex-backed response through the local runner, and continues the conversation after process restarts or a connection interruption. The [architecture](architecture.md) defines the broader first release.

This plan records the reviewed implementation sequence, dependency choices, security details, and UI treatment. Implementation was authorized after review; the [progress record](milestone-1-progress.md) distinguishes completed checks from remaining acceptance work. Milestone 2 adds conversational creation of agents and the on-demand usage assignment. Milestone 3 adds scheduled reporting and catch-up.

## Engineering baseline

| Area | Choice and reason |
| --- | --- |
| Workspace | One npm workspace with server, runner, web, and shared-contract packages. Keep database code with the process that owns it. |
| Runtime | Pin a supported Node LTS version, compile TypeScript with strict checking, and ship a platform-specific runtime with release packages. |
| HTTP and WebSockets | Fastify with its WebSocket plugin. Serve the compiled React client from the same origin as the API. |
| Browser | React with Vite for development and production asset builds. Use ordinary CSS for the initial conversation layout. |
| Contracts | Zod schemas with inferred TypeScript types, explicit protocol versions, and validation at every network or process boundary. |
| SQLite | Use better-sqlite3 with explicit SQL migrations and short transactions. Verify its native package against the pinned runtime on each CI platform. |
| MCP | Use the official TypeScript SDK for the runner's authenticated local tool service. |
| Tests | Node's test runner for contracts, persistence, and recovery. Playwright for browser pairing, messaging, and reconnect behavior. |

These libraries supply the required HTTP, validation, SQLite, and browser-testing capabilities. Exact versions will be pinned together when implementation begins. The native SQLite binding adds a packaging check to the runtime build. [Fastify](https://fastify.dev/docs/latest/), [WebSocket plugin](https://github.com/fastify/fastify-websocket), [Zod](https://zod.dev/), [better-sqlite3](https://github.com/WiseLibs/better-sqlite3), [Vite](https://vite.dev/guide/), [MCP SDKs](https://modelcontextprotocol.io/docs/sdk), [Node tests](https://nodejs.org/api/test.html), [Playwright](https://playwright.dev/docs/intro)

The package boundaries are `apps/server`, `apps/runner`, `apps/web`, and `packages/contracts`. The Codex adapter and MCP service begin as runner modules. Extract further packages only when there is an actual shared caller.

## Initial installation boundary

Validate the complete local installation on macOS first. Run portable contract, persistence, and fake-provider tests on macOS, Linux, and Windows. Additional platform installers remain part of the wider release work.

A local setup command creates separate server and runner data directories, seeds the administrator definition and DM once, enrolls the local runner, and starts the two processes. Setup is safe to repeat. Install a macOS user service for each process so the local runner has access to that user's configured Codex account. Include start, stop, status, and foreground diagnostic commands.

The first browser receives a pairing code through the local setup flow. The server stores a verifier for a short-lived, single-use code, limits failed redemption attempts, and consumes the code atomically. After pairing, the browser receives an opaque HttpOnly session cookie. Validate request origin for browser mutations and WebSocket upgrades. Browser sessions and runner credentials have distinct roles, and revocation invalidates the applicable connection.

The transport boundary for this milestone is loopback access for the same-machine browser and runner. Access from another device uses a trusted HTTPS endpoint on the private network, with Secure cookies and WSS. Document a private-network HTTPS setup alongside the local installation. TLS termination and trusted-proxy configuration must be explicit in implementation. Pairing secrets and provider credentials are excluded from URLs, ordinary logs, and public fixtures.

The administrator receives a narrowly defined bootstrap execution grant during local setup, recorded in history. Its initial tools support conversation, runtime-status inspection, and reporting a run outcome. Define its startup model and effort from a supported configuration available to the runner, and record the resolved choice. Missing provider access produces a visible setup state.

## Integration probe before the main build

Use an isolated test workspace and synthetic messages to verify the installed Codex app-server interface. Record the tested Codex version and capabilities. The probe will establish the following behavior.

1. Start a thread and turn, receive text and activity events, and observe turn completion.
2. End the provider process, resume its saved thread, and verify that a follow-up retains the earlier synthetic context.
3. Connect the runner-managed MCP service with a credential bound to one execution context. Verify that an identity supplied in tool arguments cannot replace that binding.
4. Call a context-read tool and an explicit run-outcome tool. Verify ordering between provider events and tool completion.
5. Exercise approval and rejection with a harmless synthetic file operation, and interrupt an active turn.
6. Inspect which provider state can be recovered after a process exits during a turn. Identify cases that must become an uncertain or blocked outcome.

Test permission enforcement in the actual provider configuration, including any native shell and filesystem capabilities. Keep server storage and credentials outside the provider's allowed workspace. If a configured capability can bypass a promised tool restriction, revise that configuration before enabling it. The probe must report the boundary it actually demonstrates. [Codex app-server documentation](https://learn.chatgpt.com/docs/app-server)

## Durable records and identifiers

The server schema starts with the records needed for the administrator conversation.

| Record group | Required relationships and constraints |
| --- | --- |
| Identity and setup | Stable server and runner IDs, browser sessions, runner credential verifiers, consumed pairing codes, administrator definition revision, and bootstrap grant. |
| Conversation | A stable administrator DM, ordered messages, author identity, reply association, and browser-generated command ID. |
| Execution | An internal conversation assignment, runs and turn attempts, initiating message, runner selection, definition version, current outcome, and any pending approval. |
| Delivery and history | Accepted command receipts, runner result receipts, append-only activity, ordered browser events, and an outbox of pending dispatches. |

The internal assignment supplies identity and scope to a DM turn before user-created assignments arrive in milestone 2. The UI presents the continuing conversation. A new user message creates a new run in that execution context, with one active turn at a time. The runner reuses the provider thread for subsequent interactive runs.

The runner stores accepted dispatches, the context and grant snapshot, run-to-provider-thread mappings, turn-attempt state, sequenced output, pending MCP operations, and result deliveries. Unique constraints apply to command IDs and result IDs within the authenticated sender's scope. Reuse of an ID with different content is rejected.

Use foreign keys and transactional migrations. Seed operations and reconnect handshakes are idempotent. A database failure returns an error before an acknowledgment is sent.

## Initial API and event contracts

| Operation | Behavior |
| --- | --- |
| Redeem pairing code | Atomically establish one browser session or return a bounded validation failure. |
| Load conversation | Return ordered durable messages, pending approvals, run state, and a consistent event cursor. |
| Send message | Accept a browser command ID and message, then transactionally save the message, execution request, history, and dispatch intent. Repeated delivery returns the saved receipt. |
| Subscribe to browser events | Resume after a cursor. If history is unavailable, reload a snapshot with its cursor and continue from there. |
| Connect runner | Authenticate runner identity, check protocol compatibility, exchange resumable delivery state, and reconcile outstanding runs. |
| Accept dispatch | Save the command locally before acknowledging it, then schedule execution. |
| Publish activity or result | Carry run, attempt, delivery, and ordering identifiers. Save durable updates before publishing them to browsers. |
| Answer approval | Bind the decision to the exact pending request and user session. Reject stale or mismatched decisions. |
| Revoke browser | Invalidate the session and close its authenticated live connection. |

Snapshot loading and subscription use a cursor handoff that covers messages arriving between the two operations. Provider text fragments update one provisional assistant message. Final output replaces or finalizes that message through the same stable identity. A stream interruption leaves it visibly incomplete until reconciliation.

The runner saves a dispatch before starting Codex. There is still a possible crash between sending a provider request and saving its response. Recovery inspects the provider thread and saved attempt state before making another call. An unresolved case becomes blocked with its evidence retained. Application-level deduplication covers message and dispatch delivery; recovery must also account for external action outcomes.

## Implementation sequence

| Step | Deliverable and exit evidence |
| --- | --- |
| A. Provider probe | Verified thread resume, MCP identity, approval handling, interruption, and documented recovery limits using synthetic data. |
| B. Process and data foundation | Independent server and runner entry points, migrations, local setup, stable identities, repeated-start safety, and contract validation. |
| C. Durable dispatch | Persisted browser commands, authenticated runner connection, dispatch receipts, and result deduplication exercised with a deterministic fake provider. |
| D. Real administrator session | Codex adapter, minimal MCP tools, bounded context, session mapping, explicit run outcomes, and a live multi-turn administrator conversation. |
| E. Browser experience | Pairing, DM history, streaming, ordered follow-ups, activity inspection, and distinct connection and authentication states. |
| F. Recovery and packaging | Restart and disconnection matrix passes, browser revocation works, packaged local setup reproduces the experience, and public artifacts pass the privacy review. |

The fake provider drives deterministic failure tests and runs separately from the real adapter acceptance check. Model calls use the real configured account only in the live verification flow. Test reports identify which mode produced each result.

## UI sketch specification

The review sketch uses invented conversation text, a generic runner name, and a visibly demonstrative pairing code. Its interactions are local simulations. The accepted visual treatment is a restrained neutral interface with a left conversation rail, a central message history, and a bottom composer. Use readable sans-serif typography, compact timestamps, and text labels alongside status indicators.

| State | Visible behavior |
| --- | --- |
| Pair browser | A single pairing-code field with a clear submission action and inline invalid or expired-code feedback. |
| Connected conversation | Administrator selected under Direct messages. Messages remain in chronological order. Activity and connection details are available on demand. |
| Responding | Text streams into one assistant message with a visible working state. Follow-up input is queued in order for the same context. |
| Approval needed | A contextual request identifies the operation and scope with explicit approval and rejection controls. |
| Runner disconnected | The server remains usable. Existing execution shows an unknown outcome, and new messages can be accepted as queued for the runner. |
| Server unavailable | The last loaded conversation remains visible. The composer retains its draft and shows that sending is unavailable until reconnection. |
| Codex sign-in needed | A setup action explains which runner needs attention. Messages accepted by the server stay visibly queued. |
| Recovery blocked | The run shows a concise reason and retains partial output. Activity explains what is known. |

On narrow screens, a conversation-navigation button opens the rail and returns focus to it when appropriate. Selecting the DM restores the main view. Keep the composer and pending decision controls usable with the keyboard and touch. Initial screens expose the administrator DM and connection details; later milestones populate the broader channel and assignment experience.

An approval card in this sketch illustrates the harmless probe operation. The milestone verifies that approval can travel through the conversation and resume the correct provider request. Agent creation and grants to newly created agents arrive with milestone 2.

## Acceptance matrix

| Scenario | Required result |
| --- | --- |
| Fresh setup and repeat setup | One local runner, one administrator, and one DM. Existing data and pairing survive repeat setup. |
| Pairing validation | A valid code works once. Invalid, expired, and already-used codes produce clear errors. Unpaired clients cannot read conversations. |
| Live conversation | Real Codex output appears in the browser. A follow-up uses prior conversation context. The recorded provider configuration matches the execution. |
| Duplicate send | Retrying the same browser command ID produces one user message and one dispatch. A conflicting payload is rejected. |
| Duplicate result | Repeating an acknowledged runner result creates one final assistant message and one completion record. |
| Browser refresh during streaming | Durable output is restored in order. Finalization updates the same assistant message. |
| Browser subscription race | An event arriving between snapshot retrieval and subscription is visible once. |
| Server restart while runner works | Approved work continues. The runner retains its result and delivers it after reconnecting. |
| Lost runner acknowledgment | A repeated dispatch recognizes already-accepted work and avoids a second execution. |
| Runner or provider restart | A completed session can resume for the next message. An interrupted attempt is reconciled or marked uncertain before retry. |
| Approval delivery | Approval applies to the exact pending request. Rejection prevents the requested action. A stale answer cannot grant a later request. |
| MCP identity and scope | A session can call only its allowed tools under its bound identity. It cannot impersonate another run or access server storage through provider capabilities. |
| Missing Codex authentication | The browser shows the runner's setup need, and the queued message remains durable. |
| Browser revocation | Further requests and the live connection lose access. A replacement browser requires pairing. |
| Mobile and keyboard use | Pairing, message entry, navigation, and approval work at narrow width with visible focus, labels, and readable status text. |

Inspect real database records, process ownership, and the actual browser as part of acceptance. Retain sanitized test summaries and synthetic fixtures in the repository. Local provider transcripts, personal paths, machine names, account details, credentials, and actual usage samples stay outside public artifacts.

## Review record and completion evidence

The dependency baseline, macOS-first installer acceptance, loopback plus private HTTPS access, minimal bootstrap grant, and UI layout and status wording have been reviewed and accepted. The broader product and architecture decisions remain the basis for implementation. Acceptance of the plan does not establish that the provider integration or recovery behavior has been verified; those checks remain implementation work.

Milestone 1 is complete when a packaged local installation passes the live administrator conversation and restart/reconnect checks, automated failure tests pass, and browser behavior matches the reviewed sketch. Record the tested runtime and Codex versions, synthetic test results, and any remaining limitations. The product questions about channel proliferation and Claude reporting remain open in the product design.
