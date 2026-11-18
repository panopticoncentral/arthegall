# Milestone 1 implementation evidence

Implementation and local acceptance · November 17, 2026

The reviewed plan is committed as `395b54a`; the reviewed initial implementation is committed as `185d316`. The application includes separate server and runner SQLite stores, authenticated HTTP and WebSocket delivery, the Codex stdio adapter, a runner-managed MCP service, and a React conversation interface.

Milestone 1 now includes a macOS release packager and user-service installer. Local acceptance covers the real administrator conversation, native approvals, refresh/restart recovery, and an HTTPS reverse proxy. Deployment on another device remains unverified because no private-network endpoint is configured. Remote CI results are recorded separately below; local checks do not establish other-platform enforcement.

## Verification

| Check | Evidence and scope |
| --- | --- |
| Build and types | Strict TypeScript compilation and production Vite build using Node 26.13.1 and npm 11.20.0. |
| Backend tests | Nineteen automated tests cover RPC failures/timeouts, MCP identity and revocation, environment filtering, persistence and deduplication, pairing limits, queued context ordering, approval decisions during streamed commentary, HTTP origins, event cursor handoff, server disconnection during execution, process ownership, and five application recovery boundaries. |
| Browser, deterministic provider | Chromium pairing and invalid-code feedback, messaging, refresh, simulated approval rejection, offline queueing, reconnect with draft preservation, desktop and narrow layouts, keyboard navigation, and browser revocation. Server and runner are separate processes. |
| Browser, real Codex | Conversation continuity after restarting both processes; approved synthetic write and rejected write with filesystem assertions; pending-approval refresh; active streamed-response refresh with one final message. Exercise threads never replace the ordinary administrator thread. |
| Packaged installation | Official checksum-verified Node runtime and native SQLite binding bundled with production dependencies. Isolated macOS launchd installation, live browser conversation, stop/start, repeated setup and installation, restart/status, and duplicate-process exclusion. |
| HTTPS proxy | Ephemeral certificate trusted explicitly by the runner and pinned in Chromium. Pairing, Secure/HttpOnly/SameSite cookies, browser WSS, runner WSS, messages, and refresh through a separate TLS proxy. This is a local test, not a second-device deployment. |
| Provider probe | Nine live checks against Codex CLI 0.167.0-alpha.4.1, using the advertised default `gpt-6.2-sol` with low effort. Covers restricted reads, MCP identity, explicit outcomes, thread resume/history, approve/reject, interruption, and provider exit. |
| Cross-platform CI | macOS/Linux/Windows workflow is configured; remote execution remains to be recorded. |

Live model tests are opt-in. Synthetic JSON-RPC provider tests exercise the real server, runner, MCP service, and process boundaries without a model call. They do not claim to simulate every provider failure.

## Permission boundaries and approvals

Each provider process gets a fresh named permission profile. It permits minimal platform reads and assignment-workspace reads, with command network access disabled. Ordinary administrator threads disable native shell, image viewing, browser/computer tools, connectors, plugins, hooks, and provider memory. Inherited MCP servers are explicitly disabled rather than relying on an empty merged map.

MCP credentials bind to one immutable execution context and are revoked at the end of its run. Identity cannot be supplied in tool arguments. An explicit outcome is saved before acknowledging its tool call; it becomes final only after provider completion. A provider exit alone is not success.

The foreground runner's optional `--approval-exercise` flag enables the exact `/test native approval` message. Only that run gets a separate synthetic provider thread with shell enabled. The runner accepts at most one approval request and validates its method, thread, turn, workspace, non-login shell wrapper, and exact synthetic write command. The browser decision is for that one request. Any alternative native request is denied. Installed services never enable this flag, and the bootstrap grant remains unchanged. The activity history records the exercise and the exact command.

The permission probe demonstrates the tested command boundary on macOS, not equivalent enforcement on other platforms or future provider builds. The provider separately controls capabilities outside command execution. [Codex permissions](https://learn.chatgpt.com/docs/permissions)

## Recovery behavior

- A dispatch saved locally before provider startup remains queued if sign-in is needed or the runner dies before starting work.
- Authentication failure during a started turn becomes blocked and shows sign-in needed. Started work is never silently requeued.
- A crash after requesting a turn but before saving its response is uncertain and becomes blocked without replay.
- A durable explicit outcome plus a saved turn that provider history identifies as completed can be reconciled after restart.
- A partial response or pending approval without sufficient completion evidence becomes blocked. Late approval decisions cannot grant a later run.
- An exclusive OS-backed SQLite process lock prevents simultaneous foreground/service processes from owning the same server or runner data directory; process exit releases the lock.

The lifecycle API supplies the thread history used for reconciliation. [Codex app-server](https://learn.chatgpt.com/docs/app-server)

## Installation and remaining acceptance

See [macOS installation](macos-installation.md) for packaging, services, diagnostics, and private-network HTTPS configuration. The default listener remains loopback-only.

A real private-network endpoint and second-device check remain open. Linux/Windows CI results are not yet recorded. Additional platform installers, agent creation, channels, reporting, scheduling, backup, retention, and updating belong to later milestones or release verification.

Provider transcripts, generated schemas, local databases, service logs, credentials, account details, private paths, and real usage samples remain outside public artifacts. Tests and documentation use synthetic content.
