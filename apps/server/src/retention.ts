import { Delivery, Dispatch, HistoryReceipt, RetentionDays, type PruneHistory } from '../../../packages/contracts/src/index.js';
import { compactReceipt, journalHash } from '../../../packages/contracts/src/history.js';
import { Conflict } from './reporting.js';
import type { ServerStore } from './store.js';

export class HistoryRetention {
  constructor(private store: ServerStore) {}
  private get db() { return this.store.db; }
  days() { return Number(this.db.prepare('SELECT days FROM history_policy').pluck().get()); }
  configure(days: number) {
    this.db.prepare('UPDATE history_policy SET days=?').run(RetentionDays.parse(days));
    this.store.reporting.event('history_retention_changed', { days });
  }
  pin(id: string, pinned: boolean) {
    const changed = this.db.prepare(`UPDATE run_history SET pinned=?,error=NULL,retry_at=0 WHERE run_id=? AND phase='full'
      AND EXISTS(SELECT 1 FROM runs WHERE id=?)`).run(Number(pinned),id,id);
    if (!changed.changes) throw new Conflict('Run details have already expired or the run is unavailable');
    this.store.reporting.event(pinned ? 'run_pinned' : 'run_unpinned', { runId: id });
  }
  next(runner: string, now = Date.now()): PruneHistory | undefined {
    if (this.store.recovery.paused()) return;
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT r.id,r.last_sequence,d.id AS dispatch,d.payload FROM run_history h JOIN runs r ON r.id=h.run_id
        JOIN dispatches d ON d.run_id=r.id WHERE r.runner_id=? AND r.state='completed' AND h.pinned=0 AND h.retry_at<=?
        AND (h.phase='pending' OR (h.phase='full' AND h.closed_at<=?)) AND d.payload IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM approvals a WHERE a.run_id=r.id AND (a.decision IS NULL OR a.acknowledged=0))
        ORDER BY h.closed_at LIMIT 1`).get(runner,now,now-this.days()*86_400_000) as {id:string; last_sequence:number; dispatch:string; payload:string} | undefined;
      if (!row) return;
      const rows = this.db.prepare(`SELECT d.payload,d.result,CASE WHEN a.session_id IS NOT NULL THEN a.decision END AS decision
        FROM delivery_receipts d LEFT JOIN approvals a ON a.run_id=? AND a.id=json_extract(d.payload,'$.event.approval.approvalId')
        WHERE d.runner_id=? AND json_extract(d.payload,'$.runId')=? ORDER BY json_extract(d.payload,'$.sequence')`).iterate(row.id,runner,row.id);
      let digest: string;
      try { digest = journalHash(rows,Dispatch.parse(JSON.parse(row.payload)),row.last_sequence); }
      catch { this.problem(row.id,'Server delivery journal is incomplete or inconsistent',now); return; }
      // Commit the authorization before sending it. A concurrent pin either wins
      // this transaction or reports that cleanup is already in progress.
      this.db.prepare("UPDATE run_history SET phase='pending',retry_at=? WHERE run_id=?").run(now+60_000,row.id);
      this.store.reporting.event('history_cleanup_pending',{runId: row.id});
      return {type:'prune_history',version:1,runId:row.id,dispatchId:row.dispatch,journalHash:digest} as const;
    })();
  }
  private problem(id: string, error: string, now = Date.now()) {
    this.db.prepare('UPDATE run_history SET error=?,retry_at=? WHERE run_id=?').run(error,now+60_000,id);
    this.store.reporting.event('history_cleanup_deferred',{runId:id});
  }
  result(runner: string, id: string, dispatch: string, error?: string) {
    const row = this.db.prepare(`SELECT h.phase FROM run_history h JOIN runs r ON r.id=h.run_id JOIN dispatches d ON d.run_id=r.id
      WHERE r.id=? AND d.id=? AND r.runner_id=?`).pluck().get(id,dispatch,runner);
    if (row === 'pruned') return;
    if (row !== 'pending') throw new Conflict('Unexpected cleanup acknowledgment');
    if (error) this.problem(id,error);
    else this.complete(runner,id);
  }
  complete(runner: string, id: string) {
    this.db.transaction(() => {
      const history = this.db.prepare('SELECT pinned,phase FROM run_history WHERE run_id=?').get(id) as { pinned:number; phase:string };
      if (history.phase === 'pruned') return;
      if (history.pinned) throw new Conflict('Pinned run has lost detailed runner evidence');
      const rows = this.db.prepare(`SELECT payload FROM delivery_receipts WHERE runner_id=? AND json_extract(payload,'$.runId')=?
        AND json_extract(payload,'$.event.kind') IN ('progress','activity')`).pluck().all(runner,id);
      const update = this.db.prepare('UPDATE delivery_receipts SET payload=? WHERE runner_id=? AND delivery_id=?');
      for (const row of rows) {
        const receipt = compactReceipt(Delivery.parse(JSON.parse(String(row))));
        update.run(JSON.stringify(receipt),runner,receipt.deliveryId);
      }
      this.db.prepare("DELETE FROM events WHERE kind IN ('progress','activity') AND json_extract(data,'$.runId')=?").run(id);
      this.db.prepare("UPDATE run_history SET phase='pruned',error=NULL,retry_at=0 WHERE run_id=?").run(id);
      this.store.reporting.event('history_pruned',{runId:id});
    })();
  }
  recoverReceipt(runner: string, receipt: HistoryReceipt) {
    const { deliveryId,runId,sequence } = receipt;
    const saved = this.db.prepare('SELECT payload FROM delivery_receipts WHERE runner_id=? AND delivery_id=?').pluck().get(runner,deliveryId);
    if (saved) {
      const value = JSON.parse(String(saved));
      const old = value.kind === 'history_receipt' ? HistoryReceipt.parse(value) : compactReceipt(Delivery.parse(value));
      if (JSON.stringify(old) !== JSON.stringify(receipt)) throw new Conflict('Compact delivery receipt conflicts with the snapshot');
      return;
    }
    const advanced = this.db.prepare(`UPDATE runs SET last_sequence=? WHERE id=? AND runner_id=? AND last_sequence=?
      AND state IN ('accepted','running','approval')`).run(sequence,runId,runner,sequence-1);
    if (!advanced.changes) throw new Conflict('Compact delivery sequence conflicts with the snapshot');
    this.db.prepare('INSERT INTO delivery_receipts VALUES (?,?,?,NULL)').run(runner,deliveryId,JSON.stringify(receipt));
  }
}
