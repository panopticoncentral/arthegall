/// <reference lib="esnext.temporal" />
import { createHash } from 'node:crypto';
import { Dispatch, type InventoryItem } from '../../../packages/contracts/src/index.js';
import type { ServerStore } from './store.js';
import { Conflict } from './reporting.js';

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
    const wake = context.scheduledItem;
    if (!wake || !ids) throw new Conflict('Original dispatch or DM message identities are missing from the snapshot and runner record');
    const due = Date.parse(wake.dueAt);
    const item = this.store.scheduler.recoverPending(wake.id, context.assignmentId, runner, due);
    const agent = this.store.reporting.assignment(ids.conversationId);
    const request = context.messages.at(-1);
    if (agent.closed || agent.assignmentId !== context.assignmentId || agent.agentId !== context.agentId ||
        request?.role !== 'user' || request.text !== item.instruction) throw new Conflict('Scheduled instruction or target changed');
    const message = this.db.prepare('INSERT INTO messages(id,conversation_id,author,text,state) VALUES (?,?,?,?,?)');
    message.run(ids.userId, ids.conversationId, 'user', request.text, 'complete');
    message.run(ids.assistantId, ids.conversationId, 'assistant', '', 'accepted');
    this.db.prepare("INSERT INTO runs(id,assignment_id,runner_id,user_message_id,assistant_message_id,state) VALUES (?,?,?,?,?,'accepted')")
      .run(context.runId, context.assignmentId, runner, ids.userId, ids.assistantId);
    this.db.prepare('INSERT INTO dispatches(id,run_id) VALUES (?,?)').run(dispatch.dispatchId, context.runId);
    if (!context.administrator) this.db.prepare('INSERT INTO report_context(run_id) VALUES (?)').run(context.runId);
    this.db.prepare("UPDATE scheduled_occurrences SET state='dispatched',run_id=? WHERE item_id=? AND due_at=?")
      .run(context.runId, wake.id, due);
    if (item.next_due === null) this.db.prepare("UPDATE scheduled_items SET state='completed' WHERE id=?").run(wake.id);
    const row = this.db.prepare('SELECT * FROM runs WHERE id=?').get(context.runId);
    const expected = this.store.prepareDispatch(runner, row);
    if (JSON.stringify(expected) !== JSON.stringify(dispatch)) throw new Conflict('Restored assignment permissions or instructions differ from the dispatched run');
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
        throw new Conflict('Approval decision conflicts with the restored decision');
      if (decision) this.store.acknowledgeDecision(runner, id);
    }
  }
  apply(runner: string, scan: Scan, item: InventoryItem) {
    const current = scan.execution;
    if (current && !scan.failed && ['execution','end'].includes(item.kind)) {
      const run = current.dispatch.context.runId;
      const state = this.db.prepare('SELECT state,last_sequence FROM runs WHERE id=?').get(run) as { state: string; last_sequence: number };
      if (scan.received !== current.sequence || state.last_sequence !== current.sequence ||
          (current.state === 'done') !== ['completed','waiting_for_user','blocked'].includes(state.state))
        this.issue(runner, run, 'Execution and delivery records disagree about completion');
      else if (current.state === 'queued' && (state.state !== 'accepted' || current.sequence !== 0))
        this.issue(runner, run, 'Runner queue conflicts with evidence that execution started');
      else if (current.state === 'running' || (state.state === 'blocked' && !this.db.prepare('SELECT 1 FROM restore_closed WHERE run_id=?').get(run)))
        this.issue(runner, run, 'Execution outcome is uncertain. Review the runner record before retrying');
      else if (current.pruned) {
        if (state.state !== 'completed' || this.db.prepare('SELECT pinned FROM run_history WHERE run_id=?').pluck().get(run))
          this.issue(runner,run,'Runner reports compacted history for a protected run');
        else if (current.cleanupPending)
          this.db.prepare("UPDATE run_history SET phase='pending',retry_at=0 WHERE run_id=?").run(run);
        else this.store.retention.complete(runner,run);
      }
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
    if (!run || (item.kind === 'delivery' && item.delivery.runId !== run) || (item.kind === 'history_receipt' && item.runId !== run)) throw new Conflict('Unexpected inventory order');
    if (scan.failed) return;
    try {
      this.db.transaction(() => {
        if (item.kind === 'execution') {
          this.match(runner,item.dispatch);
          this.store.accept(runner,item.dispatch.dispatchId);
        } else {
          if (item.kind === 'history_receipt') {
            if (!scan.execution?.pruned || scan.execution.state !== 'done' || item.sequence !== ++scan.received)
              throw new Conflict('Unexpected compact receipt in runner inventory');
            this.store.retention.recoverReceipt(runner,item);
            return;
          }
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
