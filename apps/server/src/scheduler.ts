/// <reference lib="esnext.temporal" />
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { zone } from '../../../packages/contracts/src/reporting.js';
import { Conflict, type Reporting } from './reporting.js';

// Temporal's compatible disambiguation chooses the earlier repeated time and
// shifts a nonexistent time forward by the size of the spring gap.
export function dueAt(date: Temporal.PlainDate, time: string) {
  return date.toZonedDateTime({ timeZone: zone, plainTime: time }).epochMilliseconds;
}

type Schedule = { id: string; assignment_id: string; runner_id: string; time: string; backfill: number; state: string; next_date: string };
export class Scheduler {
  constructor(private db: Database.Database, private reporting: Reporting, private now: () => Date) {}

  propose(assignment: string, runner: string, time: string, backfill: boolean, source: string | { sessionId: string }) {
    const proposals = this.db.prepare("SELECT * FROM report_schedules WHERE assignment_id=? AND state IN ('pending','active')").all(assignment) as Schedule[];
    const matching = proposals.find(s => s.time === time && Boolean(s.backfill) === backfill && s.runner_id === runner);
    if (matching?.state === 'pending') return false;
    this.db.prepare("UPDATE report_schedules SET state='retired' WHERE assignment_id=? AND state='pending'").run(assignment);
    if (matching) return true;
    const id = randomUUID();
    this.db.prepare(`INSERT INTO report_schedules(id,assignment_id,runner_id,time,backfill,source_run,proposed_by,state)
      VALUES (?,?,?,?,?,?,?,'pending')`).run(id, assignment, runner, time, Number(backfill),
        typeof source === 'string' ? source : null, typeof source === 'string' ? null : source.sessionId);
    this.reporting.event('schedule_proposed', { id, assignment, runner, time, backfill, source });
    return false;
  }

  decide(id: string, session: string, allow: boolean) {
    this.db.transaction(() => {
      const schedule = this.db.prepare('SELECT * FROM report_schedules WHERE id=?').get(id) as Schedule | undefined;
      if (!schedule) throw new Conflict('Unknown schedule');
      const state = allow ? 'active' : 'declined';
      if (schedule.state === state) return;
      if (schedule.state !== 'pending') throw new Conflict('Schedule proposal is no longer pending');
      const now = this.now().getTime();
      let date = Temporal.Instant.fromEpochMilliseconds(now).toZonedDateTimeISO(zone).toPlainDate();
      if (dueAt(date, schedule.time) < now) date = date.add({ days: 1 });
      if (allow) this.db.prepare("UPDATE report_schedules SET state='retired' WHERE assignment_id=? AND state='active'").run(schedule.assignment_id);
      this.db.prepare('UPDATE report_schedules SET state=?,session_id=?,next_date=?,next_due=? WHERE id=?')
        .run(state, session, date.toString(), dueAt(date, schedule.time), id);
      this.reporting.event('schedule_decided', { id, state, session });
    })();
  }

  // Called inside nextDispatch's transaction when a connected runner can take work.
  // A null run is a recorded skip. Backfill yields one dispatch at a time.
  materialize(runner: string, enqueue: (conversation: string, period: string) => string) {
    const now = this.now().getTime();
    const schedule = this.db.prepare(`SELECT s.*, a.conversation_id FROM report_schedules s JOIN assignments a ON a.id=s.assignment_id
      WHERE state='active' AND runner_id=? AND next_due<=? ORDER BY next_due LIMIT 1`).get(runner, now) as Schedule & { conversation_id: string } | undefined;
    if (!schedule) return;
    let date = Temporal.PlainDate.from(schedule.next_date);
    let due = dueAt(date, schedule.time);
    while (due <= now) {
      const next = date.add({ days: 1 }), nextDue = dueAt(next, schedule.time);
      const period = date.subtract({ days: 1 }).toString();
      const exists = this.db.prepare('SELECT 1 FROM report_occurrences WHERE assignment_id=? AND due_date=?').get(schedule.assignment_id, date.toString());
      if (!exists) {
        const shouldRun = Boolean(schedule.backfill) || nextDue > now;
        const run = shouldRun ? enqueue(schedule.conversation_id, period) : null;
        this.db.prepare('INSERT INTO report_occurrences(assignment_id,due_date,due_at,period,schedule_id,run_id) VALUES (?,?,?,?,?,?)')
          .run(schedule.assignment_id, date.toString(), due, period, schedule.id, run);
        this.reporting.event(run ? 'occurrence_queued' : 'occurrence_missed', { scheduleId: schedule.id, dueDate: date.toString(), period, run });
      }
      date = next; due = nextDue;
      if (schedule.backfill && !exists) break;
    }
    this.db.prepare('UPDATE report_schedules SET next_date=?,next_due=? WHERE id=?').run(date.toString(), due, schedule.id);
  }
}
