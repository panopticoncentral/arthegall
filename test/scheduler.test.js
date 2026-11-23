import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ControlStore } from "../packages/control-plane/store.js";
import { Control } from "../packages/control-plane/control.js";
import {
  timing,
  nextDue,
  preview,
} from "../packages/control-plane/calendar.js";

const monday = Date.parse("2026-11-23T16:00:00Z"); // 08:00 Pacific
const day = 86400000;
const weekly = { time: "08:00", days: "weekdays", zone: "America/Los_Angeles" };
const launch = {
  target: "launch",
  runner: "r",
  harness: "codex",
  cwd: "/work",
  text: "Report",
};

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "arthegall-schedule-"));
  let store = new ControlStore(dir);
  let control = new Control(store);
  store.runners.put("r", { id: "r", harnesses: [{ name: "codex" }] });
  store.sessions.put("s", {
    id: "s",
    runner: "r",
    state: "working",
    turn: "manual",
    harness: "codex",
  });
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return {
    get control() {
      return control;
    },
    create(args) {
      return store.transaction(() =>
        control.scheduler.create(args, monday - 1000),
      );
    },
    restart() {
      store.db.close();
      store = new ControlStore(dir);
      control = new Control(store);
    },
    tick(now) {
      control.scheduler.advance(now);
    },
    history(id) {
      return control.scheduler.history(id);
    },
    dispatch() {
      return control.dispatch("r", new Set());
    },
    event(session, e) {
      store.transaction(() =>
        control.ingest("r", {
          seq: store.sequence("r") + 1,
          event: { session, ...e },
        }),
      );
    },
  };
}

test("wall-clock previews select days, resolve both DST changes, and retain local time", () => {
  function times(o, from) {
    const now = Date.parse(from);
    const rule = timing({ zone: weekly.zone, ...o }, now);
    return preview({ rule, nextDue: nextDue(rule, now) }).upcoming;
  }
  assert.deepEqual(times({ time: "02:30" }, "2026-03-07T22:00Z"), [
    "2026-03-08T03:30:00-07:00",
    "2026-03-09T02:30:00-07:00",
    "2026-03-10T02:30:00-07:00",
  ]);
  assert.deepEqual(
    times({ time: "01:30", days: "sun,tue" }, "2026-10-31T22:00Z"),
    [
      "2026-11-01T01:30:00-07:00",
      "2026-11-03T01:30:00-08:00",
      "2026-11-08T01:30:00-08:00",
    ],
  );
  assert.match(times({ time: "01:30" }, "2026-11-01T09:00Z")[0], /^2026-11-02/);
  assert.match(times(weekly, "2026-11-28T00:00Z")[0], /^2026-11-30T08:00/);
  assert.equal(
    timing({ in: "5m" }, monday).at,
    new Date(monday + 300000).toISOString(),
  );
  assert.equal(
    timing({ at: "2026-11-24T08:00-08:00" }, monday).at,
    new Date(monday + day).toISOString(),
  );
  for (const o of [
    { at: "2026-11-24T08:00" },
    { at: "2027-01-01T08:00+99:99" },
    { at: "9999-12-31T23:59-08:00" },
    { time: "24:15" },
    { in: "-5s" },
    { in: "1m", time: "08:30" },
    { in: "2s", missed: "backfill" },
    { time: "10:00", days: "" },
    { time: "08:00", zone: "bad-zone" },
    { time: "08:00", missed: "sometimes" },
  ])
    assert.throws(() => timing(o, monday));
});

for (const missed of ["latest", "backfill"]) {
  test(
    missed +
      " across restart and offline delivery preserves intended dates and command identity",
    (t) => {
      const f = fixture(t);
      const s = f.create({ ...launch, ...weekly, missed });
      f.tick(monday);
      const [first] = f.history(s.id);
      f.restart();
      f.tick(monday + 2 * day);
      f.tick(monday + 2 * day);
      assert.deepEqual(
        f.history(s.id).map((r) => r.status),
        missed === "latest"
          ? ["skipped", "skipped", "queued"]
          : ["queued", "pending", "pending"],
      );
      const slots = missed === "latest" ? [2] : [0, 1, 2];
      for (const i of slots) {
        const [c] = f.dispatch();
        const row = f.history(s.id)[i];
        assert.equal(c.id, row.command);
        assert.equal(c.session, row.session);
        assert.equal(row.due, new Date(monday + i * day).toISOString());
        assert.ok(
          c.text.includes(
            "2026-11-" + (23 + i) + "T08:00:00-08:00 [America/Los_Angeles]",
          ),
        );
        f.event(c.session, { type: "session", state: "submitting" });
        f.event(c.session, {
          type: "receipt",
          command: c.id,
          status: "delivered",
        });
        assert.equal(f.history(s.id)[i].status, "delivered");
        f.event(c.session, { type: "session", state: "working", turn: "t" });
        f.event(c.session, {
          type: "item",
          item: "turn/t",
          value: { type: "turn", turn: "t", status: "completed" },
        });
        f.event(c.session, { type: "session", state: "ready", turn: null });
        f.tick(monday + 2 * day);
      }
      assert.equal(f.history(s.id)[0].command, first.command);
      assert.equal(f.history(s.id).at(-1).status, "finished");
      assert.deepEqual(f.dispatch(), []);
    },
  );

  test(
    missed +
      " handles a busy session and ends future follow-ups with that session",
    (t) => {
      const f = fixture(t);
      const s = f.create({
        target: "send",
        session: "s",
        text: "Check",
        ...weekly,
        missed,
      });
      f.tick(monday);
      assert.deepEqual(f.dispatch(), []);
      f.tick(monday + day);
      assert.deepEqual(f.dispatch(), []);
      f.event("s", { type: "session", state: "ready" });
      const [c] = f.dispatch();
      assert.match(c.text, missed === "latest" ? /2026-11-24/ : /2026-11-23/);
      f.tick(monday + 2 * day);
      assert.equal(
        f.history(s.id).find((r) => r.command === c.id).status,
        "dispatching",
      );
      f.control.action("end", { session: "s" });
      assert.equal(f.control.scheduler.get(s.id).status, "canceled");
      f.tick(monday + 3 * day);
      assert.equal(f.history(s.id).length, 3);
      assert.equal(f.history(s.id).at(-1).status, "canceled");
    },
  );
}

test("a missing dispatch is superseded only after runner reconciliation", (t) => {
  const f = fixture(t);
  const s = f.create({ ...launch, ...weekly });
  f.tick(monday);
  const [c] = f.dispatch();
  f.tick(monday + day);
  assert.deepEqual(
    f.history(s.id).map((r) => r.status),
    ["dispatching", "pending"],
  );
  f.restart();
  f.control.reconcile("r", [{ id: c.id, status: "missing" }], new Set());
  f.tick(monday + day);
  assert.deepEqual(
    f.history(s.id).map((r) => r.status),
    ["skipped", "queued"],
  );
  assert.equal(f.control.command(c.id).status, "canceled");
});

test("one-off recovery, retries, calendar edits and cancellation retain history", (t) => {
  const f = fixture(t);
  const action = { ...launch, in: "5m", commandId: randomUUID() };
  const s = f.control.action("schedule-create", action);
  f.restart();
  assert.deepEqual(f.control.action("schedule-create", action), s);
  const edited = f.control.action("schedule-edit", {
    id: s.id,
    in: "10m",
    zone: "UTC",
  });
  assert.ok(edited.nextDue > s.nextDue);
  f.tick(Date.parse(edited.nextDue) + day);
  f.restart();
  f.tick(Date.parse(edited.nextDue) + 2 * day);
  const [occurrence] = f.history(s.id);
  assert.equal(occurrence.due, edited.nextDue);
  assert.equal(
    f.control.scheduler.list()[0].lastOccurrence.command,
    occurrence.command,
  );
  f.control.action("schedule-cancel", { id: s.id });
  assert.equal(f.control.command(occurrence.command).status, "canceled");
  assert.deepEqual(f.dispatch(), []);
});

test("a failed turn keeps its error after session recovery and releases the next backfill slot", (t) => {
  const f = fixture(t);
  const s = f.create({ ...launch, ...weekly, missed: "backfill" });
  f.tick(monday + day);
  const [c] = f.dispatch();
  f.event(c.session, { type: "session", state: "submitting" });
  f.event(c.session, { type: "receipt", command: c.id, status: "delivered" });
  f.event(c.session, {
    type: "session",
    state: "working",
    turn: "failed-turn",
  });
  f.restart();
  f.event(c.session, {
    type: "item",
    item: "turn/failed-turn",
    value: {
      type: "turn",
      turn: "failed-turn",
      status: "failed",
      error: { message: "Model unavailable" },
    },
  });
  f.event(c.session, { type: "session", state: "ready" });
  f.tick(monday + day);
  const [failed, queued] = f.history(s.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.commandStatus, "delivered");
  assert.equal(failed.detail, "Model unavailable");
  assert.equal(queued.status, "queued");
});

test("canceling a schedule withdraws a dispatch only after the runner confirms it was missing", (t) => {
  const f = fixture(t);
  const s = f.create({ ...launch, ...weekly });
  f.tick(monday);
  const [c] = f.dispatch();
  f.control.action("schedule-cancel", { id: s.id });
  assert.equal(f.history(s.id)[0].status, "dispatching");
  f.restart();
  f.control.reconcile("r", [{ id: c.id, status: "missing" }], new Set());
  assert.equal(f.history(s.id)[0].status, "canceled");
  assert.deepEqual(f.dispatch(), []);
});

test("a late delivery receipt releases backfill without inventing a successful turn", (t) => {
  const f = fixture(t);
  const s = f.create({ ...launch, ...weekly, missed: "backfill" });
  f.tick(monday + day);
  const [c] = f.dispatch();
  f.event(c.session, { type: "session", state: "recovering" });
  f.event(c.session, { type: "session", state: "ready" });
  f.event(c.session, { type: "receipt", command: c.id, status: "delivered" });
  f.tick(monday + day);
  assert.deepEqual(
    f.history(s.id).map((row) => row.status),
    ["unconfirmed", "queued"],
  );
});

test("editing a report schedule retains all due backfill even when future checks use latest", (t) => {
  const f = fixture(t);
  const s = f.create({ ...launch, ...weekly, missed: "backfill" });
  f.tick(monday);
  const editTime = monday + 2 * day + 60_000;
  f.control.store.transaction(() =>
    f.control.scheduler.edit(
      { id: s.id, ...weekly, missed: "latest" },
      editTime,
    ),
  );
  f.restart();
  f.tick(monday + 4 * day);
  assert.deepEqual(
    f.history(s.id).map((row) => row.status),
    ["queued", "pending", "pending", "skipped", "pending"],
  );
  assert.equal(f.dispatch()[0].id, f.history(s.id)[0].command);
});

test("ending a session preserves an already completed one-off schedule", (t) => {
  const f = fixture(t);
  const s = f.create({ target: "send", session: "s", text: "Check", in: "1s" });
  f.event("s", { type: "session", state: "ready" });
  f.tick(monday);
  const [c] = f.dispatch();
  f.event("s", { type: "session", state: "submitting" });
  f.event("s", { type: "receipt", command: c.id, status: "delivered" });
  f.event("s", { type: "session", state: "working", turn: "t" });
  f.event("s", {
    type: "item",
    item: "turn/t",
    value: { type: "turn", turn: "t", status: "completed" },
  });
  f.event("s", { type: "session", state: "ready" });
  f.control.action("end", { session: "s" });
  assert.equal(f.history(s.id)[0].status, "finished");
  assert.equal(f.control.scheduler.get(s.id).status, "elapsed");
});

test("a Claude result with an error detail cannot release backfill while delivery is uncertain", (t) => {
  const f = fixture(t);
  f.control.store.runners.put("r", {
    id: "r",
    harnesses: [{ name: "claude" }],
  });
  const s = f.create({
    ...launch,
    harness: "claude",
    ...weekly,
    missed: "backfill",
  });
  f.tick(monday + day);
  const [c] = f.dispatch();
  f.event(c.session, { type: "session", state: "working", turn: c.id });
  f.event(c.session, { type: "receipt", command: c.id, status: "uncertain" });
  f.event(c.session, {
    type: "item",
    item: "result",
    value: { type: "result", status: "success" },
  });
  f.restart();
  f.event(c.session, {
    type: "session",
    state: "working",
    turn: c.id,
    detail: "Provider failed",
  });
  f.event(c.session, { type: "session", state: "ready", turn: null });
  f.tick(monday + day);
  const [first, second] = f.history(s.id);
  assert.equal(first.status, "failed");
  assert.equal(first.detail, "Provider failed");
  assert.equal(first.commandStatus, "uncertain");
  assert.equal(second.status, "pending");
  assert.deepEqual(f.dispatch(), []);
  f.control.reconcile("r", [{ id: c.id, status: "delivered" }], new Set());
  f.tick(monday + day);
  assert.deepEqual(
    f.history(s.id).map((row) => row.status),
    ["failed", "queued"],
  );
});

test("upgrading an existing scheduler preserves queued commands and backfill on an edit after clock rollback", (t) => {
  const f = fixture(t);
  const s = f.create({ ...launch, ...weekly, missed: "backfill" });
  f.tick(monday + day);
  const original = f.history(s.id);
  f.control.store.db.exec("ALTER TABLE occurrences DROP COLUMN missed");
  f.restart();
  assert.deepEqual(f.history(s.id), original);
  f.control.store.transaction(() =>
    f.control.scheduler.edit(
      { id: s.id, ...weekly, missed: "latest" },
      monday - 1000,
    ),
  );
  f.tick(monday + 2 * day);
  const rows = f.history(s.id);
  assert.deepEqual(rows.slice(0, 2), original);
  assert.equal(rows[2].due, new Date(monday + 2 * day).toISOString());
});

test("project identity, snapshots and scheduled launches survive edits and restart", (t) => {
  const f = fixture(t);
  const act = (op, args) => f.control.action(op, args);
  const definition = {
    runner: "r",
    name: "Example",
    cwd: "/work/server/./",
    additionalDirs: ["/work/client", "/work/lib/", "/work/lib", "/work/server"],
  };
  const p = act("project-add", definition);
  assert.deepEqual(p.additionalDirs, ["/work/client", "/work/lib"]);
  assert.equal(p.cwd, "/work/server");
  assert.deepEqual(
    act("project-add", { ...definition, name: "Other", cwd: p.cwd }),
    p,
  );
  assert.throws(
    () => act("project-add", { ...definition, additionalDirs: ["relative"] }),
    /absolute/,
  );
  const other = act("project-add", { ...definition, cwd: "/work/other" });
  assert.throws(
    () => act("project-edit", { ...definition, id: other.id }),
    /another project/,
  );
  f.control.store.runners.put("r2", { id: "r2", harnesses: [] });
  assert.notEqual(act("project-add", { ...definition, runner: "r2" }).id, p.id);

  const args = { project: p.id, harness: "codex", text: "first" };
  const first = act("launch", args);
  assert.deepEqual(f.control.dispatch("r", new Set(), false), []);
  assert.match(f.control.command(first.id).detail, /Update the runner/);
  const schedule = f.create({ ...args, target: "launch", ...weekly });
  const updated = act("project-edit", {
    id: p.id,
    name: "Renamed",
    cwd: "/new",
    additionalDirs: ["/lib2"],
  });
  f.restart();
  assert.deepEqual(f.control.store.projects.get(p.id), updated);
  assert.equal(f.control.session(first.session).cwd, p.cwd);
  assert.deepEqual(
    f.control.session(first.session).additionalDirs,
    p.additionalDirs,
  );
  assert.deepEqual(f.dispatch()[0].additionalDirs, p.additionalDirs);
  f.tick(monday);
  const [row] = f.history(schedule.id);
  assert.equal(f.control.command(row.command).project, p.id);
  assert.equal(f.control.command(row.command).cwd, "/new");
  assert.deepEqual(f.control.command(row.command).additionalDirs, ["/lib2"]);

  act("project-archive", { id: p.id });
  assert.throws(() => act("launch", args), /archived/);
  assert.equal(
    act("send", { session: first.session, text: "more" }).session,
    first.session,
  );
  f.tick(monday + day);
  const archived = f.history(schedule.id).at(-1);
  assert.equal(archived.status, "failed");
  assert.equal(archived.detail, "project is archived");
  assert.deepEqual(act("project-add", { ...definition, cwd: "/new" }), updated);
  f.tick(monday + 2 * day);
  assert.equal(f.history(schedule.id).at(-1).status, "queued");
});

test("follow-ups on a multi-directory session wait through a runner downgrade", (t) => {
  const f = fixture(t);
  const project = f.control.action("project-add", {
    runner: "r",
    name: "Example",
    cwd: "/work",
    additionalDirs: ["/shared"],
  });
  const first = f.control.action("launch", {
    project: project.id,
    harness: "codex",
    text: "start",
  });
  f.dispatch();
  f.event(first.session, {
    type: "receipt",
    command: first.id,
    status: "delivered",
  });
  f.event(first.session, { type: "session", state: "ready" });
  const next = f.control.action("send", {
    session: first.session,
    text: "continue",
  });
  assert.deepEqual(f.control.dispatch("r", new Set(), false), []);
  assert.equal(f.control.command(next.id).status, "queued");
  assert.equal(f.dispatch()[0].id, next.id);
});
