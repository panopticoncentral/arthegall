# Arthegall

Arthegall runs coding sessions on machines you own. A command-line control plane queues work, and a runner on each machine drives the installed Codex or Claude Code harness. The operator can follow conversation and tool activity, answer approvals, queue follow-ups, steer an active turn, interrupt a turn, and end a session.

## Install by machine role

Arthegall uses one npm workspace with two programs. Both run on macOS or Linux with Node.js 24.13 or later. Each program depends on `@arthegall/shared`, which contains the pairing challenge format, prompt command classification, SQLite helpers, and process lock. Each program owns its database schema. The control plane stores projects, the command queue, and session history. Each runner stores its harness sessions, command receipts, and local event journal.

| Machine | Package and executable | Local requirements |
|---|---|---|
| Control-plane host | `@arthegall/control-plane` installs `arthegall` for the server and operator commands | OpenSSL with `req -addext` to generate a certificate, or supply a certificate and key |
| Runner host | `@arthegall/runner` installs `arthegall-runner` | Install and sign in to each coding harness this machine will offer |

Build the installation archives on a development machine from the repository root.

```sh
npm ci
mkdir -p dist
npm pack --workspaces --pack-destination dist
```

Copy the shared archive and the appropriate program archive to each host. From the directory holding those files, run the command for that host. These examples use a user-owned npm prefix. npm resolves the pinned package dependencies during installation.

**Control-plane host**

```sh
npm install --global --prefix "$HOME/.local" ./arthegall-shared-*.tgz ./arthegall-control-plane-*.tgz
export PATH="$HOME/.local/bin:$PATH"
```

**Runner host**

```sh
npm install --global --prefix "$HOME/.local" ./arthegall-shared-*.tgz ./arthegall-runner-*.tgz
export PATH="$HOME/.local/bin:$PATH"
```

Follow [Run on separate machines](#run-on-separate-machines) to connect the hosts.

## Try it on one machine

Use this setup for development when both roles share a machine. Install the requirements for both roles, then run the commands from the checkout.

Install the workspace dependencies once. In each development terminal, add the workspace executables to your path.

```sh
npm ci
export PATH="$PWD/node_modules/.bin:$PATH"
```

Start `arthegall serve` in the first terminal. In a second terminal, start the runner. The first launch creates its key and prints a short-lived pairing code.

```sh
arthegall-runner --name workstation \
  --url wss://localhost:7843/runner \
  --ca ~/.arthegall/control/server.crt
```

In a third terminal, approve that code and list the runner and its available harnesses.

```sh
arthegall pair PAIRING_CODE
arthegall runners
```

The runner listing reports `connectionState`. A connected runner first shows `catching_up` while it replays activity and reconciles commands, then `ready` when dispatch can resume. A paired runner can also show `offline` or `incompatible` with an upgrade hint.

## Projects and sessions

Add a project on a paired runner. Supply a display name, an absolute primary directory on that machine, and any additional directories the harness should receive. Use the returned project ID for launches. The launch returns both a command ID and a session ID.

```sh
arthegall project add RUNNER_ID "Example" /work/server /work/client /work/shared
arthegall launch PROJECT_ID codex "Explain how the server and client fit together."
arthegall sessions PROJECT_ID
arthegall history SESSION_ID --follow
```

The primary directory is the session’s working directory. Each session keeps its own conversation and a snapshot of all launch paths. The runner checks the directories when it launches the session. Codex receives the workspace roots and Claude receives the additional directories through `--add-dir`.

| Project operation | Command |
|---|---|
| List projects, including archived ones | `arthegall project list` |
| Replace the name and complete path list | `arthegall project edit PROJECT_ID "New name" /work/server /work/shared` |
| Archive a project | `arthegall project archive PROJECT_ID` |

Adding the same normalized primary path on the same runner returns its existing project, restoring it if archived. The saved name and additional paths are preserved. Paths are normalized lexically on the control plane, so symlink aliases can identify distinct projects. Additional directories can belong to multiple projects.

Edits apply to future sessions, including sessions created by future schedule occurrences. Archiving blocks new launches. Existing sessions and queued launches keep their saved paths. While the project is archived, scheduled launch attempts record a failed occurrence. Adding the project again allows later occurrences to run.

On upgrade, existing sessions and launch schedules gain a project for their runner and primary path. The original `launch RUNNER_ID HARNESS DIRECTORY "PROMPT"` form still works, including in schedules. It resolves or creates the project for that runner and directory.

Use `claude` as the harness name to start a Claude Code session. The history command prints JSON lines in follow mode. Ctrl-C stops the viewer. The session continues on its machine.

| Operation | Command |
|---|---|
| See session states, active turn IDs, and outstanding approval requests | `arthegall sessions` |
| Steer the named active turn | `arthegall steer SESSION_ID TURN_ID "Updated instruction"` |
| Queue a follow-up | `arthegall send SESSION_ID "Your prompt"` |
| Inspect delivery status | `arthegall commands SESSION_ID` |
| Read new activity after a saved sequence number | `arthegall history SESSION_ID --after 42` |
| Answer a specific approval request | `arthegall approve SESSION_ID REQUEST_ID` or `deny SESSION_ID REQUEST_ID` |
| Cancel a queued prompt | `arthegall cancel COMMAND_ID` |
| Stop a particular turn and retain the queue | `arthegall stop SESSION_ID TURN_ID` |
| Close a session and cancel queued work | `arthegall end SESSION_ID` |

The `steering` field shows `native` for a live Codex turn, `callback` for a controlled Claude turn, and `unavailable` when steering cannot currently be delivered. Older runners may omit this field. Use the `turn` from `sessions` when issuing a steer. Codex accepts it through its App Server. Claude picks it up after a tool returns or when it is about to finish the turn. If the target ends before delivery, the command reports failure. Use `send` when you want a new turn.

Project and session actions accept an optional `--command-id` (UUID v4). Generate it before submission if a script must survive a lost reply. Retry the same action and arguments with the same ID to recover the original response, including the original session ID for a launch. Use a fresh ID for a second intentional submission. The CLI generates an ID by default and prints it on request failure. Read current delivery status with `arthegall commands SESSION_ID`.

## Schedule sessions and follow-ups

The control plane keeps schedules in its SQLite database. Use a scheduled `send` for a follow-up that needs an existing conversation. Use a scheduled `launch` for work that should start with a fresh conversation each time.

```sh
arthegall schedule create send SESSION_ID "Check whether the build finished" --in 5m
arthegall schedule create launch PROJECT_ID codex "Review yesterday's activity" \
  --time 08:00 --days weekdays --zone America/Los_Angeles --missed backfill
arthegall schedule list
arthegall schedule history SCHEDULE_ID
arthegall schedule edit SCHEDULE_ID --time 09:30 --days mon,wed,fri
arthegall schedule cancel SCHEDULE_ID
```

Use `--at 2027-01-15T08:00:00-08:00` for an exact future time. Delays accept positive whole seconds, minutes, hours, or days (`s`, `m`, `h`, `d`). Recurring schedules use 24-hour local time. Omitting `--days` selects every day. The CLI saves its local time zone unless you supply `--zone`. Create and edit show the next three occurrences with their offsets. A repeated local time runs once at the earlier instant. A time in a spring-forward gap moves forward by the size of the gap for that occurrence.

For recurring schedules, `--missed latest` is the default. If several checks become due before the runner can take them, the latest one waits and older unstarted checks appear as skipped. With `--missed backfill`, each due time is retained and released oldest first. Each prompt includes its scheduled date, time, and zone. A delayed one-off remains pending. The control plane checks due times on startup, on reconnect, and on a one-second timer while serving.

Schedule history links each occurrence to its command and session as soon as it enters the queue. The `commandStatus` field shows delivery status, and `status` tracks the occurrence through the harness turn. An uncertain delivery waits for reconciliation. If a delivered turn ends without a verifiable result, history shows `unconfirmed`. Use `arthegall history SESSION_ID` to inspect the activity and output.

Editing replaces the future timing rule and retains the zone and recurring missed-work policy unless overridden. Each occurrence already due keeps its original policy, including reports waiting for backfill. Canceling a schedule withdraws locally queued occurrences and preserves history. Work already dispatched follows normal runner recovery. Ending a session also cancels schedules that send follow-ups to it. A recurring launch schedule survives the end of an individual session it created.

## Run on separate machines

Run the CLI and control plane under the same OS account on the control-plane machine. Operator commands use a private Unix socket. Each runner needs its runner package and the harnesses it will operate.

The control plane listens on loopback by default. On the **first** start of a new control-plane directory, use `arthegall serve --listen 0.0.0.0 --name control.example.net` to generate a certificate for the DNS name runners will use. Alternatively pass `--cert PATH --key PATH` for an existing TLS certificate. Copy the generated **public certificate** to the runner over a trusted channel, then run `arthegall-runner --url wss://control.example.net:7843/runner --ca /path/to/server.crt`. A publicly trusted certificate can use the default trust store. Pair the runner using the operator CLI as above.

Subsequent starts use `arthegall-runner` with the same state directory. The URL, trust certificate, and runner key are saved there. The control plane and runner default to `~/.arthegall/control` and `~/.arthegall/runner`. Use `--dir`, `ARTHEGALL_CONTROL_DIR`, or `ARTHEGALL_RUNNER_DIR` to select separate durable directories. Keep each runner directory on its original machine. It holds the installation identity, command records, native session references, and conversation history. A fresh runner directory requires pairing as a new installation.

## Validation

```sh
npm test
```

The transport test installs the two programs into separate temporary prefixes, pairs them over TLS, and verifies replay after a control-plane outage using a synthetic Claude executable. Real-harness testing on macOS also exercised two-turn conversations, approval handling, runner death during work, control-plane restart, cancellation, named interruption, and ending a session while offline.

See [Runner and control-plane protocol](docs/protocol.md) for the ownership model, reconnect sequence, and recovery limits.
