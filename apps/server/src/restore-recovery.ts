/// <reference lib="esnext.temporal" />
import { createHash } from 'node:crypto';
import { Dispatch, type InventoryItem } from '../../../packages/contracts/src/index.js';
import type { ServerStore } from './store.js';
import { Conflict } from './reporting.js';
import { dueAt } from './scheduler.js';

type Execution = Extract<InventoryItem, { kind: 'execution' }>;
export type Scan = { execution?: Execution; received: number; failed: boolean };

export class RestoreRecovery {
  constructor(private store: ServerStore) {}
  private get db() { return this.store.db; }
  paused() { return Boolean(this.db.prepare('SELECT 1 FROM restore_runners LIMIT 1').get()); }
  initialize() {
    this.db.transaction(() => {
      if (!this.paused()) {
        this.db.exec(`INSERT INTO restore_closed SELECT id FROM runs WHERE state IN ('completed','blocked','waiting_for_user');
          INSERT INTO restore_runners SELECT id,'offline' FROM runners;`);
      }
      this.offline();
      if (!this.paused()) throw new Conflict('Snapshot contains no enrolled runners');
      this.store.reporting.event('restore_paused', {});
    })();
  }
  status() {
    const runners = this.db.prepare('SELECT runner_id AS id,status FROM restore_runners').all() as { id: string; status: string }[];
    if (!runners.length) return null;
    const issues = this.db.prepare('SELECT run_id AS runId,reason FROM restore_issues ORDER BY rowid').all() as { runId: string; reason: string }[];
    return { runners, issues, ready: !issues.length && runners.every(r => r.status === 'checked') };
  }
  resume() {
    this.db.transaction(() => {
      if (!this.paused()) return;
      if (!this.status()?.ready) throw new Conflict('Runner reconciliation needs attention');
      this.db.exec('DELETE FROM restore_runners; DELETE FROM restore_seen; DELETE FROM restore_issues; DELETE FROM restore_closed');
      this.store.reporting.event('dispatch_resumed', {});
    })();
  }
  offline(runner?: string) {
    this.db.prepare("UPDATE restore_runners SET status='offline' WHERE (? IS NULL OR runner_id=?)").run(runner ?? null, runner ?? null);
  }
  unsupported(runner: string) {
    this.db.prepare("UPDATE restore_runners SET status='unsupported' WHERE runner_id=?").run(runner);
    this.store.reporting.event('runner_update_required', { runner });
  }
  begin(runner: string) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM restore_seen WHERE runner_id=?').run(runner);
      this.db.prepare("UPDATE restore_runners SET status='checking' WHERE runner_id=?").run(runner);
      this.store.reporting.event('reconciliation_started', { runner });
    })();
  }
  private issue(runner: string, run: string, reason: string) {
    this.db.prepare('INSERT OR REPLACE INTO restore_issues VALUES (?,?,?)').run(runner, run, reason);
    this.store.reporting.event('reconciliation_issue', { runId: run, reason });
  }
  private match(runner: string, dispatch: Dispatch) {
    const { context } = dispatch;
    const existing = this.db.prepare(`SELECT d.payload,d.id,r.runner_id FROM dispatches d JOIN runs r ON r.id=d.run_id WHERE r.id=?`)
      .get(context.runId) as { payload: string | null; id: string; runner_id: string } | undefined;
    if (existing) {
      if (!existing.payload && existing.runner_id === runner && existing.id === dispatch.dispatchId) {
        const row = this.db.prepare("SELECT * FROM runs WHERE id=? AND state='queued'").get(context.runId);
        const expected = row && this.store.prepareDispatch(runner,row);
        if (expected) existing.payload = JSON.stringify(expected);
      }
      if (existing.runner_id !== runner || existing.id !== dispatch.dispatchId || !existing.payload ||
        JSON.stringify(Dispatch.parse(JSON.parse(existing.payload))) !== JSON.stringify(dispatch))
        throw new Conflict('Stored dispatch differs from runner authorization');
      return;
    }
    this.restoreOccurrence(runner, dispatch);
  }
  private restoreOccurrence(runner: string, dispatch: Dispatch) {
    const { context, reportMessages: ids } = dispatch;
    const occurrence = context.occurrence;
    if (!occurrence || !ids) throw new Conflict('Original dispatch or DM message identities are missing from the snapshot and runner record');
    const schedule = this.db.prepare(`SELECT s.time,s.next_date,s.backfill FROM report_schedules s JOIN assignments a ON a.id=s.assignment_id
      JOIN conversations c ON c.id=a.conversation_id JOIN reporting_assignments ra ON ra.assignment_id=a.id
      WHERE s.id=? AND s.state='active' AND s.assignment_id=? AND s.runner_id=? AND a.conversation_id=? AND c.agent_id=? AND ra.closed=0`)
      .get(occurrence.scheduleId, context.assignmentId, runner, ids.conversationId, context.agentId) as {time: string; next_date: string; backfill: number} | undefined;
    if (!schedule || context.access?.approvalId !== occurrence.scheduleId || context.access.runnerId !== runner)
      throw new Conflict('Recurring approval or original DM conflicts with the runner dispatch');
    const date = Temporal.PlainDate.from(occurrence.dueDate), due = dueAt(date, schedule.time);
    const period = date.subtract({ days: 1 }).toString();
    if (Date.parse(occurrence.dueAt) !== due || context.range?.start !== period || context.range.end !== period ||
        date.toString() < schedule.next_date || (schedule.backfill && schedule.next_date !== date.toString()))
      throw new Conflict('Occurrence conflicts with the approved schedule cursor or report period');
    const request = context.messages.at(-1);
    if (!request || request.role !== 'user') throw new Conflict('Original report request missing');
    const message = this.db.prepare('INSERT INTO messages(id,conversation_id,author,text,state) VALUES (?,?,?,?,?)');
    message.run(ids.userId, ids.conversationId, 'user', request.text, 'complete');
    message.run(ids.assistantId, ids.conversationId, 'assistant', '', 'accepted');
    this.db.prepare("INSERT INTO runs(id,assignment_id,runner_id,user_message_id,assistant_message_id,state) VALUES (?,?,?,?,?,'accepted')")
      .run(context.runId, context.assignmentId, runner, ids.userId, ids.assistantId);
    this.db.prepare('INSERT INTO dispatches VALUES (?,?,?,1)').run(dispatch.dispatchId, context.runId, JSON.stringify(dispatch));
    this.db.prepare('INSERT INTO report_context(run_id,requested_range) VALUES (?,?)').run(context.runId, JSON.stringify(context.range));
    const insert = this.db.prepare('INSERT INTO report_occurrences VALUES (?,?,?,?,?,?)');
    for (let day = Temporal.PlainDate.from(schedule.next_date); Temporal.PlainDate.compare(day,date) < 0; day = day.add({ days: 1 })) {
      insert.run(context.assignmentId, day.toString(), dueAt(day,schedule.time), day.subtract({ days: 1 }).toString(), occurrence.scheduleId, null);
    }
    insert.run(context.assignmentId, occurrence.dueDate, due, period, occurrence.scheduleId, context.runId);
    const next = date.add({ days: 1 });
    this.db.prepare('UPDATE report_schedules SET next_date=?,next_due=? WHERE id=?').run(next.toString(), dueAt(next,schedule.time), occurrence.scheduleId);
  }
  private delivery(runner: string, item: Extract<InventoryItem,{ kind: 'delivery' }>) {
    const { delivery, decision } = item;
    if (delivery.event.kind === 'operation' && !this.db.prepare('SELECT 1 FROM delivery_receipts WHERE runner_id=? AND delivery_id=?').get(runner, delivery.deliveryId))
      throw new Conflict('Central operation receipt is missing. Its effects need review');
    const result = this.store.receive(runner, delivery);
    if (item.result && JSON.stringify(result) !== JSON.stringify(item.result)) throw new Conflict('Central operation receipts disagree');
    if (delivery.event.kind === 'approval') {
      const id = delivery.event.approval.approvalId;
      const approval = this.db.prepare('SELECT decision,acknowledged FROM approvals WHERE id=? AND run_id=?').get(id,delivery.runId) as { decision: string | null; acknowledged: number };
      if ((decision && (decision.approvalId !== id || decision.runId !== delivery.runId || decision.decision !== approval.decision)) ||
          (!decision && approval.decision === 'accept'))
        throw new Conflict('Approval decision conflicts with the restored browser decision');
      if (decision) this.store.acknowledgeDecision(runner, id);
    }
  }
  apply(runner: string, scan: Scan, item: InventoryItem) {
    const current = scan.execution;
    if (current && !scan.failed && item.kind !== 'delivery') {
      const run = current.dispatch.context.runId;
      const state = this.db.prepare('SELECT state,last_sequence FROM runs WHERE id=?').get(run) as { state: string; last_sequence: number };
      if (scan.received !== current.sequence || state.last_sequence !== current.sequence ||
          (current.state === 'done') !== ['completed','waiting_for_user','blocked'].includes(state.state))
        this.issue(runner, run, 'Execution and delivery records disagree about completion');
      else if (current.state === 'queued' && (state.state !== 'accepted' || current.sequence !== 0))
        this.issue(runner, run, 'Runner queue conflicts with evidence that execution started');
      else if (current.state === 'running' || (state.state === 'blocked' && !this.db.prepare('SELECT 1 FROM restore_closed WHERE run_id=?').get(run)))
        this.issue(runner, run, 'Execution outcome is uncertain. Review the runner record before retrying');
    }
    if (item.kind === 'end') {
      this.db.prepare(`INSERT OR REPLACE INTO restore_issues SELECT r.runner_id,r.id,'Runner has no matching execution for this dispatch'
        FROM runs r JOIN dispatches d ON d.run_id=r.id WHERE r.runner_id=? AND d.payload IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM restore_seen s WHERE s.run_id=r.id AND s.runner_id=r.runner_id)`).run(runner);
      this.db.prepare("UPDATE restore_runners SET status='checked' WHERE runner_id=?").run(runner);
      this.store.reporting.event('reconciliation_checked', { runner });
      return;
    }
    if (item.kind === 'execution') {
      scan.execution = item; scan.received = 0; scan.failed = false;
      this.db.prepare('INSERT INTO restore_seen VALUES (?,?)').run(runner,item.dispatch.context.runId);
      this.db.prepare('DELETE FROM restore_issues WHERE runner_id=? AND run_id=?').run(runner,item.dispatch.context.runId);
    }
    const run = scan.execution?.dispatch.context.runId;
    if (!run || item.kind === 'delivery' && item.delivery.runId !== run) throw new Conflict('Unexpected inventory order');
    if (scan.failed) return;
    try {
      this.db.transaction(() => {
        if (item.kind === 'execution') {
          this.match(runner,item.dispatch);
          this.store.accept(runner,item.dispatch.dispatchId);
        } else {
          if (item.delivery.sequence !== ++scan.received) throw new Conflict('Runner delivery sequence is incomplete');
          if (item.delivery.event.kind === 'outcome' && scan.execution?.outcomeHash &&
              createHash('sha256').update(JSON.stringify(item.delivery.event.outcome)).digest('hex') !== scan.execution.outcomeHash)
            throw new Conflict('Terminal delivery differs from the outcome saved by the runner');
          this.delivery(runner,item);
        }
      })();
    } catch (error) {
      scan.failed = true;
      this.issue(runner,run,error instanceof Conflict ? error.message : 'Stored identities or records conflict');
    }
  }
}
