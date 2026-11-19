# macOS installation and operation

## Build a package

Install the Node and npm versions pinned in `.nvmrc` and `package.json`, then run:

```sh
npm ci
npm run package
```

The default destination is `release/arthegall-darwin-arm64` on Apple silicon (or the corresponding build architecture). Use `node dist/scripts/package.js /path/to/new/destination` after a build to choose a destination. It must not already exist.

The packager installs production dependencies from the lockfile, downloads the matching official Node distribution, verifies its SHA-256 against the distribution's HTTPS checksum manifest, includes its license, and checks native SQLite with the bundled runtime. Build on the target platform and architecture. The installed application does not require Homebrew Node or npm. Codex is installed and signed in separately.

Copy the complete package directory to the destination machine. Keep the package and private data outside agent workspaces. Run its launcher:

```sh
./bin/arthegall install
./bin/arthegall status
```

Installation copies an immutable build into `~/.arthegall/releases`, creates/reuses the local identities, prints a ten-minute browser pairing code, and installs two per-user launchd services. Open the printed URL and enter the code. Services run as the signed-in macOS user and restart at that user's login; they are not system daemons.

Set `ARTHEGALL_DATA_DIR` consistently for an alternate private data directory. Set `ARTHEGALL_PORT` and, when using a proxy, `ARTHEGALL_ORIGIN` before the first setup. Existing configuration wins on repeated setup. Set `ARTHEGALL_CODEX_BIN` to an absolute Codex executable path if it is not on PATH. The installer records that executable and the installation PATH for launchd.

## Operate and diagnose

Use the installed launcher path printed by installation:

```sh
arthegall status
arthegall stop
arthegall start
arthegall restart
arthegall pair
```

Here `arthegall` stands for that full launcher path; installation does not modify shell configuration or PATH. Stop services before replacing an installed build. Repeating setup or installing the same build while stopped preserves identity, history, browser sessions, and provider-thread mappings. Updating and rollback across releases are later release work.

`status` reports each service's state, PID when running, and last exit status. Logs are private files under the data directory's `logs` folder. For foreground diagnostics, stop services, then run `arthegall server` and `arthegall runner` in separate terminals. Each process exclusively locks its own data directory to prevent duplicate runners.

If the browser says **Codex sign-in needed**, run `codex login` as the runner's macOS user. New queued messages remain durable. Interrupted work with uncertain effects is blocked rather than replayed automatically.

## Back up and restore the server

Use the installed launcher and the same data directory as the services. Choose a new directory under an existing private backup destination.

```sh
arthegall backup /path/to/private/backups/server-snapshot
```

The server can stay online. The command uses SQLite online backup, checks database integrity and foreign keys, and writes a manifest with the server identity and SHA-256. The current schema stores all server-managed content, including report evidence and message text, inside the database. Keep the whole directory private. Keep separate machine backups of the installation configuration, runner database, workspaces, and provider credentials.

To restore this installation, keep its local configuration and the newest available runner database. Preserve a backup of the current server first. Stop the services, then use the backup directory as the restore argument.

```sh
arthegall stop
arthegall restore /path/to/private/backups/server-snapshot
arthegall start
```

Restore checks the staged database, manifest, schema and enrolled identity before atomically replacing the server database. A validation failure leaves the current database installed. A successful restore persists a dispatch pause. A paired browser can inspect history and queue messages while dispatch is paused.

Open a paired DM and look for **Dispatch paused after restore**. Each runner must reconnect with a version that supports inventory. The server checks its retained dispatches, decisions and deliveries, including acknowledged results. A recovered scheduled report uses the original occurrence, DM and message IDs. **Resume dispatch** becomes available once every enrolled runner has checked in and all records agree. Restarting either service repeats the check and preserves the pause.

For an unresolved run, use the displayed run ID to inspect its runner execution and the corresponding server activity or approval. Preserve both databases. If evidence was missing, reconnect the runner with its intact records or restore a more recent verified server snapshot, then select **Check runners again**. A missing post-backup interactive command, an earlier scheduled dispatch without its original message IDs, a missing central-operation receipt, or conflicting approval decisions can require a newer snapshot. Recovery keeps dispatch paused while those differences remain.

Run the operator drill against a package with:

```sh
ARTHEGALL_PACKAGE_PATH=/absolute/path/to/package npm exec playwright test -- tests/restore.spec.ts
```

The drill uses a temporary installation, a synthetic provider and isolated usage records. It takes an online backup before the scheduled time, restores only the server, restarts it during replay, repeats a delivery, and checks the original report, evidence and reply target through the paired browser.

## Synthetic native approval acceptance

Installed services keep native shell disabled. To exercise a real approval in an isolated test data directory, run foreground setup/server commands and:

```sh
arthegall runner --approval-exercise
```

Pair that test browser and send `/test native approval`. The runner permits exactly one synthetic file-write command for that run, on a separate provider thread, subject to **Approve once** or **Decline** in the browser. The card identifies the filename and assignment-workspace scope. Do not use this diagnostic flag for the normal service.

Automated live checks make model calls using the configured local account:

```sh
ARTHEGALL_LIVE_CODEX=1 npm exec playwright test -- tests/live.spec.ts
ARTHEGALL_PACKAGE_PATH=/path/to/package ARTHEGALL_LIVE_CODEX=1 npm exec playwright test -- tests/install.spec.ts
```

The installer test creates isolated temporary data and launchd jobs, then stops and removes them. The production data directory is not used. Use distinct Playwright `--output` directories if running checks simultaneously.

## Private-network HTTPS

The server listens only on `127.0.0.1`. For another device, place a trusted TLS reverse proxy on the private network and configure its HTTPS origin at initial setup, for example:

```sh
ARTHEGALL_ORIGIN=https://agents.example.internal ./bin/arthegall install
```

Configure the proxy to forward to `http://127.0.0.1:4317`, preserve the public Host header, and support WebSocket upgrades on `/events` and `/runner`. The application validates Host and browser Origin directly, does not trust forwarded headers, and does not enable CORS. Do not expose the loopback listener itself or disable certificate validation.

Both the browser and runner must trust the proxy's certificate and resolve its hostname. For an internal CA, configure the browser/OS trust store and Node's `NODE_EXTRA_CA_CERTS` before starting the foreground runner. User services require the same CA environment at installation. Secure cookies and WSS are selected by the configured HTTPS origin. Pairing is still required on each browser.

The local automated HTTPS test uses a temporary certificate and separate proxy, verifies both WebSocket routes and Secure cookies, and changes no system trust settings. The owner also confirmed pairing and use from a second device through the deployed private HTTPS endpoint.
