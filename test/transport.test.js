import test from "node:test";
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { randomUUID, generateKeyPairSync, sign } from "node:crypto";
import https from "node:https";
import WebSocket, { WebSocketServer } from "ws";
import { once } from "node:events";
import {
  copyFileSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { dirname, join, delimiter } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";

const checkout = fileURLToPath(new URL("../", import.meta.url));
const exec = promisify(execFile);
const fixtures = fileURLToPath(new URL("./fixtures", import.meta.url));
async function until(check) {
  for (let i = 0; i < 100; i++) {
    const value = await check();
    if (value) return value;
    await delay(80);
  }
  throw Error("Timed out waiting for " + check.toString());
}
test("paired runner journals model activity across a control-plane outage and replays it once", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "arthegall-"));
  const control = join(root, "c"),
    runner = join(root, "r"),
    cwd = join(root, "work");
  mkdirSync(cwd);
  const services = [];
  function service(cli, args, env) {
    const p = spawn(cli, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    services.push(p);
    p.log = "";
    p.stdout.on("data", (b) => (p.log += b));
    p.stderr.on("data", (b) => (p.log += b));
    return p;
  }
  async function stop(p) {
    if (p.exitCode === null && p.signalCode === null) {
      const ended = once(p, "exit");
      p.kill();
      await ended;
    }
  }
  t.after(async () => {
    for (const p of services.reverse()) await stop(p);
    rmSync(root, { force: true, recursive: true });
  });
  // Pack from the checkout; everything after packing runs outside the workspace.
  const npmOptions = [
    "--offline",
    "--ignore-scripts",
    "--cache",
    join(root, "cache"),
  ];
  const pack = async (cwd, ...args) => {
    const { stdout } = await exec(
      "npm",
      ["pack", ...args, "--json", "--pack-destination", root, ...npmOptions],
      { cwd },
    );
    return JSON.parse(stdout).map(({ name, filename }) => [
      name,
      join(root, filename),
    ]);
  };
  const archives = new Map(await pack(checkout, "--workspaces"));
  // Supply the installed third-party dependency locally to keep this test offline.
  const [[, wsArchive]] = await pack(join(checkout, "node_modules", "ws"));
  const [[, calendarArchive]] = await pack(
    join(checkout, "node_modules", "luxon"),
  );
  async function install(role, binName, otherRole, otherBin) {
    const prefix = join(root, role);
    await exec(
      "npm",
      [
        "install",
        "--global",
        "--prefix",
        prefix,
        "--no-fund",
        "--no-audit",
        ...npmOptions,
        wsArchive,
        ...(role === "control-plane" ? [calendarArchive] : []),
        archives.get("@arthegall/shared"),
        archives.get("@arthegall/" + role),
      ],
      { cwd: root },
    );
    assert.equal(
      existsSync(join(prefix, "lib", "node_modules", "@arthegall", otherRole)),
      false,
    );
    assert.equal(existsSync(join(prefix, "bin", otherBin)), false);
    return join(prefix, "bin", binName);
  }
  const cli = await install(
    "control-plane",
    "arthegall",
    "runner",
    "arthegall-runner",
  );
  const runnerCli = await install(
    "runner",
    "arthegall-runner",
    "control-plane",
    "arthegall",
  );
  // Give each host only the runtime tools it needs. Neither can find the
  // other executable, and the control plane cannot discover a coding harness.
  const controlBin = dirname(cli);
  const runnerBin = dirname(runnerCli);
  for (const bin of [controlBin, runnerBin])
    symlinkSync(process.execPath, join(bin, "node"));
  const { stdout: openssl } = await exec("which", ["openssl"]);
  const { stdout: ps } = await exec("which", ["ps"]);
  symlinkSync(openssl.trim(), join(controlBin, "openssl"));
  symlinkSync(ps.trim(), join(runnerBin, "ps"));
  const env = {
    ...process.env,
    HOME: control,
    PATH: controlBin,
    ARTHEGALL_CONTROL_DIR: control,
  };
  const runnerEnv = {
    ...process.env,
    HOME: runner,
    PATH: fixtures + delimiter + runnerBin,
  };
  async function command(...args) {
    const { stdout } = await exec(cli, args, { cwd: root, env, timeout: 5000 });
    return JSON.parse(stdout);
  }
  const server = service(cli, ["serve", "--port", "0"], env);
  const port = (await until(() => server.log.match(/port: (\d+)/)))[1];
  const ca = join(root, "runner-ca.crt");
  copyFileSync(join(control, "server.crt"), ca);
  const client = service(
    runnerCli,
    [
      "--dir",
      runner,
      "--name",
      "fixture",
      "--url",
      "wss://localhost:" + port + "/runner",
      "--ca",
      ca,
    ],
    runnerEnv,
  );
  const code = (
    await until(() => client.log.match(/Pairing code: ([a-f0-9]+)/))
  )[1];
  const { id } = await command("pair", code);
  await until(async () =>
    (await command("runners"))[0].harnesses.some(
      (h) => h.name === "claude" && h.status === "available",
    ),
  );
  const launchId = randomUUID();
  const launchArgs = [
    "launch",
    id,
    "claude",
    cwd,
    "Synthetic prompt",
    "--command-id",
    launchId,
  ];
  const [first, duplicate] = await Promise.all([
    command(...launchArgs),
    command(...launchArgs),
  ]);
  assert.deepEqual(duplicate, first);
  assert.equal(first.id, launchId);
  await assert.rejects(
    command("launch", id, "claude", cwd, "Different", "--command-id", launchId),
    /different input/,
  );
  assert.equal((await command("sessions")).length, 1);
  await until(() => existsSync(join(cwd, "started")));
  await until(
    async () =>
      (await command("sessions")).find((s) => s.id === first.session)
        ?.steering === "callback",
  );
  await stop(server);
  writeFileSync(join(cwd, "release"), "yes");
  const db = new DatabaseSync(join(runner, "state.sqlite"), { readOnly: true });
  try {
    await until(
      () =>
        JSON.parse(
          db
            .prepare("SELECT value FROM local_sessions WHERE id=?")
            .get(first.session).value,
        ).state === "ready",
    );
  } finally {
    db.close();
  }
  const next = service(cli, ["serve", "--port", port], env);
  await until(() => next.log.includes("Runner listener"));
  const history = await until(async () => {
    const rows = await command("history", first.session);
    return rows.some((r) => r.value?.type === "result") && rows;
  });
  assert.equal(history.filter((r) => r.value?.type === "assistant").length, 1);
  const assistant = history.find((r) => r.value?.type === "assistant");
  assert.equal(assistant.value.content[0].text, "回答🐟".repeat(30000));
  assert.equal(new Set(history.map((r) => r.seq)).size, history.length);
  assert.equal(
    (await command("commands", first.session))[0].status,
    "delivered",
  );
  assert.deepEqual(await command(...launchArgs), first);
  assert.equal((await command("sessions")).length, 1);
  const [connected] = await command("runners");
  assert.equal(connected.connectionState, "ready");
  assert.equal(
    connected.harnesses.find((h) => h.name === "claude").steering,
    "callback",
  );

  const check = await command(
    "schedule",
    "create",
    "send",
    first.session,
    "Check the previous result",
    "--in",
    "1s",
    "--zone",
    "UTC",
  );
  assert.equal(check.upcoming.length, 1);
  const [occurrence] = await until(async () => {
    const rows = await command("schedule", "history", check.id);
    return rows[0]?.status === "finished" && rows;
  });
  assert.equal(occurrence.session, first.session);
  const followup = (await command("commands", first.session)).find(
    (c) => c.id === occurrence.command,
  );
  assert.equal(followup.status, "delivered");
  assert.match(
    followup.text,
    /Scheduled for .*\[UTC\]\n\nCheck the previous result/,
  );

  // A scheduled launch becomes due while its paired runner is offline.
  await stop(client);
  await until(
    async () => (await command("runners"))[0].connectionState === "offline",
  );
  const offline = await command(
    "schedule",
    "create",
    "launch",
    id,
    "claude",
    cwd,
    "Write a fresh report",
    "--in",
    "1s",
  );
  const queued = await until(async () => {
    const [row] = await command("schedule", "history", offline.id);
    return row?.status === "queued" && row;
  });
  const reconnected = service(runnerCli, ["--dir", runner], runnerEnv);
  const finished = await until(async () => {
    const [row] = await command("schedule", "history", offline.id);
    return row?.status === "finished" && row;
  });
  assert.equal(finished.command, queued.command);
  assert.equal(finished.commandStatus, "delivered");
  assert.notEqual(finished.session, first.session);
  assert.equal((await command("commands", finished.session)).length, 1);
  await stop(reconnected);

  // A peer using the original identify envelope has no version or features.
  const keys = generateKeyPairSync("ed25519");
  const url = "wss://localhost:" + port + "/runner";
  async function identify(version) {
    const socket = new WebSocket(url, { ca: readFileSync(ca) });
    const [raw] = await once(socket, "message");
    const challenge = JSON.parse(raw);
    socket.send(
      JSON.stringify({
        op: "identify",
        name: "legacy",
        protocolVersion: version,
        publicKey: keys.publicKey.export({ type: "spki", format: "pem" }),
        signature: sign(
          null,
          Buffer.from("arthegall.runner.v1/" + challenge.nonce),
          keys.privateKey,
        ).toString("base64"),
      }),
    );
    return socket;
  }
  const older = await identify();
  t.after(() => older.terminate());
  const [offer] = await once(older, "message");
  const welcomed = once(older, "message");
  const { id: legacyId } = await command("pair", JSON.parse(offer).code);
  await welcomed;
  const status = async () =>
    (await command("runners")).find((r) => r.id === legacyId).connectionState;
  assert.equal(await status(), "catching_up");
  older.send(JSON.stringify({ op: "ready", harnesses: [] }));
  await until(async () => (await status()) === "ready");
  older.close();
  await once(older, "close");
  await until(async () => (await status()) === "offline");
  const future = await identify(2);
  const [codeMismatch, reason] = await once(future, "close");
  assert.equal(codeMismatch, 4002);
  assert.match(reason.toString(), /Update the control plane/);
  assert.equal(await status(), "incompatible");

  // In the opposite direction, run the packaged runner against the pre-parts protocol.
  const legacyServer = https.createServer({
    cert: readFileSync(ca),
    key: readFileSync(join(control, "server.key")),
  });
  const sockets = new WebSocketServer({ server: legacyServer });
  const received = [];
  sockets.on("connection", (socket) => {
    socket.send(JSON.stringify({ op: "challenge", nonce: "legacy-nonce" }));
    socket.on("message", (raw) => {
      const msg = JSON.parse(raw);
      received.push(msg);
      if (msg.op === "identify")
        socket.send(
          JSON.stringify({ op: "welcome", runner: "legacy-paired", seq: 0 }),
        );
      if (msg.op === "events")
        socket.send(JSON.stringify({ op: "ack", seq: msg.rows.at(-1).seq }));
    });
  });
  legacyServer.listen(0, "127.0.0.1");
  await once(legacyServer, "listening");
  try {
    const oldClient = service(
      runnerCli,
      [
        "--dir",
        join(root, "mixed-runner"),
        "--url",
        "wss://localhost:" + legacyServer.address().port + "/runner",
        "--ca",
        ca,
      ],
      runnerEnv,
    );
    try {
      await until(() => received.some((m) => m.op === "ready"));
    } finally {
      await stop(oldClient);
    }
    assert.ok(received.some((m) => m.op === "events"));
  } finally {
    for (const socket of sockets.clients) socket.terminate();
    sockets.close();
    legacyServer.close();
  }
});
