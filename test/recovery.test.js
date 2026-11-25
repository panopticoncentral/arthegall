import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Control } from "../packages/control-plane/control.js";
import { ControlStore } from "../packages/control-plane/store.js";
import { Runner } from "../packages/runner/runner.js";
import { CodexAdapter } from "../packages/runner/adapters/codex.js";

const fixtures = fileURLToPath(new URL("./fixtures/", import.meta.url));
function setup(t, harness) {
  const dir = mkdtempSync(join(tmpdir(), "arthegall-transcript-"));
  const store = new ControlStore(join(dir, "control"));
  store.runners.put("r", {
    id: "r",
    harnesses: [{ name: harness, status: "available" }],
  });
  const ctl = new Control(store);
  const launch = ctl.action("launch", {
    runner: "r",
    cwd: dir,
    harness,
    text: "first",
  });
  const runnerDir = join(dir, "runner");
  let runner = new Runner(runnerDir);
  function close() {
    for (const timer of runner.retryTimers.values()) clearTimeout(timer);
    runner.lock.close();
    runner.store.db.close();
  }
  t.after(() => {
    close();
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const sent = new Set();
  let cursor = 0;
  return {
    ctl,
    store,
    launch,
    dir,
    get runner() {
      return runner;
    },
    restart() {
      close();
      runner = new Runner(runnerDir);
      return runner;
    },
    dispatch() {
      return ctl.dispatch("r", sent);
    },
    sync() {
      for (const { seq, body } of runner.store.journalAfter(cursor, 1000)) {
        const event = JSON.parse(body);
        store.transaction(() => ctl.ingest("r", { seq, event }));
        if (event.type === "receipt") sent.delete(event.command);
        cursor = seq;
      }
    },
  };
}

test("Codex restart replays the tool item and pending approval before releasing the queued prompt", async (t) => {
  const f = setup(t, "codex"),
    s = f.launch.session;
  const [first] = f.dispatch();
  const session = {
    id: s,
    native: "thread",
    harness: "codex",
    state: "waiting",
    turn: "turn",
    approvals: [{ id: "tool" }],
  };
  f.runner.sessions.set(s, session);
  f.runner.update(session, {});
  f.runner.receipt(first, "delivered");
  f.sync();
  const next = f.ctl.action("send", { session: s, text: "next" });
  const runner = f.restart();
  const frames = JSON.parse(
    readFileSync(join(fixtures, "codex-approval.json"), "utf8"),
  );
  const ws = new EventEmitter();
  ws.send = (raw) => {
    const m = JSON.parse(raw);
    if (m.method === "initialized") return;
    const replies = m.method ? frames[m.method] : frames.approvalReply;
    if (!m.method)
      assert.deepEqual(m, { id: 17, result: { decision: "accept" } });
    for (const reply of replies)
      queueMicrotask(() =>
        ws.emit(
          "message",
          JSON.stringify(reply.result ? { ...reply, id: m.id } : reply),
        ),
      );
  };
  runner.harnesses.set("codex", {
    create: (ctx) => new CodexAdapter(ctx, { open: async () => ws }),
  });
  runner.boot();
  await runner.lanes.get(s);
  f.sync();
  assert.equal(f.ctl.command(first.id).status, "delivered");
  assert.deepEqual(f.dispatch(), []);
  assert.equal(f.ctl.session(s).steering, "native");
  assert.equal(f.ctl.session(s).approvals[0].id, "tool");
  assert.equal(
    f.store.history(s).filter((r) => r.value?.type === "commandExecution")
      .length,
    1,
  );
  const approve = f.ctl.action("approve", { session: s, request: "tool" });
  await runner.handle(f.dispatch()[0]);
  f.sync();
  assert.equal(f.ctl.command(approve.id).status, "delivered");
  assert.equal(f.dispatch()[0].id, next.id);
});

test("Claude worker exit leaves stop uncertain across restart and the next prompt eligible", async (t) => {
  const f = setup(t, "claude"),
    s = f.launch.session;
  const env = {
    PATH: fixtures + delimiter + process.env.PATH,
    CLAUDE_CONFIG_DIR: f.dir,
    FIXTURE_CLAUDE_INTERRUPT: join(fixtures, "claude-interrupt.json"),
  };
  for (const [name, value] of Object.entries(env)) {
    const old = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (old === undefined) delete process.env[name];
      else process.env[name] = old;
    });
  }
  await f.runner.handle(f.dispatch()[0]);
  const child = f.runner.adapters.get(s).child;
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  for (
    let i = 0;
    i < 100 &&
    !f.runner.store.items.get(s + "/00000000-0000-4000-8000-000000000001");
    i++
  )
    await delay(20);
  assert.ok(
    f.runner.store.items.get(s + "/00000000-0000-4000-8000-000000000001"),
    "Claude fixture did not acknowledge the first turn",
  );
  f.sync();
  const next = f.ctl.action("send", { session: s, text: "next" });
  const stop = f.ctl.action("stop", { session: s, turn: f.launch.id });
  const closed = once(child, "close");
  await f.runner.handle(f.dispatch()[0]);
  await closed;
  const runner = f.restart();
  runner.boot();
  await runner.lanes.get(s);
  f.sync();
  assert.equal(f.ctl.command(stop.id).status, "uncertain");
  assert.equal(f.ctl.command(f.launch.id).status, "delivered");
  assert.ok(
    f.store
      .history(s)
      .some(
        (row) =>
          row.value?.content?.[0]?.text === "Working on the first prompt.",
      ),
  );
  assert.equal(f.dispatch()[0].id, next.id);
});

test("Codex receives the session workspace on start and resume", async () => {
  const s = { cwd: "/server", additionalDirs: ["/client", "/shared"] };
  const roots = [s.cwd, ...s.additionalDirs];
  const adapter = new CodexAdapter({
    s,
    update: (patch) => Object.assign(s, patch),
  });
  adapter.connect = async () => {};
  const methods = [];
  adapter.call = async (method, params) => {
    methods.push(method);
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    assert.equal(params.cwd, s.cwd);
    assert.deepEqual(params.runtimeWorkspaceRoots, roots);
    if (method === "thread/resume") assert.equal(params.threadId, "native");
    return {
      thread: { id: "native", status: { type: "idle" } },
      runtimeWorkspaceRoots: roots,
    };
  };
  await adapter.create();
  await adapter.recover();
  assert.deepEqual(methods, [
    "thread/start",
    "thread/resume",
    "thread/turns/list",
  ]);
  adapter.call = async () => ({ thread: { id: "unsupported" } });
  await assert.rejects(adapter.create(), /did not accept/);
});

test("Codex reapplies saved session choices on resume and effort on each turn", async () => {
  const settings = {
    model: "example",
    effort: "high",
    approvalPolicy: "untrusted",
    approvalsReviewer: "auto_review",
  };
  const s = { cwd: "/work", settings, agent: { prompt: "Review." } };
  const adapter = new CodexAdapter({
    s,
    update: (patch) => Object.assign(s, patch),
    confirm() {},
  });
  adapter.connect = async () => {};
  const methods = [];
  adapter.call = async (method, params) => {
    methods.push(method);
    if (method === "config/read")
      return { config: { developer_instructions: "Standing rules." } };
    if (method === "thread/turns/list") return { data: [], nextCursor: null };
    if (method === "turn/start") {
      assert.equal(params.effort, settings.effort);
      return { turn: { status: "completed" } };
    }
    assert.equal(params.developerInstructions, "Standing rules.\n\nReview.");
    for (const key of ["model", "approvalPolicy", "approvalsReviewer"])
      assert.equal(params[key], settings[key]);
    if (method === "thread/start")
      assert.equal(params.sandbox, "workspace-write");
    return { ...params, thread: { id: "native", status: { type: "idle" } } };
  };
  await adapter.create();
  await adapter.input({ id: "first", text: "Start" });
  await adapter.recover();
  await adapter.input({ id: "next", text: "Continue" });
  assert.deepEqual(methods, [
    "config/read",
    "thread/start",
    "turn/start",
    "config/read",
    "thread/resume",
    "thread/turns/list",
    "turn/start",
  ]);
  adapter.call = async () => ({
    config: {},
    thread: { id: "native" },
    approvalPolicy: "never",
  });
  await assert.rejects(
    adapter.create(),
    /did not accept the requested approval/,
  );
});
