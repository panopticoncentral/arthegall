import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunnerStore } from "../packages/runner/store.js";
import { ControlStore } from "../packages/control-plane/store.js";

function since(store, seq) {
  return Array.from(store.journalAfter(seq, 8), (row) => ({
    seq: row.seq,
    event: JSON.parse(row.body),
  }));
}

const event = { type: "item", session: "s", item: "tool" };

function legacyDirectory(t, role, records, runner) {
  const dir = mkdtempSync(join(tmpdir(), "arthegall-upgrade-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  try {
    db.exec(`
      CREATE TABLE records (kind TEXT, id TEXT, value TEXT NOT NULL, PRIMARY KEY(kind,id));
      CREATE TABLE events (runner TEXT, seq INTEGER, session TEXT, body TEXT NOT NULL, PRIMARY KEY(runner,seq));
      CREATE INDEX session_events ON events(session,seq);
    `);
    const record = db.prepare("INSERT INTO records VALUES (?,?,?)");
    for (const [kind, id, value] of [["meta", "role", role], ...records])
      record.run(kind, id, JSON.stringify(value));
    db.prepare("INSERT INTO events VALUES (?,?,?,?)").run(
      runner,
      1,
      event.session,
      JSON.stringify(event),
    );
  } finally {
    db.close();
  }
  return dir;
}

test("runner upgrade preserves replay position, native session and delivery receipts", (t) => {
  const dir = legacyDirectory(
    t,
    "runner",
    [
      ["meta", "identity", { runner: "r" }],
      ["meta", "inventory", ["codex"]],
      ["session", "s", { native: "thread-1" }],
      ["command", "c", { status: "delivered" }],
      ["item", "s/tool", { output: "done" }],
    ],
    "local",
  );
  assert.throws(() => new ControlStore(dir), /belongs to the runner/);
  const store = new RunnerStore(dir);
  try {
    assert.deepEqual(store.settings.get("identity"), { runner: "r" });
    assert.deepEqual(store.settings.get("inventory"), ["codex"]);
    assert.equal(store.sessions.get("s").native, "thread-1");
    assert.equal(store.receipts.get("c").status, "delivered");
    assert.equal(store.items.get("s/tool").output, "done");
    assert.deepEqual(since(store, 0), [{ seq: 1, event }]);
    store.append({ type: "inventory" });
  } finally {
    store.db.close();
  }
  const reopened = new RunnerStore(dir);
  try {
    assert.equal(reopened.sequence(), 2);
    assert.deepEqual(since(reopened, 1), [
      { seq: 2, event: { type: "inventory" } },
    ]);
  } finally {
    reopened.db.close();
  }
  assert.throws(() => new ControlStore(dir), /belongs to the runner/);
});

test("control plane upgrade preserves queue order and acknowledged history", (t) => {
  const dir = legacyDirectory(
    t,
    "control plane",
    [
      ["runner", "r", { id: "r" }],
      ["session", "s", { runner: "r" }],
      ["command", "z", { id: "z", status: "dispatching" }],
      ["command", "a", { id: "a", status: "queued" }],
    ],
    "r",
  );
  assert.throws(() => new RunnerStore(dir), /belongs to the control plane/);
  const store = new ControlStore(dir);
  try {
    assert.equal(store.runners.get("r").id, "r");
    assert.equal(store.sessions.get("s").runner, "r");
    assert.deepEqual(store.commands.list(), [
      { id: "z", status: "dispatching" },
      { id: "a", status: "queued" },
    ]);
    assert.equal(store.sequence("r"), 1);
    assert.equal(store.sequence("another-runner"), 0);
    assert.deepEqual(store.history("s"), [{ seq: 1, ...event }]);
  } finally {
    store.db.close();
  }
  assert.throws(() => new RunnerStore(dir), /belongs to the control plane/);
});

test("existing sessions and launch schedules acquire one persistent project per runner and path", (t) => {
  const dir = legacyDirectory(
    t,
    "control plane",
    [
      [
        "session",
        "s",
        { id: "s", runner: "r", cwd: "/work/./", state: "ready" },
      ],
      [
        "session",
        "bad",
        { id: "bad", runner: "r", cwd: "/bad\0path", state: "failed" },
      ],
    ],
    "r",
  );
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  db.exec("CREATE TABLE schedules (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.prepare("INSERT INTO schedules VALUES (?,?)").run(
    "job",
    JSON.stringify({
      id: "job",
      target: { op: "launch", runner: "r", cwd: "/work", harness: "codex" },
    }),
  );
  db.close();
  const store = new ControlStore(dir);
  const [project] = store.projects.list();
  assert.equal(store.projects.list().length, 1);
  assert.equal(store.sessions.get("s").cwd, "/work/./");
  assert.equal(store.sessions.get("s").project, project.id);
  assert.equal(store.sessions.get("bad").state, "failed");
  assert.equal(store.sessions.get("bad").project, undefined);
  assert.deepEqual(store.schedules.get("job").target, {
    op: "launch",
    project: project.id,
    harness: "codex",
  });
  store.db.close();
  const reopened = new ControlStore(dir);
  assert.deepEqual(reopened.projects.list(), [project]);
  reopened.db.close();
});
