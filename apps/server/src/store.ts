import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { Decision, Delivery, Dispatch, ExecutionContext, SendMessage } from '../../../packages/contracts/src/index.js';
import { migrations } from './migrations.js';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export class Conflict extends Error {}
const Run = z.object({ id: z.string(), assignment_id: z.string(), runner_id: z.string(), user_message_id: z.string(), assistant_message_id: z.string(), state: z.string(), last_sequence: z.number() });

export class ServerStore {
  readonly db: Database.Database;
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000');
    const version = Number(this.db.pragma('user_version', { simple: true }));
    if (version > migrations.length) { this.db.close(); throw new Error('Server database is newer than this application'); }
    for (const migration of migrations.filter((m) => m.version > version)) this.db.transaction(() => {
      this.db.exec(migration.sql); this.db.pragma(`user_version = ${migration.version}`);
    })();
  }
  close() { this.db.close(); }
  private event(kind: string, data: unknown) { this.db.prepare('INSERT INTO events(kind,data) VALUES (?,?)').run(kind, JSON.stringify(data)); }
  private id(key: string) {
    const found = this.db.prepare('SELECT value FROM metadata WHERE key=?').get(key);
    if (found) return z.object({ value: z.string() }).parse(found).value;
    const value = randomUUID();
    this.db.prepare('INSERT INTO metadata VALUES (?,?)').run(key, value);
    return value;
  }
  setup(runnerToken: string) {
    return this.db.transaction(() => {
      const ids = { serverId: this.id('server'), runnerId: this.id('runner'), agentId: this.id('administrator'), conversationId: this.id('conversation'), assignmentId: this.id('assignment') };
      this.db.prepare('INSERT OR IGNORE INTO agents VALUES (?,1,?,?)').run(ids.agentId, 'Administrator', 'You are the Arthegall administrator. Help with the conversation. Agent creation and permission changes are not available yet. Use read_context and report_outcome.');
      this.db.prepare('INSERT OR IGNORE INTO conversations VALUES (?,?)').run(ids.conversationId, ids.agentId);
      this.db.prepare('INSERT OR IGNORE INTO assignments VALUES (?,?)').run(ids.assignmentId, ids.conversationId);
      const inserted = this.db.prepare('INSERT OR IGNORE INTO runners(id,credential_hash) VALUES (?,?)').run(ids.runnerId, hash(runnerToken));
      if (!this.authenticateRunner(ids.runnerId, runnerToken)) throw new Conflict('Existing runner credential does not match local setup');
      this.db.prepare('INSERT OR IGNORE INTO grants VALUES (?,?,?)').run(ids.assignmentId, ids.runnerId, JSON.stringify(['read_context', 'report_outcome']));
      if (inserted.changes) this.event('bootstrap_grant', { agentId: ids.agentId, assignmentId: ids.assignmentId, runnerId: ids.runnerId, tools: ['read_context', 'report_outcome'] });
      return ids;
    })();
  }
  authenticateRunner(id: string, token: string) { return Boolean(this.db.prepare('SELECT id FROM runners WHERE id=? AND credential_hash=?').get(id, hash(token))); }
  createPairingCode(now = Date.now()) {
    const code = randomBytes(18).toString('base64url');
    this.db.prepare('INSERT INTO pairing_codes(hash,expires) VALUES (?,?)').run(hash(code), now + 10 * 60_000);
    return code;
  }
  pair(code: string, address: string, now = Date.now()) {
    return this.db.transaction(() => {
      const row = this.db.prepare('SELECT count,reset_at FROM pairing_attempts WHERE address=?').get(address);
      const attempt = row ? z.object({ count: z.number(), reset_at: z.number() }).parse(row) : { count: 0, reset_at: now + 60_000 };
      if (attempt.reset_at <= now) { attempt.count = 0; attempt.reset_at = now + 60_000; }
      if (attempt.count >= 5) return undefined;
      this.db.prepare('INSERT INTO pairing_attempts VALUES (?,?,?) ON CONFLICT(address) DO UPDATE SET count=excluded.count,reset_at=excluded.reset_at').run(address, attempt.count + 1, attempt.reset_at);
      if (!this.db.prepare('UPDATE pairing_codes SET used=1 WHERE hash=? AND used=0 AND expires>?').run(hash(code), now).changes) return undefined;
      const token = randomBytes(32).toString('base64url');
      const id = randomUUID();
      this.db.prepare('INSERT INTO browser_sessions(id,hash,expires) VALUES (?,?,?)').run(id, hash(token), now + 365 * 24 * 60 * 60_000);
      this.event('browser_paired', { sessionId: id });
      return { id, token };
    })();
  }
  session(token: string, now = Date.now()) {
    const row = this.db.prepare('SELECT id FROM browser_sessions WHERE hash=? AND revoked=0 AND expires>?').get(hash(token), now);
    return row ? z.object({ id: z.string() }).parse(row).id : undefined;
  }
  revokeSession(id: string) {
    this.db.transaction(() => { this.db.prepare('UPDATE browser_sessions SET revoked=1 WHERE id=?').run(id); this.event('browser_revoked', { sessionId: id }); })();
  }
  send(sessionId: string, input: unknown) {
    const command = SendMessage.parse(input);
    const payload = JSON.stringify(command);
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT payload,run_id FROM command_receipts WHERE session_id=? AND command_id=?').get(sessionId, command.commandId);
      if (old) {
        const receipt = z.object({ payload: z.string(), run_id: z.string() }).parse(old);
        if (receipt.payload !== payload) throw new Conflict('Command ID reused with different content');
        return { runId: receipt.run_id };
      }
      const conversationId = this.id('conversation');
      const runId = randomUUID(), userId = randomUUID(), assistantId = randomUUID();
      const insert = this.db.prepare('INSERT INTO messages(id,conversation_id,author,text,state) VALUES (?,?,?,?,?)');
      insert.run(userId, conversationId, 'user', command.text, 'complete');
      insert.run(assistantId, conversationId, 'assistant', '', 'queued');
      this.db.prepare('INSERT INTO runs(id,assignment_id,runner_id,user_message_id,assistant_message_id,state) VALUES (?,?,?,?,?,?)').run(runId, this.id('assignment'), this.id('runner'), userId, assistantId, 'queued');
      this.db.prepare('INSERT INTO command_receipts VALUES (?,?,?,?)').run(sessionId, command.commandId, payload, runId);
      this.db.prepare('INSERT INTO dispatches(id,run_id) VALUES (?,?)').run(randomUUID(), runId);
      this.event('message_accepted', { runId });
      return { runId };
    })();
  }
  nextDispatch(runnerId: string): Dispatch | undefined {
    return this.db.transaction(() => {
      const row = this.db.prepare("SELECT r.* FROM dispatches d JOIN runs r ON r.id=d.run_id JOIN messages m ON m.id=r.user_message_id WHERE r.runner_id=? AND r.state IN ('queued','accepted','running','approval') ORDER BY m.sequence LIMIT 1").get(runnerId);
      if (!row) return;
      const run = Run.parse(row);
      const delivery = z.object({ id: z.string(), payload: z.string().nullable() }).parse(this.db.prepare('SELECT id,payload FROM dispatches WHERE run_id=?').get(run.id));
      if (delivery.payload) return Dispatch.parse(JSON.parse(delivery.payload));
      const agent = z.object({ id: z.string(), revision: z.number(), instructions: z.string() }).parse(this.db.prepare('SELECT * FROM agents WHERE id=?').get(this.id('administrator')));
      const messages = z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })).parse(this.db.prepare("SELECT author AS role,text FROM (SELECT * FROM messages WHERE sequence <= (SELECT sequence FROM messages WHERE id=?) AND text != '' ORDER BY sequence DESC LIMIT 40) ORDER BY sequence").all(run.user_message_id));
      let remaining = 32_000;
      const bounded = messages.reverse().flatMap((message) => {
        if (!remaining) return [];
        const text = message.text.slice(-remaining);
        remaining -= text.length;
        return [{ ...message, text }];
      }).reverse();
      const context = ExecutionContext.parse({ agentId: agent.id, assignmentId: run.assignment_id, runId: run.id, definitionVersion: agent.revision, instructions: agent.instructions, messages: bounded });
      const dispatch = Dispatch.parse({ type: 'dispatch', version: 1, dispatchId: delivery.id, context });
      this.db.prepare('UPDATE dispatches SET payload=? WHERE id=?').run(JSON.stringify(dispatch), delivery.id);
      return dispatch;
    })();
  }
  accept(runnerId: string, dispatchId: string) {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT r.* FROM runs r JOIN dispatches d ON r.id=d.run_id WHERE d.id=? AND r.runner_id=?').get(dispatchId, runnerId);
      if (!row) throw new Conflict('Unknown dispatch');
      const run = Run.parse(row);
      this.db.prepare('UPDATE dispatches SET accepted=1 WHERE id=?').run(dispatchId);
      if (run.state === 'queued') { this.db.prepare("UPDATE runs SET state='accepted' WHERE id=?").run(run.id); this.event('dispatch_accepted', { runId: run.id }); }
    })();
  }
  receive(runnerId: string, input: unknown) {
    const delivery = Delivery.parse(input), payload = JSON.stringify(delivery);
    this.db.transaction(() => {
      const old = this.db.prepare('SELECT payload FROM delivery_receipts WHERE runner_id=? AND delivery_id=?').get(runnerId, delivery.deliveryId);
      if (old) {
        if (z.object({ payload: z.string() }).parse(old).payload !== payload) throw new Conflict('Delivery ID reused with different content');
        return;
      }
      const run = Run.parse(this.db.prepare('SELECT * FROM runs WHERE id=? AND runner_id=?').get(delivery.runId, runnerId));
      if (run.last_sequence + 1 !== delivery.sequence) throw new Conflict('Delivery sequence gap');
      if (['completed', 'blocked', 'waiting_for_user'].includes(run.state)) throw new Conflict('Run already closed');
      const event = delivery.event;
      if (event.kind === 'progress') {
        this.db.prepare("UPDATE messages SET text=?,state='streaming' WHERE id=?").run(event.text, run.assistant_message_id);
        this.db.prepare("UPDATE runs SET state=CASE WHEN state='approval' THEN state ELSE 'running' END WHERE id=?").run(run.id);
      } else if (event.kind === 'outcome') {
        this.db.prepare('UPDATE messages SET text=?,state=? WHERE id=?').run(event.outcome.message, event.outcome.status, run.assistant_message_id);
        this.db.prepare('UPDATE runs SET state=? WHERE id=?').run(event.outcome.status, run.id);
        this.db.prepare("UPDATE approvals SET decision=COALESCE(decision,'decline'),acknowledged=1 WHERE run_id=?").run(run.id);
      } else if (event.kind === 'approval') {
        this.db.prepare('INSERT INTO approvals(id,run_id,command) VALUES (?,?,?)').run(event.approval.approvalId, run.id, event.approval.command);
        this.db.prepare("UPDATE runs SET state='approval' WHERE id=?").run(run.id);
      }
      this.db.prepare('UPDATE runs SET last_sequence=? WHERE id=?').run(delivery.sequence, run.id);
      this.db.prepare('INSERT INTO delivery_receipts VALUES (?,?,?)').run(runnerId, delivery.deliveryId, payload);
      this.event(event.kind, { runId: run.id, ...(event.kind === 'activity' ? { message: event.message } : {}) });
    })();
  }
  decide(sessionId: string, approvalId: string, decision: 'accept' | 'decline') {
    this.db.transaction(() => {
      const row = this.db.prepare("SELECT a.* FROM approvals a JOIN runs r ON r.id=a.run_id WHERE a.id=? AND r.state='approval'").get(approvalId);
      if (!row) throw new Conflict('Approval is no longer pending');
      const approval = z.object({ decision: z.string().nullable() }).parse(row);
      if (approval.decision && approval.decision !== decision) throw new Conflict('Approval already answered');
      if (approval.decision) return;
      this.db.prepare('UPDATE approvals SET decision=?,session_id=? WHERE id=?').run(decision, sessionId, approvalId);
      this.event('approval_decided', { approvalId, decision, sessionId });
    })();
  }
  decisions(runnerId: string): Decision[] {
    return this.db.prepare('SELECT a.id,a.run_id,a.decision FROM approvals a JOIN runs r ON r.id=a.run_id WHERE r.runner_id=? AND a.decision IS NOT NULL AND a.acknowledged=0').all(runnerId).map((row) => {
      const item = z.object({ id: z.string(), run_id: z.string(), decision: z.enum(['accept', 'decline']) }).parse(row);
      return { type: 'decision', version: 1, approvalId: item.id, runId: item.run_id, decision: item.decision };
    });
  }
  acknowledgeDecision(runnerId: string, id: string) {
    this.db.prepare('UPDATE approvals SET acknowledged=1 WHERE id=? AND run_id IN (SELECT id FROM runs WHERE runner_id=?)').run(id, runnerId);
  }
  runnerStatus(runnerId: string, status: string) {
    this.db.transaction(() => {
      this.db.prepare('UPDATE runners SET status=? WHERE id=?').run(status, runnerId);
      this.event('runner_status', { status });
    })();
  }
  snapshot() {
    return this.db.transaction(() => ({
      messages: this.db.prepare('SELECT id,author,text,state FROM messages ORDER BY sequence').all(),
      approvals: this.db.prepare('SELECT id,run_id AS runId,command FROM approvals WHERE decision IS NULL').all(),
      runs: this.db.prepare('SELECT id,state FROM runs').all(),
      runners: this.db.prepare('SELECT id,status FROM runners').all(),
      cursor: z.object({ cursor: z.number() }).parse(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS cursor FROM events').get()).cursor,
    }))();
  }
  events(after: number) { return this.db.prepare('SELECT sequence,kind,data,created_at AS createdAt FROM events WHERE sequence>? ORDER BY sequence LIMIT 200').all(after); }
}
