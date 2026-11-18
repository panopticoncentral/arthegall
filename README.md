# Arthegall

A control plane for persistent agents and assignments, with conversations at the center and provider sessions managed by runners.

The first implementation supports a local browser conversation with the administrator through a separate server and Codex runner. Milestone 1 includes a macOS package and user-service installer, with local conversation, approval, recovery, and HTTPS proxy acceptance checks. Second-device deployment remains unverified. See [macOS installation](docs/macos-installation.md) for packaging and service operation. See the [design](docs/design.md), [architecture](docs/architecture.md), [reviewed plan](docs/milestone-1-plan.md), and [implementation evidence](docs/milestone-1-progress.md).

## Run locally

Use the Node version in `.nvmrc` and the npm version in `package.json`. Install Codex separately and sign in with `codex login` on the runner machine.

```sh
npm ci
npm run build
npm run setup
```

Setup creates private data under `~/.arthegall`, seeds the administrator and local runner once, and prints a pairing code valid for ten minutes. Repeating setup preserves identities, messages, and browser pairings. Set `ARTHEGALL_DATA_DIR` before setup and subsequent commands to use another private directory. Keep that directory outside your source checkout and the agent's workspaces.

Start each process in its own terminal:

```sh
npm run server
```

```sh
npm run runner
```

Open the address printed by setup and pair the browser. Generate a replacement code with `node dist/scripts/arthegall.js pair`. Stop either foreground process with Ctrl+C; restart it with the same command. The runner uses the `codex` executable on PATH, or `ARTHEGALL_CODEX_BIN` if supplied. Credentials remain in the runner's local Codex account.

The administrator currently reads conversation context and records explicit outcomes. Agent creation, extra tools, and machine grants arrive in later milestones. Native shell access is disabled for the bootstrap administrator. Provider startup or sign-in problems leave new messages queued; uncertain execution becomes blocked without automatically replaying work.

## Verify

```sh
npm run typecheck
npm test
npm exec playwright install chromium
npm run test:browser
```

Backend and browser tests use synthetic data and a deterministic provider. Browser tests launch real server and runner processes. The CI matrix runs the portable checks on macOS, Linux, and Windows; this checkout has only been verified locally on macOS so far.

Live checks use the configured Codex account and make model calls:

```sh
npm run probe:codex
ARTHEGALL_LIVE_CODEX=1 npm exec playwright test -- --grep 'live Codex'
```

The native probe is currently macOS-specific. It validates permission boundaries, thread resume, MCP identity, approvals for exact synthetic file writes, interruption, and provider-exit recovery. The browser live check validates conversation continuity, real approve/reject decisions, and active-stream refresh through both application processes. Avoid running two Playwright commands against the same output directory at once; use `--output` to separate their artifacts.

For UI development without model calls, run `npm run runner -- --fake` against a separate test data directory. This provider labels its results as synthetic. The `/test approval` message exercises its simulated approval workflow; it performs no file operation.

## Private-network HTTPS

The default listener binds only to loopback. For another device, put a trusted HTTPS reverse proxy in front of the loopback listener and set `ARTHEGALL_ORIGIN` to its HTTPS origin at initial setup. The proxy must preserve that public Host header and support WebSocket upgrades for `/events` and `/runner`. The application does not trust forwarded headers or enable CORS. Browser cookies become Secure for HTTPS origins. The runner must also be able to reach and trust that endpoint. A separate local HTTPS proxy has passed browser and runner acceptance; deployment to another device has not yet been tested.

## Public repository data

Use generic descriptions and synthetic fixtures in source, docs, and tests. Keep credentials, local databases, personal paths, machine names, provider transcripts, and actual usage samples outside committed artifacts. Normal Git author metadata is welcome.
