import { randomUUID } from "node:crypto";
import { localTime, nextDue, preview, timing } from "./calendar.js";

const turnOutcomes = new Map([
  ["completed", "finished"],
  ["failed", "failed"],
  ["interrupted", "interrupted"],
]);

const occurrenceHistory = `SELECT o.*, json_extract(c.value,'$.status') AS commandStatus
  FROM occurrences AS o LEFT JOIN commands AS c ON c.id=o.command WHERE o.schedule=?`;

export class Scheduler {
  constructor(control) {
    this.control = control;
    this.store = control.store;
    this.db = this.store.db;
  }
  get(id) {
    const schedule = this.store.schedules.get(id);
    if (!schedule) throw Error("unknown schedule");
    return schedule;
  }
  create(a, now = Date.now()) {
    const rule = timing(a, now);
    let target;
    if (a.target === "launch") {
      const project = this.control.launchProject(a);
      target = {
        op: "launch",
        project: project.id,
        harness: a.harness,
        ...(a.settings && { settings: a.settings }),
      };
    } else if (a.target === "send") {
      this.control.openSession(a.session);
      target = { op: "send", session: a.session };
    } else throw Error("schedule target must be launch or send");
    if (typeof a.text !== "string" || !a.text.trim())
      throw Error("empty prompt");
    const id = randomUUID();
    return preview(
      this.store.schedules.put(id, {
        id,
        target,
        text: a.text,
        rule,
        nextDue: nextDue(rule, now),
        status: "active",
      }),
    );
  }
  edit(a, now = Date.now()) {
    const s = this.get(a.id);
    if (s.status !== "active") throw Error("schedule is no longer active");
    const rule = timing(
      {
        ...a,
        zone: a.zone ?? s.rule.zone,
        missed: a.time === undefined ? a.missed : (a.missed ?? s.rule.missed),
      },
      now,
    );
    this.recordDue(s, now);
    if (!s.nextDue) throw Error("schedule is no longer active");
    // An edit after a backwards clock adjustment must not replay a recorded slot.
    const last = this.db
      .prepare("SELECT MAX(due) AS due FROM occurrences WHERE schedule=?")
      .get(s.id);
    const after = last.due ? Math.max(now, Date.parse(last.due)) : now;
    const next = nextDue(rule, after);
    if (!next) throw Error("choose a time after the last recorded occurrence");
    return preview(
      this.store.schedules.put(s.id, {
        ...s,
        rule,
        nextDue: next,
      }),
    );
  }
  list() {
    const last = this.db.prepare(
      `${occurrenceHistory} ORDER BY due DESC LIMIT 1`,
    );
    return this.store.schedules.list().map((s) => ({
      ...preview(s),
      lastOccurrence: last.get(s.id) ?? null,
    }));
  }
  history(id) {
    this.get(id);
    return this.db.prepare(`${occurrenceHistory} ORDER BY due`).all(id);
  }
  cancelWaiting(id, status, detail) {
    // Only commands still owned by the local queue can be withdrawn.
    const queued = this.db
      .prepare(
        "SELECT command FROM occurrences WHERE schedule=? AND status='queued' AND (?='canceled' OR missed='latest')",
      )
      .all(id, status);
    for (const row of queued) {
      this.control.cancelLocal(this.control.command(row.command));
      this.setStatus(row.command, status, detail);
    }
    this.db
      .prepare(
        "UPDATE occurrences SET status=?, detail=? WHERE schedule=? AND status='pending' AND (?='canceled' OR missed='latest')",
      )
      .run(status, detail, id, status);
  }
  cancel(id) {
    const s = this.get(id);
    this.cancelWaiting(id, "canceled", "Schedule canceled");
    return this.store.schedules.put(id, {
      ...s,
      status: "canceled",
      nextDue: null,
    });
  }
  closeSession(id) {
    for (const row of this.db
      .prepare(
        `SELECT id FROM schedules WHERE
      json_extract(value,'$.target.session')=? AND (json_extract(value,'$.status')='active'
        OR EXISTS (SELECT 1 FROM occurrences WHERE schedule=schedules.id
          AND status IN ('pending','queued','dispatching','processing','uncertain')))`,
      )
      .all(id))
      this.cancel(row.id);
  }
  setStatus(command, status, detail = null) {
    return this.db
      .prepare("UPDATE occurrences SET status=?, detail=? WHERE command=?")
      .run(status, detail, command).changes;
  }
  receipt(c, status, detail) {
    const row = this.db
      .prepare("SELECT status FROM occurrences WHERE command=?")
      .get(c.id);
    if (
      !row ||
      ["finished", "failed", "skipped", "canceled", "interrupted"].includes(
        row.status,
      )
    )
      return;
    if (
      status === "delivered" &&
      ["running", "confirming", "unconfirmed"].includes(row.status)
    )
      return;
    this.setStatus(c.id, status, detail);
    // A late receipt can follow a replayed transition back to idle.
    if (status === "delivered") {
      const s = this.control.session(c.session);
      if (
        s.scheduleCommand === c.id &&
        ["ready", "failed", "ended"].includes(s.state)
      )
        this.observe(s, { type: "session", state: s.state, detail: s.detail });
    }
  }
  requeued(c) {
    const row = this.db
      .prepare("SELECT schedule,due,missed FROM occurrences WHERE command=?")
      .get(c.id);
    if (!row) return;
    const s = this.get(row.schedule);
    const superseded =
      row.missed === "latest" &&
      this.db
        .prepare(
          "SELECT 1 FROM occurrences WHERE schedule=? AND due>? AND missed='latest' LIMIT 1",
        )
        .get(s.id, row.due);
    if (s.status === "canceled" || superseded) {
      this.control.cancelLocal(c);
      if (superseded)
        this.setStatus(c.id, "skipped", "Superseded by a newer occurrence");
    }
  }
  // Use the runner's turn/result evidence. Acceptance of a prompt alone
  // cannot establish that its work finished, especially across recovery.
  observe(s, e) {
    if (e.type === "item" && e.value?.type === "turn") {
      const status = turnOutcomes.get(e.value.status);
      if (status)
        this.db
          .prepare(
            "UPDATE occurrences SET status=?,detail=? WHERE session=? AND turn=?",
          )
          .run(status, e.value.error?.message ?? null, s.id, e.value.turn);
      return;
    }
    if (!s.scheduleCommand) return;
    // Claude emits its result subtype, then a session update with the
    // provider's is_error detail. Both belong to the same worker turn.
    if (
      e.type === "session" &&
      e.turn === s.scheduleCommand &&
      ["working", "waiting"].includes(e.state) &&
      e.detail !== undefined
    ) {
      this.db
        .prepare(
          "UPDATE occurrences SET status=?,detail=? WHERE command=? AND status='confirming'",
        )
        .run(
          e.detail === null ? "finished" : "failed",
          e.detail,
          s.scheduleCommand,
        );
    }
    if (
      e.type === "session" &&
      e.turn &&
      ["working", "waiting"].includes(e.state) &&
      (s.state === "submitting" || e.turn === s.scheduleCommand)
    ) {
      this.db
        .prepare(
          `UPDATE occurrences SET status='running',turn=? WHERE command=?
        AND status IN ('dispatching','delivered','running')`,
        )
        .run(e.turn, s.scheduleCommand);
    } else if (
      e.type === "item" &&
      e.value?.type === "result" &&
      s.turn === s.scheduleCommand
    ) {
      this.setStatus(
        s.scheduleCommand,
        e.value.status === "success" ? "confirming" : "failed",
        e.value.status === "success"
          ? null
          : (e.value.text ?? e.value.status ?? "Harness error"),
      );
    } else if (
      e.type === "session" &&
      ["ready", "failed", "ended"].includes(e.state)
    ) {
      this.db
        .prepare(
          `UPDATE occurrences SET status=?,detail=? WHERE command=?
        AND status IN ('delivered','running','confirming')`,
        )
        .run(
          e.state === "failed" ? "failed" : "unconfirmed",
          e.detail ?? "No terminal turn result was observed",
          s.scheduleCommand,
        );
    }
  }
  recordDue(s, now, limit = Infinity) {
    if (!s.nextDue || Date.parse(s.nextDue) > now) return;
    const latest = s.rule.missed === "latest";
    if (latest)
      this.cancelWaiting(s.id, "skipped", "Superseded by a newer occurrence");
    // Bound each transaction after extended downtime. A latest-only slot
    // stays skipped until we reach the actual last due time.
    for (
      let count = 0;
      s.nextDue && Date.parse(s.nextDue) <= now && count < limit;
      count++
    ) {
      const slot = s.nextDue;
      s.nextDue = nextDue(s.rule, Date.parse(slot));
      const skip = latest && s.nextDue && Date.parse(s.nextDue) <= now;
      this.db
        .prepare(
          "INSERT INTO occurrences(schedule,due,zone,missed,status,detail) VALUES (?,?,?,?,?,?)",
        )
        .run(
          s.id,
          slot,
          s.rule.zone,
          s.rule.missed ?? null,
          skip ? "skipped" : "pending",
          skip ? "Superseded by a newer occurrence" : null,
        );
    }
    if (!s.nextDue) s.status = "elapsed";
    this.store.schedules.put(s.id, s);
  }
  // The cursor, skipped slots, and pending occurrences commit together.
  advance(now) {
    const due = this.db
      .prepare(
        "SELECT id FROM schedules WHERE json_extract(value,'$.nextDue') <= ?",
      )
      .all(new Date(now).toISOString());
    for (const { id } of due)
      this.store.transaction(() => {
        const s = this.get(id);
        this.recordDue(s, now, 128);
      });
    // Submit one occurrence per schedule at a time. Other schedules and
    // unrelated interactive sessions can progress while a runner is busy.
    const waiting = this.db
      .prepare(
        `SELECT schedule, zone, MIN(due) AS due FROM occurrences
      WHERE status='pending' AND schedule NOT IN (
        SELECT schedule FROM occurrences WHERE status IN
        ('queued','dispatching','processing','delivered','running','confirming','uncertain')
        UNION ALL SELECT o.schedule FROM commands c JOIN occurrences o ON o.command=c.id
          WHERE json_extract(c.value,'$.status')='uncertain'
      ) GROUP BY schedule`,
      )
      .all();
    const runners = new Set();
    for (const { schedule, zone, due } of waiting)
      this.store.transaction(() => {
        const s = this.get(schedule);
        const detail = localTime(due, zone) + " [" + zone + "]";
        const text = "Scheduled for " + detail + "\n\n" + s.text;
        let c;
        try {
          c = this.control.apply(s.target.op, { ...s.target, text });
        } catch (err) {
          if (err.code !== "INVALID_ACTION") throw err;
          this.db
            .prepare(
              "UPDATE occurrences SET status='failed',detail=? WHERE schedule=? AND due=?",
            )
            .run(err.message, schedule, due);
          return;
        }
        this.db
          .prepare(
            "UPDATE occurrences SET status='queued', command=?, session=? WHERE schedule=? AND due=?",
          )
          .run(c.id, c.session, schedule, due);
        runners.add(c.runner);
      });
    return runners;
  }
}
