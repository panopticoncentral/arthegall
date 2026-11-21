# Move Arthegall into installed apps

Proposed November 19, 2026. The migration ends with the installed Mac app as Arthegall’s sole user client and the browser client retired. This plan proposes SwiftUI for the Mac interface and AppKit where a Mac interaction needs it. Phone access gets its own plan when needed. Windows and Linux clients are also deferred.

## What the owner installs

Install Arthegall.app on the Mac where the owner wants to use it. On first launch, enter the Arthegall server address and the short-lived pairing code from setup or `arthegall pair`. The sidebar opens on the existing conversations. Pairing a second Mac should be as easy as pairing the first. Only a machine acting as a host needs the server package, and only a runner needs its provider and credentials.

The app can quit, update, or reconnect while a runner is working. The server continues to own schedules, grants, history, and dispatch. Local app storage holds the paired server identity, credential in Keychain, selected conversation, drafts, and enough information to resolve an interrupted send. Scope these records to the pairing. The first release can load conversation history from the server whenever it connects.

## 1. Pair a Mac and finish one conversation

Deliver a small SwiftUI app with server setup, a conversation sidebar, a transcript, and a composer. Use Foundation networking against the existing HTTP API and event WebSocket. Build the app as a separate target in the repository and produce a launchable app bundle in the first milestone.

- Define the client contract from the [server routes](../apps/server/src/server.ts) and [wire schemas](../packages/contracts/src/index.ts). Capture synthetic request, snapshot, event, and error examples for Swift decoding and server tests. Define how an installed client recognizes an incompatible server or an approval scope it cannot display. A client must understand the full grant before it can approve it.
- Add an explicit native pairing exchange. The proposed design reuses the expiring code, rate limiting, revocable session records, and server-side attribution. The app presents its scoped session token on API requests and the event socket. Keep credentials bound to the paired origin, use trusted HTTPS for remote hosts, and support the existing loopback setup. Retain the browser cookie and origin checks during coexistence. Test expiration, revocation of a connected app, and a browser and app paired independently.
- Fetch the snapshot and subscribe to events after its cursor. Refresh from the server after sleep, reconnect, or a restore that moves the cursor backward. Persist the outgoing command ID, conversation, text, and reply target before sending. Retry an uncertain send under its original pairing with the same ID.

**Acceptance.** Launch the app on a Mac and pair to an existing private HTTPS installation. Open an existing Administrator DM, send a message, see progress, quit during the turn, and reopen to its saved reply. In an isolated installation, drop the send acknowledgment and verify one server message and one dispatch after retry. Repeat pairing against a local loopback installation. The remote Mac needs only the app and network access to the server.

## 2. Run the daily reporting workflow from the app

Use a native split view for DMs, with a selected conversation and per-conversation drafts. Preserve the interaction between a report, its source evidence, its run, and a reply to that particular report. Implement Markdown tables, selectable text, safe links, original message text, recorded usage, and the distinction between unknown figures and zero.

Implement one-time command decisions, reporting access for a run or assignment, and recurring schedule decisions. Show the actual operation or the agent, runner, tool, duration, and schedule as appropriate. Show the active and proposed schedules together when one replaces another. Refresh a request that was resolved by another client. Surface queued work, runner disconnection, provider sign-in, and uncertain execution as distinct states.

**Acceptance.** Starting in the Mac app, create a reporting agent, grant access, obtain an on-demand report, and approve a daily schedule. Quit the app before delivery. Reopen, read the scheduled result, inspect coverage, and reply to that report to change a preference. Verify that the next report uses the preference and retains its own evidence. Exercise decline and stale-decision paths with a second paired client. Use the existing [reporting](../tests/reporting.spec.ts), [scheduling](../tests/scheduled.spec.ts), and [Markdown](../tests/markdown.spec.ts) scenarios as behavioral references.

## 3. Bring over Settings and recovery

| Mac destination | Workflows to carry over |
| --- | --- |
| System settings | Inspect runner and provider state, inspect pairings, unpair this client, configure daily server backups, inspect failures and retry, change retention. Label backup destinations as paths on the server, including when the Mac app runs elsewhere. |
| Agent and assignment settings | Navigate from the sidebar, DM, or report to the same records. Read and revise instructions with revision conflict handling. Inspect access, preferences, and history. Propose a schedule change, review it in Settings or the DM, and close an assignment while retaining its conversation. |
| Run details and restore recovery | Read activity, pin and unpin evidence, distinguish pruned and pending details, inspect the post-restore pause and unresolved records, recheck runners, and resume when the server allows it. The operator continues to perform the database restore with the host CLI. |

**Acceptance.** Repeat the [settings](../tests/settings.spec.ts) and [packaged restore drill](../tests/restore.spec.ts) through the native UI where the owner interacts with it. Use an isolated host with existing history and an already-paired client. Verify that a restored report retains its original reply target, conflicting edits require review, and the app accurately presents a paused server after relaunch.

## 4. Ship the Mac app and retire the browser client

- Package the app separately from the host services for private installation. Set the supported macOS versions against the Macs that will run acceptance. Produce signed builds, and verify a clean install and an in-place app update on a client Mac. Update host setup output and installation instructions to give the server address, pairing code, and app launch steps.
- Run Swift contract tests and native UI tests against real server and runner processes with the synthetic provider. Repeat the core DM, approval, and report journey against packaged services with an authenticated provider. Verify keyboard-only navigation, VoiceOver labels for approval scope and report evidence, text selection, and draft restoration. Check an app/server version mismatch before shipping independently updatable clients.
- Use the browser as a reference while completing the earlier milestones. Once the owner can complete daily reporting and the recovery drill in the Mac app, transfer the remaining browser test coverage to native UI or API tests. Remove the React client, its build and packaging steps, static UI hosting, browser-only CI, and browser setup instructions.
- End browser-cookie authentication for both API requests and the event socket. Preserve the records linking past user decisions to their sessions. The Mac app continues to use the server’s HTTP API, WebSocket, and native pairing flow.

**Completion check.** Upgrade an existing installation to the final package. Launch the paired Mac app, open a report created before cutover, inspect its evidence, and send a reply. Verify that the server no longer serves the browser UI and that an old browser session cannot read the API or subscribe to events. Repeat first-launch pairing on a clean Mac app installation using the final setup instructions.

Native notifications that open the exact pending decision would be a good first Mac-specific enhancement. The four milestones above deliver a usable replacement on their own. Later platform work can reuse the pairing contract, compatibility rules, synthetic fixtures, and end-to-end scenarios developed on Mac.
