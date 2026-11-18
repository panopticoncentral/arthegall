import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { Decision, Delivery, Dispatch, Outcome } from '../../../packages/contracts/src/index.js';
import { migrations } from './migrations.js';

const Execution = z.object({ run_id: z.string(), dispatch_id: z.string(), payload: z.string(), state: z.string(), thread_id: z.string().nullable(), turn_id: z.string().nullable(), model: z.string().nullable(), effort: z.string().nullable(), outcome: z.string().nullable(), text: z.string(), sequence: z.number() });
export class RunnerStore {
  readonly db: Database.Database;
  constructor(path: string, runnerId: string) {
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
    const row = this.db.prepare('SELECT thread_id FROM sessions WHERE assignment_id=?').get(assignmentId);
    return row ? z.object({ thread_id: z.string() }).parse(row).thread_id : undefined;
  }
  mapThread(runId: string, assignmentId: string, threadId: string, model: string, effort: string, remember = true) {
    this.db.transaction(() => {
      if (remember) this.db.prepare('INSERT INTO sessions VALUES (?,?) ON CONFLICT(assignment_id) DO UPDATE SET thread_id=excluded.thread_id').run(assignmentId, threadId);
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
  nextDelivery(): Delivery | undefined {
    const row = this.db.prepare('SELECT payload FROM deliveries WHERE acknowledged=0 ORDER BY position LIMIT 1').get();
    return row ? Delivery.parse(JSON.parse(z.object({ payload: z.string() }).parse(row).payload)) : undefined;
  }
  acknowledge(id: string) { this.db.prepare('UPDATE deliveries SET acknowledged=1 WHERE id=?').run(id); }
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
