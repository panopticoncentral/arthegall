# Mac client development

The first native client pairs a Mac with an Arthegall server, opens its existing DMs, and sends messages. Run the server from the same checkout to get the installed-client v1 routes. The app targets macOS 14 or later. A client Mac only needs the app and network access to its server.

## Package the Mac app

Run the Mac packager from a checkout with Xcode selected. It builds a universal Release app for Apple silicon and Intel, signs it, archives it, and verifies the signature and bundle metadata after extracting the ZIP.

```sh
npm run package:mac -- --output release/mac-initial --build-number 1
```

For a private install, pass a signing identity trusted by the target Macs with `--identity`. Use the same bundle ID and signing identity when increasing `--build-number` for the update. The default ad hoc signature supports a local package check. Build the client ZIP separately from the host package.

Extract the ZIP, copy **Arthegall.app** to its installation location, and open it. Enter the server address and code printed by host setup or `arthegall pair`. To update, quit the app and replace it at the same location with the newer build. On reopening, verify that the paired server, selected conversation, saved report and unsent draft are available. The host services continue to run while the app is replaced.

For automated acceptance, build two signed archives with the same unused bundle identifier under `org.arthegall.fixture`, the same signing identity, and increasing build numbers. Build the server with `npm run build`, then run `node tests/mac-update.mjs INITIAL.zip UPDATE.zip` from a logged-in Mac desktop. It uses an isolated installation and synthetic data to verify the first pairing and preserve the saved report, reply target, and draft across replacement.

## Build for development

Build the development app from the repository root using Xcode.

```sh
xcodebuild -project apps/mac/Arthegall.xcodeproj -scheme Arthegall \
  -configuration Debug -derivedDataPath dist/mac build
open dist/mac/Build/Products/Debug/Arthegall.app
```

Enter the configured server address and a code issued by `arthegall pair` on the host. Use the server's trusted private HTTPS origin for remote access. For a local development server, use its printed loopback address. The Connection menu lets you revoke this Mac's pairing. The Mac app stores its credential in Keychain and its drafts and pending message in a private per-pairing Application Support file. Open **Settings** in the sidebar or press **⌘,**. **System** shows the server, runner, provider and paired clients. Configure daily backups using a folder on the server, retry a failed backup, or change the retention period for completed run details.

Under **Agents**, choose a reporting agent to edit its instructions or inspect earlier revisions. Open its assignment for saved preferences, reporting access, schedule changes and closure. A proposed schedule takes effect when approved. The reporter’s DM toolbar and saved reports also link to these settings. **Back to conversation** returns to the selected DM and its draft.

In a saved report, expand **Recorded usage** for source coverage and figures or **Original message text** to read the saved Markdown. Use **Reply to report** to attach that report to your draft. The app keeps the reply target with the draft and with any pending send. For a one-time command request, review the operation in its DM before choosing **Approve once** or **Decline command**.

Open **Run details** below a response to read its activity and pin or unpin its detailed history. After a server restore, choose **Review recovery** in a DM or open **Settings → System**. Review each runner and unresolved run, then use **Check runners again** after correcting the runner records. **Resume dispatch** becomes available when all enrolled runner records agree. See the [host restore instructions](macos-installation.md#back-up-and-restore-the-server).

## Client protocol v1

Use the `/client/v1` prefix and the `X-Arthegall-Client: 1` header for HTTP and the WebSocket upgrade. Pairing uses the existing short-lived code. The JSON response carries the protocol version, session ID, and opaque bearer token. Supply the token in the Authorization header on subsequent requests. A missing v1 route or unsupported pairing version requires a compatible server. Servers with native settings support include `settingsVersion: 1` in the native snapshot. Older servers continue to support conversations and the Mac prompts for a server update when opening Settings. The settings routes share validation, revision checks, recovery restrictions, and session attribution with the browser.

| Operation | Request and response |
| --- | --- |
| Pair | `POST /pair` with `{"code":"synthetic-example"}`. Read `version`, `sessionId`, and `token` from the result. |
| Open conversations | `GET /snapshot` returns the [snapshot schema](../packages/contracts/src/index.ts). The Mac reads conversation identity, role and closure flags, message content and report-request flags, run states, runner connection status, and the event cursor. |
| Follow | Open `/events?after=12` using the snapshot's actual cursor. For example, `{"type":"event","sequence":13,"kind":"message_accepted","data":"{}","createdAt":0}` indicates that a newer snapshot is available. Reconnect from a fresh snapshot, including after a restore. |
| Send | `POST /messages` with `{"commandId":"00000000-0000-4000-8000-000000000001","conversationId":"00000000-0000-4000-8000-000000000002","text":"Synthetic hello"}`. Set `replyTo` to a saved report’s message ID when replying to it. The response contains the run ID. An interrupted send keeps its command ID and payload until acknowledged. |
| Read agent settings | `GET /conversations/:id/settings` returns instructions, revision history, assignment preferences and current grants. |
| Change settings | Post to `/retention`, `/backups/settings`, `/backups/retry`, or the conversation’s `/definition`, `/schedule` and `/close` routes. |
| Decide reporting access | `POST /schedules/:id` for a recurring schedule or `POST /access/:id` for read-only usage access. Requests identify their assignment and runner. |
| Decide one command request | `POST /approvals/:id` with `{"decision":"accept"}` or `{"decision":"decline"}`. Servers that support the route include `commandApprovalsVersion: 1` in the native snapshot. |
| Read run activity | `GET /runs/:id/activity`. Pass the returned `nextBefore` as `before` to load older events. Servers that support native run details and recovery include `recoveryVersion: 1` in the native snapshot. |
| Pin or unpin a run | `POST /runs/:id/pin` with `{"pinned":true}` or `{"pinned":false}`. |
| Reconcile after a restore | `POST /recovery/recheck` to restart the runner inventory check. `POST /recovery/resume` requests resumption and succeeds when the server reports that runner records agree. |
| Revoke | `POST /revoke` with `{}` invalidates the credential and closes its subscription. HTTP 401 prompts pairing again. Errors carry an `error` string, for example `{"error":"Pair this app to continue"}`. |

## Verification

At commit `1e0fae8`, the owner paired the Mac app on a separate laptop over private HTTPS, sent an Administrator DM, quit the app while the reply was in progress, and saw the saved reply after reopening the app. The Swift session drill also recovered a reply across process launches and recorded one dispatch after retrying a send whose acknowledgment was lost. The [checkpoint CI run](https://github.com/panopticoncentral/arthegall/actions/runs/44681752659) passed.

`npm test` exercises pairing expiry, credential separation, event subscription, revocation and send deduplication. To exercise the Mac app with Xcode UI testing, build the services and run the fixture from a logged-in Mac desktop.

```sh
npm run build
node tests/mac-conversation.mjs
```

The fixture starts temporary server and runner stores and a synthetic provider. It drops the HTTP acknowledgment after a send commits. The UI test opens a synthetic report and checks its Markdown heading, table and code block. From Settings it changes retention, enables daily backups to a temporary server folder, revises the reporting agent’s instructions, and proposes and approves a schedule. The fixture verifies the saved records and the backup. The test then relaunches the app, retries the pending message, quits during the turn, and returns to the saved response. The fixture checks the number of messages, receipts, and dispatches. Each test uses a separate app identity for its Keychain entry and local drafts.

Run `node tests/mac-conversation.mjs --session-only` for the same server and runner drill through the production Swift conversation model. This launches three isolated Mac processes to exercise Keychain, WebSocket refresh, durable retry, and recovery of the final reply without driving the window.

Run `node tests/mac-reporting.mjs` after building the services for the reporting drill through the same Swift model. It creates an agent and an on-demand report, approves a daily schedule, and advances the isolated server clock between Mac processes. It checks both scheduled reports and their saved evidence, retries a targeted reply after losing its acknowledgment, and verifies the preference in the next dispatch. It also checks that a declined replacement and a stale decision from a second pairing preserve the active schedule. Add `--ui` to exercise the main reporting journey through the Mac window with Xcode UI testing.

The window test requires the full Xcode app. If the standalone Command Line Tools are selected, the launcher tries `/Applications/Xcode.app` for that run. For Xcode installed elsewhere, set `DEVELOPER_DIR` to its `Contents/Developer` directory when running the test.

Run `node tests/mac-recovery.mjs` to verify recovery through the Swift model, or `node tests/mac-recovery.mjs --ui` to exercise the same journey through the Mac window. The fixture verifies a conflicting edit from a second pairing, an actual CLI backup and restore, a pause across relaunch, recheck with an incomplete runner journal, resume with the intact journal, history cleanup, and a reply to the recovered report. It verifies the report’s original run ID, message ID and stored evidence. Set `ARTHEGALL_PACKAGE_PATH` to use a built host package for the backup and restore commands.

### Authenticated provider and packaged host

Use a runner Mac with Codex installed and signed in. Build the host package in a fresh directory and opt in to the live test.

```sh
package_root=$(mktemp -d)
npm run package -- "$package_root/host"
ARTHEGALL_LIVE_CODEX=1 ARTHEGALL_PACKAGE_PATH="$package_root/host" node tests/mac-live.mjs
```

The Swift client pairs with a temporary packaged server and uses the authenticated Codex runner. It verifies an Administrator DM across a server and runner restart, approval and decline of a single diagnostic file write, scoped usage access, and a reply to a specific saved report. The fixture sets `ARTHEGALL_CODEX_USAGE_DIR` and `ARTHEGALL_CLAUDE_USAGE_DIR` to synthetic usage directories. The test makes live provider calls and removes its temporary pairing after success.

### Keyboard and VoiceOver acceptance

On a logged-in client Mac, pair a disposable app with an isolated host that has a pending command approval and a saved report with recorded usage. The conversation and reporting UI tests check the accessibility labels and Command-Return. Use the app with VoiceOver for the full walkthrough.

1. With macOS Keyboard navigation enabled, use Tab and Shift-Tab between controls and the arrow keys in the conversation list. Open Settings with Command-Comma. Move to the composer, enter a message, and send it with Command-Return.
2. In an approval card, listen for the agent, the exact command and scope, and the consequences of the two decision buttons. In reporting settings, check that the controls distinguish one run, the assignment lifetime, and a recurring schedule.
3. Open a saved report and expand Recorded usage. Check that VoiceOver announces the saved date range, the Codex and Claude sections, and each section’s coverage and counts. Copy text from both the recorded evidence and Original message text and compare it with the displayed fixture.
4. Choose Reply to report, type an unsent draft, and quit and reopen the app. Check that the reply target and draft return together. The signed update test also checks this across app replacement.
