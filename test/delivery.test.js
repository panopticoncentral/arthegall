import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ControlStore } from "../packages/control-plane/store.js";
import { Control } from "../packages/control-plane/control.js";
import { Runner } from "../packages/runner/runner.js";

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "arthegall-test-"));
  const store = new ControlStore(dir),
    ctl = new Control(store),
    sent = new Set();
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  store.runners.put("r", {
    id: "r",
    harnesses: [{ name: "claude", status: "available" }],
  });
  const launch = ctl.action("launch", {
    runner: "r",
    harness: "claude",
    cwd: "/example",
    text: "first",
  });
  const session = launch.session;
  const ingest = (event) =>
    store.transaction(() =>
      ctl.ingest("r", {
        seq: store.sequence("r") + 1,
        event: { session, ...event },
      }),
    );
  const dispatch = () => ctl.dispatch("r", sent);
  return { ctl, store, session, launch, sent, dispatch, ingest };
}
test("orders offline input, holds later prompts behind ambiguous delivery, and lets approvals pass", (t) => {
  const { ctl, session, launch, sent, dispatch, ingest } = fixture(t);
  const a = ctl.action("send", { session, text: "second" });
  assert.deepEqual(
    dispatch().map((c) => c.id),
    [launch.id],
  );
  ingest({
    type: "session",
    state: "waiting",
    turn: "t",
    approvals: [{ id: "p" }],
  });
  ingest({ type: "receipt", command: launch.id, status: "uncertain" });
  assert.equal(dispatch().length, 0);
  const approval = ctl.action("approve", { session, request: "p" });
  assert.equal(dispatch()[0].id, approval.id);
  ingest({ type: "receipt", command: approval.id, status: "delivered" });
  ingest({ type: "session", state: "ready", turn: null, approvals: [] });
  assert.equal(dispatch().length, 0);
  ctl.reconcile("r", [{ id: launch.id, status: "delivered" }], sent);
  assert.equal(dispatch()[0].id, a.id);
});
test("end takes precedence on reconnect even if the prior dispatch never reached the machine", (t) => {
  const { ctl, session, launch, dispatch, sent } = fixture(t);
  dispatch();
  const queued = ctl.action("send", { session, text: "later" });
  const end = ctl.action("end", { session });
  ctl.reconcile("r", [{ id: launch.id, status: "missing" }], new Set());
  assert.equal(ctl.command(launch.id).status, "canceled");
  assert.equal(ctl.command(queued.id).status, "canceled");
  assert.deepEqual(
    ctl.dispatch("r", sent).map((c) => c.id),
    [end.id],
  );
  assert.throws(() => ctl.action("send", { session, text: "new" }), /closed/);
});
test("canceling an undispatched launch closes it and cancels its queued follow-up", (t) => {
  const { ctl, session, launch, dispatch } = fixture(t);
  const second = ctl.action("send", { session, text: "later" });
  ctl.action("cancel", { id: launch.id });
  assert.equal(ctl.session(session).state, "ended");
  assert.equal(ctl.command(second.id).status, "canceled");
  assert.deepEqual(dispatch(), []);
});
test("an acknowledged dispatch is not repeated when the acknowledgment was lost", (t) => {
  const { ctl, launch, dispatch, sent } = fixture(t);
  dispatch();
  sent.clear();
  assert.deepEqual(
    ctl.unresolved("r").map((c) => c.id),
    [launch.id],
  );
  ctl.reconcile("r", [{ id: launch.id, status: "delivered" }], sent);
  assert.deepEqual(dispatch(), []);
});
test("runner redelivery cannot submit input twice, and a stale stop cannot interrupt a newer turn", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "arthegall-runner-")),
    r = new Runner(dir);
  t.after(() => {
    r.lock.close();
    r.store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const s = { id: "s", state: "ready", approvals: [], turn: null };
  r.sessions.set(s.id, s);
  let delivered = 0,
    interrupts = 0;
  r.adapters.set("s", {
    input: async (c) => {
      delivered++;
      r.context(s).confirm(c.id);
      r.update(s, { turn: "new", state: "working" });
    },
    interrupt: () => interrupts++,
  });
  const c = { id: "a", type: "prompt", session: "s", text: "one" };
  await r.handle(c);
  await r.handle(c);
  await r.handle({ id: "b", session: "s", type: "stop", target: "old" });
  assert.equal(delivered, 1);
  assert.equal(interrupts, 0);
  assert.equal(r.store.receipts.get("a").status, "delivered");
  assert.equal(r.store.receipts.get("b").detail, "Turn already ended");
});

test("a queued launch can deliver its first prompt after recovery finds the native session already created", (t) => {
  const { ctl, launch, dispatch, ingest, sent } = fixture(t);
  dispatch();
  sent.clear();
  ingest({ type: "session", state: "ready", turn: null, approvals: [] });
  ctl.reconcile("r", [{ id: launch.id, status: "queued" }], sent);
  assert.equal(dispatch()[0].id, launch.id);
});

test("cancel reaching the runner before an uncertain dispatch leaves a durable tombstone", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "arthegall-cancel-")),
    r = new Runner(dir);
  t.after(() => {
    r.lock.close();
    r.store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const c = {
    id: "launch",
    session: "s",
    type: "launch",
    cwd: "/does-not-exist",
    harness: "claude",
    text: "never send",
  };
  await r.handle({
    id: "cancel",
    session: "s",
    type: "cancel",
    target: c.id,
    targetType: "launch",
  });
  await r.handle(c);
  assert.equal(r.store.receipts.get(c.id).status, "canceled");
  assert.equal(r.store.sessions.get("s").state, "ended");
  assert.equal(r.adapters.size, 0);
});

test("a steer passes queued input and its outstanding delivery leaves approvals actionable", (t) => {
  const { ctl, session, launch, ingest, dispatch } = fixture(t);
  dispatch();
  ingest({ type: "receipt", command: launch.id, status: "delivered" });
  ingest({
    type: "session",
    state: "waiting",
    turn: "turn-1",
    approvals: [{ id: "p" }],
  });
  const later = ctl.action("send", { session, text: "later" });
  assert.throws(
    () => ctl.action("steer", { session, turn: "old", text: "wrong turn" }),
    /no longer active/,
  );
  assert.throws(
    () => ctl.action("steer", { session, turn: "turn-1", text: " " }),
    /empty/,
  );
  const steer = ctl.action("steer", { session, turn: "turn-1", text: "now" });
  assert.equal(dispatch()[0].id, steer.id);
  const approval = ctl.action("approve", { session, request: "p" });
  assert.equal(dispatch()[0].id, approval.id);
  assert.equal(ctl.command(later.id).status, "queued");
});

test("a refused end keeps canceled prompts canceled and a retried end completes", async (t) => {
  const { ctl, session, launch, dispatch, ingest } = fixture(t);
  dispatch();
  ingest({ type: "receipt", command: launch.id, status: "delivered" });
  const dir = mkdtempSync(join(tmpdir(), "arthegall-end-"));
  const r = new Runner(dir);
  t.after(() => {
    r.lock.close();
    r.store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let cursor = 0;
  function replay() {
    for (const row of r.store.journalAfter(cursor, 100)) {
      ingest(JSON.parse(row.body));
      cursor = row.seq;
    }
  }
  const s = {
    id: session,
    state: "waiting",
    turn: "t",
    approvals: [{ id: "p" }],
  };
  r.sessions.set(session, s);
  r.update(s, {});
  replay();
  let attempts = 0;
  r.adapters.set(session, {
    interrupt: async () => {
      if (++attempts === 1) throw Error("interrupt refused");
      r.update(s, { state: "ready", turn: null });
    },
    close() {},
  });

  const followup = ctl.action("send", { session, text: "later" });
  const first = ctl.action("end", { session });
  await r.lane(session, () => r.handle(dispatch()[0]));
  replay();
  assert.equal(ctl.command(first.id).status, "failed");
  assert.equal(ctl.session(session).endError, "interrupt refused");
  assert.equal(ctl.session(session).closing, false);
  assert.equal(r.store.sessions.get(session).closing, null);
  assert.equal(ctl.command(followup.id).status, "canceled");
  assert.equal(
    ctl.action("approve", { session, request: "p" }).status,
    "queued",
  );
  const retry = ctl.action("end", { session });
  // A duplicate report from the previous attempt cannot reopen the new close.
  ingest({ type: "receipt", command: first.id, status: "failed" });
  assert.equal(ctl.session(session).closing, true);
  const [command] = dispatch();
  assert.equal(command.id, retry.id);
  await r.lane(session, () => r.handle(command));
  await r.lanes.get(session);
  replay();
  assert.equal(attempts, 2);
  assert.equal(ctl.command(retry.id).status, "delivered");
  assert.equal(ctl.session(session).state, "ended");
  assert.equal(ctl.command(followup.id).status, "canceled");
});

test("a reconciled uncertain close allows a retry past the original command", (t) => {
  const { ctl, session, dispatch, sent } = fixture(t);
  const first = ctl.action("end", { session });
  dispatch();
  ctl.reconcile(
    "r",
    [{ id: first.id, status: "uncertain", detail: "reply lost" }],
    sent,
  );
  const retry = ctl.action("end", { session });
  assert.equal(dispatch()[0].id, retry.id);
});

test("launch validates harness names from the selected runner's saved inventory", (t) => {
  const { ctl, store } = fixture(t);
  const args = { runner: "r", harness: "example", cwd: "/work", text: "test" };
  assert.throws(() => ctl.action("launch", args), /advertised/);
  store.runners.put("r", {
    id: "r",
    harnesses: [{ name: "example", status: "available" }],
  });
  assert.equal(ctl.action("launch", args).harness, "example");
  assert.throws(
    () => ctl.action("launch", { ...args, harness: "claude" }),
    /advertised/,
  );
});
