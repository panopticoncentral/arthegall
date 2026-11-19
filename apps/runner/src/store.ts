import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Decision, Delivery, Dispatch, type InventoryItem, OperationResult, Outcome } from '../../../packages/contracts/src/index.js';
import type { AdminOperation } from '../../../packages/contracts/src/reporting.js';
import { migrations } from './migrations.js';

const Execution = z.object({ run_id: z.string(), dispatch_id: z.string(), payload: z.string(), state: z.string(), thread_id: z.string().nullable(), turn_id: z.string().nullable(), model: z.string().nullable(), effort: z.string().nullable(), outcome: z.string().nullable(), text: z.string(), sequence: z.number() });
export class RunnerStore {
  readonly db: Database.Database;
  constructor(path: string, private readonly runnerId: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version > migrations.length) { this.db.close(); throw new Error('Runner database is newer than this application'); }
    for (const migration of migrations.filter((m) => m.version > version)) this.db.transaction(() => {
      this.db.exec(migration.sql); this.db.pragma(`user_version = ${migration.version}`);
    })();
    this.db.prepare("INSERT OR IGNORE INTO metadata VALUES ('runner',?)").run(runnerId);
    if (z.object({ value: z.string() }).parse(this.db.prepare("SELECT value FROM metadata WHERE key='runner'").get()).value !== runnerId) {
      this.db.close(); throw new Error('Runner identity does not match database');
    }
  }
  close() { this.db.close(); }
  accept(input: unknown) {
    const dispatch = Dispatch.parse(input), payload = JSON.stringify(dispatch);
    if (dispatch.context.access && dispatch.context.access.runnerId !== this.runnerId) throw new Error('Runner grant mismatch');
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM executions WHERE run_id=? OR dispatch_id=?').get(dispatch.context.runId, dispatch.dispatchId);
      if (row) { if (Execution.parse(row).payload !== payload) throw new Error('Conflicting dispatch'); return; }
      this.db.prepare("INSERT INTO executions(run_id,dispatch_id,payload,state) VALUES (?,?,?,'queued')").run(dispatch.context.runId, dispatch.dispatchId, payload);
    })();
    return dispatch;
  }
  execution(runId: string) { return Execution.parse(this.db.prepare('SELECT * FROM executions WHERE run_id=?').get(runId)); }
  queued() {
    const row = this.db.prepare("SELECT payload FROM executions WHERE state='queued' ORDER BY rowid LIMIT 1").get();
    return row ? Dispatch.parse(JSON.parse(z.object({ payload: z.string() }).parse(row).payload)) : undefined;
  }
  interrupted() { return z.array(Execution).parse(this.db.prepare("SELECT * FROM executions WHERE state='running'").all()); }
  start(runId: string) { this.db.prepare("UPDATE executions SET state='running' WHERE run_id=? AND state='queued'").run(runId); }
  session(assignmentId: string) {
    const row = this.db.prepare('SELECT thread_id,thread_configuration FROM sessions WHERE assignment_id=?').get(assignmentId);
    return row ? z.object({ thread_id: z.string(), thread_configuration: z.string().nullable() }).parse(row) : undefined;
  }
  mapThread(runId: string, assignmentId: string, threadId: string, model: string, effort: string, configuration?: string) {
    this.db.transaction(() => {
      if (configuration) this.db.prepare(`INSERT INTO sessions(assignment_id,thread_id,thread_configuration) VALUES (?,?,?)
        ON CONFLICT(assignment_id) DO UPDATE SET thread_id=excluded.thread_id,thread_configuration=excluded.thread_configuration`).run(assignmentId, threadId, configuration);
      this.db.prepare('UPDATE executions SET thread_id=?,model=?,effort=? WHERE run_id=?').run(threadId, model, effort, runId);
    })();
  }
  mapTurn(runId: string, turnId: string) { this.db.prepare('UPDATE executions SET turn_id=? WHERE run_id=?').run(turnId, runId); }
  stageOutcome(runId: string, input: unknown) {
    const outcome = JSON.stringify(Outcome.parse(input));
    this.db.transaction(() => {
      const run = this.execution(runId);
      if (run.state !== 'running') throw new Error('Run is not active');
      if (run.outcome && run.outcome !== outcome) throw new Error('Outcome already recorded');
      this.db.prepare('UPDATE executions SET outcome=? WHERE run_id=?').run(outcome, runId);
    })();
  }
  private enqueue(runId: string, event: Delivery['event']) {
    const run = this.execution(runId);
    const delivery = Delivery.parse({ type: 'delivery', version: 1, deliveryId: randomUUID(), runId, sequence: run.sequence + 1, event });
    this.db.prepare('UPDATE executions SET sequence=? WHERE run_id=?').run(delivery.sequence, runId);
    this.db.prepare('INSERT INTO deliveries(id,run_id,payload) VALUES (?,?,?)').run(delivery.deliveryId, runId, JSON.stringify(delivery));
    return delivery.deliveryId;
  }
  requestOperation(runId: string, operation: AdminOperation) {
    return this.db.transaction(() => {
      const key = JSON.stringify(operation);
      const existing = this.db.prepare('SELECT delivery_id FROM operations WHERE run_id=? AND operation=?').pluck().get(runId, key);
      if (existing) return String(existing);
      const execution = this.execution(runId);
      if (execution.state !== 'running' || !Dispatch.parse(JSON.parse(execution.payload)).context.administrator) throw new Error('Administrator execution required');
      const id = this.enqueue(runId, { kind: 'operation', operation });
      this.db.prepare('INSERT INTO operations(run_id,operation,delivery_id) VALUES (?,?,?)').run(runId, key, id);
      return id;
    })();
  }
  operationResult(id: string) {
    const saved = this.db.prepare('SELECT result FROM operations WHERE delivery_id=?').pluck().get(id);
    return saved ? OperationResult.parse(JSON.parse(String(saved))) : undefined;
  }
  publish(runId: string, event: Delivery['event']) {
    if (event.kind === 'outcome') throw new Error('Use finish to commit outcome and run together');
    this.db.transaction(() => {
      if (this.execution(runId).state !== 'running') throw new Error('Run is not active');
      this.enqueue(runId, event);
      if (event.kind === 'progress') this.db.prepare('UPDATE executions SET text=? WHERE run_id=?').run(event.text, runId);
    })();
  }
  finish(runId: string, outcome: Outcome) {
    this.db.transaction(() => {
      const run = this.execution(runId);
      if (run.state === 'done') {
        if (run.outcome !== JSON.stringify(outcome)) throw new Error('Run already closed with a different outcome');
        return;
      }
      this.enqueue(runId, { kind: 'outcome', outcome });
      this.db.prepare("UPDATE executions SET state='done',outcome=? WHERE run_id=?").run(JSON.stringify(outcome), runId);
    })();
  }
  // The connection holds execution starts while inventory is being read. Keyset
  // reads avoid both unbounded frames and a SQLite iterator across socket waits.
  *inventory(): Generator<InventoryItem> {
    let cursor = 0;
    const executions = this.db.prepare('SELECT rowid,payload,state,sequence,outcome FROM executions WHERE rowid>? ORDER BY rowid LIMIT 1');
    const deliveries = this.db.prepare(`SELECT d.position,d.payload,o.result FROM deliveries d
      LEFT JOIN operations o ON o.delivery_id=d.id WHERE d.run_id=? AND d.position>? ORDER BY d.position LIMIT 1`);
    for (;;) {
      const row = executions.get(cursor) as { rowid: number; payload: string; outcome: string | null; state: 'queued'|'running'|'done'; sequence: number } | undefined;
      if (!row) break;
      cursor = row.rowid;
      const dispatch = Dispatch.parse(JSON.parse(row.payload));
      const outcomeHash = row.outcome ? createHash('sha256').update(JSON.stringify(Outcome.parse(JSON.parse(row.outcome)))).digest('hex') : undefined;
      yield { kind: 'execution', dispatch, state: row.state, sequence: row.sequence, ...(outcomeHash ? { outcomeHash } : {}) };
      let position = 0;
      for (;;) {
        const item = deliveries.get(dispatch.context.runId, position) as { position: number; payload: string; result: string | null } | undefined;
        if (!item) break;
        position = item.position;
        const delivery = Delivery.parse(JSON.parse(item.payload));
        const saved = delivery.event.kind === 'approval' && this.db.prepare('SELECT payload FROM decisions WHERE approval_id=?').pluck().get(delivery.event.approval.approvalId);
        yield { kind: 'delivery', delivery, ...(saved ? { decision: Decision.parse(JSON.parse(String(saved))) } : {}),
          ...(item.result ? { result: OperationResult.parse(JSON.parse(item.result)) } : {}) };
      }
    }
    yield { kind: 'end' };
  }
  nextDelivery(): Delivery | undefined {
    const row = this.db.prepare('SELECT payload FROM deliveries WHERE acknowledged=0 ORDER BY position LIMIT 1').get();
    return row ? Delivery.parse(JSON.parse(z.object({ payload: z.string() }).parse(row).payload)) : undefined;
  }
  acknowledge(id: string, result?: OperationResult) {
    this.db.transaction(() => {
      if (result) this.db.prepare('UPDATE operations SET result=? WHERE delivery_id=?').run(JSON.stringify(result), id);
      this.db.prepare('UPDATE deliveries SET acknowledged=1 WHERE id=?').run(id);
    })();
  }
  decision(input: unknown) {
    const decision = Decision.parse(input), payload = JSON.stringify(decision);
    this.db.transaction(() => {
      const old = this.db.prepare('SELECT payload FROM decisions WHERE approval_id=?').get(decision.approvalId);
      if (old && z.object({ payload: z.string() }).parse(old).payload !== payload) throw new Error('Conflicting approval decision');
      this.db.prepare('INSERT OR IGNORE INTO decisions VALUES (?,?,?)').run(decision.approvalId, decision.runId, payload);
    })();
    return decision;
  }
}
