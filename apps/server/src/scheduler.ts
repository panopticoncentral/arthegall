/// <reference lib="esnext.temporal" />
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import type { ScheduleOperation, ScheduleTiming } from '../../../packages/contracts/src/scheduling.js';
import { Conflict } from './reporting.js';


type Item = { id: string; assignment_id: string; instruction: string; timing: string; next_due: number | null; backfill: number };
type Queued = Item & { conversation_id: string; due_at: number };

function nextCron(when: Extract<ScheduleTiming, { kind: 'cron' }>, from: number, id: string) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: when.timeZone });
    if (!when.expression.startsWith('@') && ![5, 6].includes(when.expression.split(/\s+/).length)) throw new Error();
    return CronExpressionParser.parse(when.expression, { currentDate: new Date(from), tz: when.timeZone, hashSeed: id }).next().getTime();
  } catch { throw new Conflict('Choose a valid cron expression with a future occurrence and an IANA time zone'); }
}
function firstDue(when: ScheduleTiming, now: number, id: string) {
  if (when.kind === 'cron') return nextCron(when, now, id);
  const due = when.kind === 'after' ? now + when.seconds * 1000 : Date.parse(when.at);
  if (!Number.isFinite(new Date(due).getTime()) || due <= now || new Date(due).getUTCFullYear() > 9999) throw new Conflict('Choose a future time');
  return due;
}

export class Scheduler {
  constructor(private db: Database.Database, private now: () => Date) {}

  // Called inside the authorized operation's receipt transaction.
  operate(assignment: string, runner: string, op: ScheduleOperation) {
    if (op.tool === 'list_scheduled_items') {
      const rows = this.db.prepare(`SELECT * FROM scheduled_items WHERE assignment_id=? AND state='active'
        AND id>? ORDER BY id LIMIT 21`).all(assignment, op.args.afterId ?? '') as Item[];
      const items = rows.slice(0,20).map(row => ({ id: row.id, instruction: row.instruction, when: JSON.parse(row.timing) as ScheduleTiming,
        missed: row.backfill ? 'all' as const : 'latest' as const, nextDue: row.next_due === null ? null : new Date(row.next_due).toISOString() }));
      return { items, nextAfterId: rows.length > items.length ? items.at(-1)!.id : null };
    }
    if (op.tool !== 'schedule_item') {
      if (!this.db.prepare(`SELECT 1 FROM scheduled_items WHERE id=? AND assignment_id=? AND state='active'`)
        .get(op.args.id, assignment)) throw new Conflict('Unknown active scheduled item for this assignment');
      if (op.tool === 'cancel_scheduled_item') {
        this.db.prepare("UPDATE scheduled_items SET state='cancelled',next_due=NULL WHERE id=?").run(op.args.id);
        return { id: op.args.id, nextDue: null };
      }
    }
    const id = op.tool === 'schedule_item' ? randomUUID() : op.args.id;
    const { instruction, when, missed } = op.args;
    const due = firstDue(when, this.now().getTime(), id);
    if (op.tool === 'schedule_item') {
      this.db.prepare("INSERT INTO scheduled_items VALUES (?,?,?,?,?,?,?,'active')")
        .run(id, assignment, runner, instruction, JSON.stringify(when), Number(missed === 'all'), due);
    } else {
      this.db.prepare("UPDATE scheduled_occurrences SET state='cancelled' WHERE item_id=? AND state='queued'").run(id);
      this.db.prepare('UPDATE scheduled_items SET timing=?,instruction=?,backfill=?,next_due=? WHERE id=?')
        .run(JSON.stringify(when), instruction, Number(missed === 'all'), due, id);
    }
    return { id, nextDue: new Date(due).toISOString() };
  }

  // The server clock owns this durable queue. No runner connection is needed.
  tick() {
    const now = this.now().getTime();
    this.db.transaction(() => {
      const due = this.db.prepare(`SELECT * FROM scheduled_items WHERE state='active' AND next_due<=?
        ORDER BY next_due,id LIMIT 64`).all(now) as Item[];
      for (const item of due) this.fire(item, now);
    })();
  }

  private fire(item: Item, now: number) {
    const when = JSON.parse(item.timing) as ScheduleTiming;
    let due = item.next_due!;
    // Bound catch-up per item per tick so a long outage cannot monopolize the server.
    for (let count = 0; count < 32 && due <= now; count++) {
      let next: number | null = null;
      if (when.kind === 'cron') next = nextCron(when, due, item.id);
      const state = !item.backfill && next !== null && next <= now ? 'skipped' : 'queued';
      if (!item.backfill) this.db.prepare("UPDATE scheduled_occurrences SET state='skipped' WHERE item_id=? AND due_at<? AND state='queued'").run(item.id, due);
      this.db.prepare('INSERT INTO scheduled_occurrences(item_id,due_at,state) VALUES (?,?,?) ON CONFLICT(item_id,due_at) DO NOTHING').run(item.id, due, state);
      this.db.prepare('UPDATE scheduled_items SET next_due=? WHERE id=?').run(next, item.id);
      if (next === null) break;
      due = next;
    }
  }

  // Reconstruct only an occurrence authorized by the schedule in the restored snapshot.
  recoverPending(id: string, assignment: string, runner: string, due: number) {
    const query = this.db.prepare("SELECT * FROM scheduled_items WHERE id=? AND assignment_id=? AND runner_id=? AND state='active'");
    let item = query.get(id, assignment, runner) as Item | undefined;
    if (!item) throw new Conflict('Scheduled item is absent or inactive in the snapshot');
    while (item.next_due !== null && item.next_due <= due) {
      if (item.backfill && item.next_due < due) throw new Conflict('Earlier scheduled work is missing from the runner journal');
      this.fire(item, due);
      item = query.get(id, assignment, runner) as Item;
    }
    const queued = this.db.prepare("SELECT due_at FROM scheduled_occurrences WHERE item_id=? AND state='queued' ORDER BY due_at LIMIT 1").pluck().get(id);
    if (queued !== due) throw new Conflict('Runner occurrence conflicts with the restored schedule');
    return item;
  }

  // Claim and enqueue the run in the same transaction as dispatch selection.
  dispatch(runner: string, enqueue: (item: Queued) => string | undefined) {
    const item = this.db.prepare(`SELECT i.*,o.due_at,a.conversation_id FROM scheduled_occurrences o
      JOIN scheduled_items i ON i.id=o.item_id JOIN assignments a ON a.id=i.assignment_id
      WHERE o.state='queued' AND i.state='active' AND i.runner_id=?
      AND (i.backfill=1 OR i.next_due IS NULL OR i.next_due>?) ORDER BY o.due_at,i.id LIMIT 1`).get(runner, this.now().getTime()) as Queued | undefined;
    if (!item) return;
    const run = enqueue(item);
    this.db.prepare('UPDATE scheduled_occurrences SET state=?,run_id=? WHERE item_id=? AND due_at=?')
      .run(run ? 'dispatched' : 'skipped', run ?? null, item.id, item.due_at);
    if (item.next_due === null) this.db.prepare("UPDATE scheduled_items SET state='completed' WHERE id=?").run(item.id);
    return run;
  }
}
