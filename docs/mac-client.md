# Mac client development

The first native client pairs a Mac with an Arthegall server, opens its existing DMs, and sends messages. Run the server from the same checkout to get the installed-client v1 routes. The app targets macOS 14 or later. A client Mac only needs the app and network access to its server.

Build the development app from the repository root using Xcode.

```sh
xcodebuild -project apps/mac/Arthegall.xcodeproj -scheme Arthegall \
  -configuration Debug -derivedDataPath dist/mac build
open dist/mac/Build/Products/Debug/Arthegall.app
```

Enter the configured server address and a code issued by `arthegall pair` on the host. Use the server's trusted private HTTPS origin for remote access. For a local development server, use its printed loopback address. The Connection menu lets you revoke this Mac's pairing. The Mac app stores its credential in Keychain and its drafts and pending message in a private per-pairing Application Support file. Approval decisions are available in the browser during this milestone.

## Client protocol v1

Use the `/client/v1` prefix and the `X-Arthegall-Client: 1` header for HTTP and the WebSocket upgrade. Pairing uses the existing short-lived code. The JSON response carries the protocol version, session ID, and opaque bearer token. Supply the token in the Authorization header on subsequent requests. A missing v1 route or unsupported pairing version requires a compatible server. This version exposes conversation reads, message sends, live updates, and self-revocation. Approval actions need a later contract that conveys the full requested scope.

| Operation | Request and response |
| --- | --- |
| Pair | `POST /pair` with `{"code":"synthetic-example"}`. Read `version`, `sessionId`, and `token` from the result. |
| Open conversations | `GET /snapshot` returns the [snapshot schema](../packages/contracts/src/index.ts). The Mac reads the conversation IDs, names and closure flags, message IDs, authors, text and states, runner connection status, and event cursor. |
| Follow | Open `/events?after=12` using the snapshot's actual cursor. For example, `{"type":"event","sequence":13,"kind":"message_accepted","data":"{}","createdAt":0}` indicates that a newer snapshot is available. Reconnect from a fresh snapshot, including after a restore. |
| Send | `POST /messages` with `{"commandId":"00000000-0000-4000-8000-000000000001","conversationId":"00000000-0000-4000-8000-000000000002","text":"Synthetic hello"}`. The response contains the run ID. An interrupted send keeps its command ID and payload until acknowledged. |
| Revoke | `POST /revoke` with `{}` invalidates the credential and closes its subscription. HTTP 401 prompts pairing again. Errors carry an `error` string, for example `{"error":"Pair this app to continue"}`. |

## Verification

At commit `1e0fae8`, the owner paired the Mac app on a separate laptop over private HTTPS, sent an Administrator DM, quit the app while the reply was in progress, and saw the saved reply after reopening the app. The Swift session drill also recovered a reply across process launches and recorded one dispatch after retrying a send whose acknowledgment was lost. The [checkpoint CI run](https://github.com/panopticoncentral/arthegall/actions/runs/44681752659) passed.

`npm test` exercises pairing expiry, credential separation, event subscription, revocation and send deduplication. To exercise the Mac app with Xcode UI testing, build the services and run the fixture from a logged-in Mac desktop.

```sh
npm run build
node tests/mac-conversation.mjs
```

The fixture starts temporary server and runner stores and a synthetic provider. It drops the HTTP acknowledgment after a send commits. The UI test relaunches the app, retries the pending message, quits during the turn, and returns to the saved response. The fixture checks the number of messages, receipts, and dispatches. Each test uses a separate app identity for its Keychain entry and local drafts.

Run `node tests/mac-conversation.mjs --session-only` for the same server and runner drill through the production Swift conversation model. This launches three isolated Mac processes to exercise Keychain, WebSocket refresh, durable retry, and recovery of the final reply without driving the window.
