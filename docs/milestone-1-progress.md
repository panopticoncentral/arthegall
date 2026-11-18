# Milestone 1 implementation evidence

Development checkpoint · November 17, 2026

The reviewed plan is committed. Implementation now includes the TypeScript workspace, shared Zod contracts, separate server and runner SQLite stores, a Fastify API, authenticated WebSocket delivery, the Codex stdio adapter, a runner-managed MCP service, and the React conversation interface. The local setup command and foreground process commands provide a runnable development installation.

This is an implementation checkpoint, not milestone completion or release acceptance.

## Verified locally

| Check | Evidence and scope |
| --- | --- |
| Build and types | Strict TypeScript compilation and production Vite build on Node 26.13.1. Dependencies pinned in the lockfile. |
| Backend tests | Thirteen automated tests cover RPC failures and timeouts, MCP identity and revocation, environment filtering, SQLite reopen and deduplication, pairing limits, queued context ordering, approval decisions, HTTP origins, event cursor handoff, and server disconnection during runner execution. |
| Real browser, deterministic provider | Chromium pairing and invalid-code feedback, messaging, refresh, simulated approval rejection, offline runner queueing, server reconnect with draft preservation, desktop and narrow layouts, navigation focus, and browser revocation. Server and runner are separate child processes. Screenshots were visually inspected. |
| Real browser, real Codex | Two synthetic messages through the browser, server, and runner. Restarting both application processes preserved the conversation; the second turn recalled the synthetic phrase. The runner database recorded the same provider thread and actual model/effort for both turns. |
| Provider probe | Nine live checks against Codex CLI 0.167.0-alpha.4.1 using the advertised default configuration, `gpt-6.2-sol` with low effort. These checks are separate from deterministic-provider tests. |

The nine provider checks cover a permitted workspace read and denied sibling-storage read; rejected identity forgery and invalid MCP credentials; streamed output with an explicit MCP outcome before turn completion; saved-thread resume; completed-turn history inspection; approved and rejected synthetic writes; interruption during a pending approval; and forced process exit followed by inspection of the interrupted turn.

Probe transcripts, generated provider schemas, local credentials, account information, private machine paths, and real usage data are not repository fixtures. The probe prints bounded check summaries. Public examples use synthetic content.

## Permission and recovery findings

The installed provider supports named permission profiles. The implementation creates a fresh profile name per provider process to avoid merging with an unrelated user-defined profile. It grants minimal platform reads and read access to the assignment workspace, with command network access disabled. Bootstrap threads disable native shell, image viewing, browser/computer tools, connectors, plugins, hooks, and provider memory. Inherited MCP servers are explicitly disabled; an empty map alone would merge with existing configuration.

MCP credentials bind to an immutable execution context and expire or are revoked when the run ends. Tool arguments cannot supply a replacement identity. The runner records the explicit outcome before acknowledging the tool call and waits for provider completion before publishing the final result. A provider exit alone never marks a run successful.

The restricted command test read a synthetic workspace note and failed to read a synthetic secret in a sibling directory. This demonstrates that command boundary on the tested macOS build; it does not establish equivalent enforcement on other operating systems or all future Codex versions. The provider exposes separate configuration controls for capabilities outside command execution. [Codex permissions](https://learn.chatgpt.com/docs/permissions)

The approval probe checks the exact synthetic command, its workspace, and its thread before approving. Codex reports a shell-wrapped command, so the probe verifies that wrapper as well. Login shell loading is disabled. The bootstrap administrator does not inherit the probe's shell permission.

A forced exit while awaiting approval left an inspectable interrupted turn. The runner reconciles a saved completed turn with a durable explicit outcome; missing or ambiguous evidence becomes blocked. A crash between submitting a provider request and persisting its response remains an uncertainty boundary. No automatic replay is attempted there. The documented lifecycle APIs support the history inspection used by this implementation. [Codex app-server](https://learn.chatgpt.com/docs/app-server)

The browser's native-approval round trip is not yet connected to real Codex requests: the browser test exercises a deterministic approval, while the provider probe exercises actual native approval separately. Unexpected native requests from the bootstrap administrator are denied.

## Remaining milestone work

- Connect a narrowly authorized real-provider approval exercise through the browser and runner, preserving the default bootstrap grant.
- Add the macOS user-service installer and start/stop/status commands, package the pinned runtime and native dependencies, and verify the packaged installation.
- Complete the application-level failure matrix for provider authentication expiry, abrupt runner termination at dispatch boundaries, and browser refresh during an active real-provider stream. Existing probe and persistence tests cover portions of these scenarios separately.
- Verify a private-network HTTPS reverse-proxy deployment. Loopback access has been exercised locally.
- Run the new CI matrix on Linux and Windows. Its configuration is present; remote CI results are not yet available.

The broader channel, assignment-creation, reporting, scheduling, backup, retention, and update work remains in the later milestones and release verification described by the architecture.
