import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Runner } from "../packages/runner/runner.js";
import { CodexAdapter } from "../packages/runner/adapters/codex.js";
import { ClaudeAdapter } from "../packages/runner/adapters/claude.js";

function fixture(t, harness) {
  const dir = mkdtempSync(join(tmpdir(), "arthegall-steer-"));
  const runner = new Runner(dir);
  t.after(() => {
    runner.lock.close();
    runner.store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const s = {
    id: "s",
    harness,
    native: "native",
    state: "working",
    turn: "t",
    approvals: [],
  };
  runner.sessions.set(s.id, s);
  const ctx = runner.context(s);
  const adapter =
    harness === "codex" ? new CodexAdapter(ctx) : new ClaudeAdapter(ctx);
  runner.adapters.set(s.id, adapter);
  const command = {
    id: "update",
    type: "steer",
    session: s.id,
    target: s.turn,
    text: "Include the totals.",
  };
  return {
    runner,
    adapter,
    s,
    command,
    status: () => ctx.command(command.id).status,
  };
}

test("Codex uses the native turn precondition and confirms a steer only once", async (t) => {
  const { runner, adapter, s, command, status } = fixture(t, "codex");
  let calls = 0;
  adapter.call = async (method, params) => {
    calls++;
    assert.equal(method, "turn/steer");
    assert.deepEqual(params, {
      threadId: s.native,
      expectedTurnId: command.target,
      clientUserMessageId: command.id,
      input: [{ type: "text", text: command.text }],
    });
    return { turnId: s.turn };
  };
  await runner.handle(command);
  await runner.handle(command);
  assert.equal(calls, 1);
  assert.equal(status(), "delivered");
  assert.equal(s.state, "working");
  assert.equal(s.turn, "t");
});

test("Codex can reconcile an ambiguous steer from its native item on the targeted turn", async (t) => {
  const { runner, adapter, command, status } = fixture(t, "codex");
  adapter.call = async () => {
    throw Error("lost response");
  };
  await runner.handle(command);
  assert.equal(status(), "uncertain");
  const item = { id: "i", clientId: command.id, type: "userMessage" };
  adapter.recordItem("other", item);
  assert.equal(status(), "uncertain");
  adapter.recordItem(command.target, item);
  assert.equal(status(), "delivered");
});

test("stale turns and native refusals fail without starting a new turn", async (t) => {
  const { runner, adapter, s, command, status } = fixture(t, "codex");
  let calls = 0;
  adapter.call = async () => {
    calls++;
    throw Object.assign(Error("turn ended"), { refused: true });
  };
  await runner.handle(command);
  assert.equal(status(), "failed");
  s.turn = "new";
  await runner.handle({ ...command, id: "late" });
  assert.equal(runner.store.receipts.get("late").status, "failed");
  assert.equal(calls, 1);
});

function hook(event, id, extra = {}) {
  return {
    type: "control_request",
    request_id: id,
    request: {
      subtype: "hook_callback",
      callback_id: "arthegall-" + event,
      input: { session_id: "native", hook_event_name: event, ...extra },
    },
  };
}
for (const event of ["PostToolUse", "Stop"]) {
  test(
    "Claude delivers steering on the original worker at " + event,
    async (t) => {
      const { runner, adapter, command, status } = fixture(t, "claude");
      const sent = [];
      adapter.child = {};
      adapter.turn = command.target;
      adapter.send = async (m) => sent.push(m);
      await runner.handle(command);
      assert.equal(status(), "processing");
      await adapter.answerHook(hook(event, "subagent", { agent_id: "sub" }));
      assert.deepEqual(sent.at(-1).response.response, {});
      await adapter.answerHook(hook(event, "main"));
      assert.match(JSON.stringify(sent.at(-1)), /Include the totals/);
      assert.equal(status(), "processing");
      adapter.message({
        type: "control_response",
        response: { request_id: "main", subtype: "success" },
      });
      assert.equal(status(), "delivered");
      await runner.handle(command);
      await adapter.answerHook(hook(event, "again"));
      assert.deepEqual(sent.at(-1).response.response, {});
      assert.ok(sent.every((m) => m.type === "control_response"));
    },
  );
}
test("Claude expires an unsent steer and leaves an unacknowledged hook delivery uncertain", async (t) => {
  const { runner, adapter, command, status } = fixture(t, "claude");
  adapter.child = {};
  adapter.turn = command.target;
  adapter.send = async () => {};
  await runner.handle(command);
  await adapter.answerHook(hook("Stop", "main"));
  await runner.handle({ ...command, id: "late" });
  adapter.finishSteering();
  assert.equal(status(), "uncertain");
  assert.equal(runner.store.receipts.get("late").status, "failed");
});

for (const [reply, expected] of [
  ["success", "delivered"],
  ["error", "failed"],
  ["close", "uncertain"],
]) {
  test("Claude stop with " + reply + " records " + expected, async (t) => {
    const { runner, adapter, s } = fixture(t, "claude");
    adapter.child = { stdin: { end() {} } };
    let request;
    adapter.send = async (message) => {
      request = message;
    };
    const stop = { id: "stop", type: "stop", session: s.id, target: s.turn };
    const handling = runner.handle(stop);
    const respond = (id, subtype) =>
      adapter.message({
        type: "control_response",
        response: { request_id: id, subtype, error: "not accepted" },
      });
    respond("unrelated", "success");
    assert.equal(runner.store.receipts.get(stop.id).status, "processing");
    if (reply === "close") adapter.close();
    else respond(request.request_id, reply);
    await handling;
    assert.equal(runner.store.receipts.get(stop.id).status, expected);
    if (reply === "error") assert.equal(adapter.interrupting, false);
  });
}
