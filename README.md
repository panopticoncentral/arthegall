# Arthegall

A control plane for persistent agents and assignments, with conversations at the center and provider sessions managed by runners.

The administrator can create a Codex reporting agent, request scoped access to the local runner and usage tool, and queue an on-demand report. The Mac app grants usage access for one run or for the assignment. Ask the reporter directly to schedule future work. The reporter delivers results to its own DM and can answer follow-ups about a selected report. The owner has confirmed pairing and use from a second device over private HTTPS.

Agents can schedule follow-ups within an assignment. For example, ask “Check this again in five minutes” or “Send me a summary every weekday at 5 PM Pacific.” Each item can be changed or cancelled individually. The server keeps time while the runner is offline.

See [daily reports and preferences](docs/milestone-3.md), [reporting and coverage](docs/milestone-2.md), [macOS installation](docs/macos-installation.md), [design](docs/design.md), [architecture](docs/architecture.md), and [milestone 1 verification](docs/milestone-1-progress.md).

The [Mac client development guide](docs/mac-client.md) covers building the SwiftUI app and pairing it with a development server.

## Run locally

Use the Node version in `.nvmrc` and the npm version in `package.json`. Install Codex separately and sign in with `codex login` on the runner machine.

```sh
npm ci
npm run build
npm run setup
```

Setup creates private data under `~/.arthegall`, seeds the administrator and local runner once, and prints a pairing code valid for ten minutes. Repeating setup preserves identities, messages, and Mac pairings. Set `ARTHEGALL_DATA_DIR` before setup and subsequent commands to use another private directory. Keep that directory outside your source checkout and the agent's workspaces.

Start each process in its own terminal:

```sh
npm run server
```

```sh
npm run runner
```

Open Arthegall.app and enter the server address and pairing code printed by setup. Generate a replacement code with `node dist/scripts/arthegall.js pair`. Stop either foreground process with Ctrl+C; restart it with the same command. The runner uses the `codex` executable on PATH, or `ARTHEGALL_CODEX_BIN` if supplied. Credentials remain in the runner's local Codex account.

The administrator has structured tools for reporting-agent definitions and assignments. The Mac app presents access requests before a reporting run can dispatch. Native shell access is disabled for the bootstrap administrator. Provider startup or sign-in problems leave new messages queued; uncertain execution becomes blocked without automatically replaying work.

## Verify

```sh
npm run typecheck
npm test
```

The tests use synthetic data and run real server and runner processes where needed. CI runs the portable suite on macOS, Linux, and Windows. See the [Mac client guide](docs/mac-client.md#verification) for window tests and the packaged live Codex test on a signed-in runner Mac.

`npm run probe:codex` exercises provider permission boundaries, thread resume, MCP identity, scoped approvals, and interruption and exit recovery. This opt-in macOS test uses the configured Codex account and makes model calls.

For UI development without model calls, run `npm run runner -- --fake` against a separate test data directory. This provider labels its results as synthetic. The `/test approval` message exercises its simulated approval workflow; it performs no file operation.

## Private-network HTTPS

The default listener binds only to loopback. For another device, put a trusted HTTPS reverse proxy in front of the loopback listener and set `ARTHEGALL_ORIGIN` to its HTTPS origin at initial setup. The proxy must preserve that public Host header and support WebSocket upgrades for `/client/v1/events` and `/runner`. The Mac app and runner both need to reach and trust the endpoint. The server serves the Mac API and does not host a web page.

## Public repository data

Use generic descriptions and synthetic fixtures in source, docs, and tests. Keep credentials, local databases, personal paths, machine names, provider transcripts, and actual usage samples outside committed artifacts. Normal Git author metadata is welcome.

Before every push, review all outgoing commits locally against the destination. Inspect commit messages, filenames, and each commit’s changes, including content removed by later commits. For binary assets, check both their contents and embedded metadata. Look for personal information such as contact details and signing identities as well as the private data listed above.

If anything needs review, stop before pushing. Identify the commit, file, and type of information without quoting the private value. Resume only after the finding is removed from the outgoing history or explicitly cleared for publication, and review the final outgoing commits again.
