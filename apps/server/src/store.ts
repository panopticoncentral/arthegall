import Database from 'better-sqlite3';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { Decision, Delivery, Dispatch, ExecutionContext, OperationResult, SendMessage } from '../../../packages/contracts/src/index.js';
import { RestoreRecovery } from './restore-recovery.js';
import { HistoryRetention } from './retention.js';
import { compactReceipt } from '../../../packages/contracts/src/history.js';
import { Scheduler } from './scheduler.js';
import { migrations } from './migrations.js';

export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
import { Reporting, Conflict, administratorInstructions } from './reporting.js';
import { AdminOperation, yesterday, type DateRange } from '../../../packages/contracts/src/reporting.js';
export { Conflict };
const Run = z.object({ id: z.string(), assignment_id: z.string(), runner_id: z.string(), user_message_id: z.string(), assistant_message_id: z.string(), state: z.string(), last_sequence: z.number() });

export class ServerStore {
  readonly db: Database.Database;
  readonly reporting: Reporting;
  readonly retention = new HistoryRetention(this);
  readonly scheduler: Scheduler;
  readonly recovery: RestoreRecovery;
  constructor(path: string, private now = () => new Date()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path);
    this.recovery = new RestoreRecovery(this);
    this.reporting = new Reporting(this.db);
    this.scheduler = new Scheduler(this.db, this.reporting, now);
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
      this.db.prepare('INSERT OR IGNORE INTO agents VALUES (?,1,?,?)').run(ids.agentId, 'Administrator', administratorInstructions);
      this.db.prepare('INSERT OR IGNORE INTO definition_history SELECT id,revision,instructions,NULL FROM agents WHERE id=?').run(ids.agentId);
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
      const conversationId = command.conversationId ?? this.id('conversation');
      const runId = this.enqueue(conversationId, command.text, undefined, command.replyTo);
      this.db.prepare('INSERT INTO command_receipts VALUES (?,?,?,?)').run(sessionId, command.commandId, payload, runId);
      return { runId };
    })();
  }
  private enqueue(conversationId: string, text: string, range?: DateRange, replyTo?: string, scheduled = false) {
    const { assignmentId, closed } = this.reporting.assignment(conversationId);
    if (closed) throw new Conflict('Assignment is closed');
    const runId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), runnerId = this.id('runner');
    let parent: string | undefined;
    if (replyTo) {
      parent = this.db.prepare(`SELECT r.id FROM runs r JOIN report_context c ON c.run_id=r.id
        WHERE r.assistant_message_id=? AND r.assignment_id=? AND c.evidence IS NOT NULL AND r.state='completed'`).pluck().get(replyTo, assignmentId) as string | undefined;
      if (!parent) throw new Conflict('Choose a completed report in this DM');
    }
    // A scheduled report's approved follow-up may read its saved evidence.
    if (!parent && !range) parent = this.db.prepare(`SELECT r.id FROM runs r JOIN report_context c ON r.id=c.run_id
      WHERE r.assignment_id=? AND r.state='completed' AND c.evidence IS NOT NULL ORDER BY r.rowid DESC LIMIT 1`).pluck().get(assignmentId) as string | undefined;
    const recurringReply = parent && this.recurringAccess(parent, runnerId);
    const needsAccess = assignmentId !== this.id('assignment') && !scheduled && !recurringReply
      && !this.reporting.grant(assignmentId, runnerId, runId);
    const state = needsAccess ? 'awaiting_access' : 'queued';
    const insert = this.db.prepare('INSERT INTO messages(id,conversation_id,author,text,state) VALUES (?,?,?,?,?)');
    insert.run(userId, conversationId, 'user', text, 'complete');
    insert.run(assistantId, conversationId, 'assistant', '', state);
    this.db.prepare('INSERT INTO runs(id,assignment_id,runner_id,user_message_id,assistant_message_id,state) VALUES (?,?,?,?,?,?)').run(runId, assignmentId, runnerId, userId, assistantId, state);
    if (assignmentId !== this.id('assignment')) this.db.prepare('INSERT INTO report_context(run_id,requested_range,reply_to) VALUES (?,?,?)').run(runId, range ? JSON.stringify(range) : null, parent ?? null);
    if (needsAccess) this.reporting.propose(assignmentId, runnerId, runId);
    this.db.prepare('INSERT INTO dispatches(id,run_id) VALUES (?,?)').run(randomUUID(), runId);
    this.event('message_accepted', { runId, assignmentId });
    return runId;
  }
  private recurringAccess(runId: string, runnerId: string) {
    const id = this.db.prepare(`SELECT s.id FROM report_occurrences o JOIN report_schedules s ON s.id=o.schedule_id
      WHERE o.run_id=? AND s.runner_id=? AND s.state='active'`).pluck().get(runId, runnerId);
    return id ? { runnerId, approvalId: String(id), tool: 'read_usage' as const, duration: 'recurring' as const } : undefined;
  }
  adminOperation(runnerId: string, runId: string, input: unknown) {
    const op = AdminOperation.parse(input);
    return this.db.transaction(() => {
      const row = this.db.prepare(`SELECT d.payload FROM runs r JOIN dispatches d ON d.run_id=r.id
        WHERE r.id=? AND r.runner_id=? AND r.assignment_id=? AND d.payload IS NOT NULL`).pluck().get(runId, runnerId, this.id('assignment'));
      if (!row || !Dispatch.parse(JSON.parse(String(row))).context.administrator) throw new Conflict('Administrator dispatch required');
      const key = JSON.stringify(op);
      const receipt = this.db.prepare('SELECT result FROM admin_receipts WHERE run_id=? AND operation=?').pluck().get(runId, key);
      if (receipt) return OperationResult.parse(JSON.parse(String(receipt)));
      if (!this.db.prepare("SELECT id FROM runs WHERE id=? AND state IN ('queued','accepted','running')").get(runId)) throw new Conflict('Administrator run has ended');
      let conversation = this.reporting.find(op.args.name);
      if (conversation === this.id('conversation')) throw new Conflict('Choose a reporting agent');
      if (!conversation) {
        if (op.tool !== 'create_reporting_assignment') throw new Conflict('Reporting agent does not exist');
        conversation = this.reporting.create(op.args.name, op.args.instructions, op.args.assignment ?? 'Prepare on-demand usage reports for the local runner and answer questions about the saved reports.', runId);
      }
      const agent = this.reporting.assignment(conversation);
      if (agent.closed) throw new Conflict('Assignment is closed');
      let reportRunId: string | undefined;
      let scheduledApproval: boolean | undefined;
      if (op.tool === 'run_usage_report') {
        const range = op.args.range ?? yesterday(this.now());
        reportRunId = this.enqueue(conversation, `Report usage for ${range.start} through ${range.end} in America/Los_Angeles.`, range);
      } else if (op.tool === 'schedule_usage_report') {
        scheduledApproval = this.scheduler.propose(agent.assignmentId, runnerId, op.args.time, op.args.backfill ?? false, runId);
      } else if (op.tool === 'revise_reporting_agent') {
        this.reporting.revise(agent.agentId, op.args.instructions, runId);
      } else {
        if (agent.instructions !== op.args.instructions || op.args.assignment && op.args.assignment !== agent.assignmentInstructions) throw new Conflict('Name already in use. Use revise_reporting_agent for a requested change.');
        this.reporting.propose(agent.assignmentId, runnerId, runId);
      }
      const result = { name: agent.name, conversationId: conversation, assignmentId: agent.assignmentId, ...(reportRunId ? { reportRunId } : {}),
        access: (scheduledApproval ?? Boolean(this.reporting.grant(agent.assignmentId, runnerId, null))) ? 'approved' : 'requires browser approval' };
      this.db.prepare('INSERT INTO admin_receipts VALUES (?,?,?)').run(runId, key, JSON.stringify(result));
      this.event('administrator_operation', { runId, tool: op.tool, ...result });
      return result;
    })();
  }
  nextDispatch(runnerId: string): Dispatch | undefined {
    return this.db.transaction(() => {
      if (this.recovery.paused()) return;
      const queued = this.db.prepare("SELECT r.* FROM dispatches d JOIN runs r ON r.id=d.run_id JOIN messages m ON m.id=r.user_message_id WHERE r.runner_id=? AND r.state IN ('queued','accepted','running','approval') ORDER BY m.sequence LIMIT 1");
      let row = queued.get(runnerId);
      if (!row) {
        this.scheduler.materialize(runnerId, (conversation, period) => this.enqueue(conversation,
          `Scheduled usage report for ${period} in America/Los_Angeles.`, { start: period, end: period }, undefined, true));
        row = queued.get(runnerId);
      }
      if (!row) return;
      return this.prepareDispatch(runnerId, row);
    })();
  }
  prepareDispatch(runnerId: string, row: unknown): Dispatch | undefined {
    const run = Run.parse(row);
    const delivery = z.object({ id: z.string(), payload: z.string().nullable() }).parse(this.db.prepare('SELECT id,payload FROM dispatches WHERE run_id=?').get(run.id));
    if (delivery.payload) return Dispatch.parse(JSON.parse(delivery.payload));
    const conversation = String(this.db.prepare('SELECT conversation_id FROM assignments WHERE id=?').pluck().get(run.assignment_id));
    const agent = this.reporting.assignment(conversation);
    const administrator = run.assignment_id === this.id('assignment');
    let authority: Partial<ExecutionContext>;
    if (administrator) {
      if (!this.db.prepare('SELECT 1 FROM grants WHERE assignment_id=? AND runner_id=?').get(run.assignment_id, runnerId)) throw new Conflict('Bootstrap grant missing');
      authority = { administrator: true };
    } else {
      const details = this.db.prepare('SELECT requested_range,reply_to FROM report_context WHERE run_id=?').get(run.id) as { requested_range: string | null; reply_to: string | null };
      const occurrence = this.db.prepare('SELECT due_date AS dueDate,due_at,schedule_id AS scheduleId FROM report_occurrences WHERE run_id=?')
        .get(run.id) as { dueDate: string; due_at: number; scheduleId: string } | undefined;
      const recurring = this.recurringAccess(details.reply_to ?? run.id, runnerId);
      const access = occurrence ? recurring : recurring ?? this.reporting.grant(run.assignment_id, runnerId, run.id);
      if (!access) {
        this.db.prepare("UPDATE runs SET state='awaiting_access' WHERE id=?").run(run.id);
        this.db.prepare("UPDATE messages SET state='awaiting_access' WHERE id=?").run(run.assistant_message_id);
        this.reporting.propose(run.assignment_id, runnerId, run.id);
        return;
      }
      if (access.duration === 'run') this.db.prepare('UPDATE report_access SET used_by=? WHERE id=?').run(run.id, access.approvalId);
      const previous = this.db.prepare(`SELECT c.run_id,c.evidence FROM report_context c JOIN runs r ON r.id=c.run_id
        JOIN messages m ON m.id=r.user_message_id WHERE r.assignment_id=? AND c.evidence IS NOT NULL
        AND r.state='completed' AND (c.run_id=? OR ? IS NULL) AND m.sequence<(SELECT sequence FROM messages WHERE id=?)
        ORDER BY m.sequence DESC LIMIT 1`).get(run.assignment_id, details.reply_to, details.reply_to, run.user_message_id) as { run_id: string; evidence: string } | undefined;
      if (previous && !details.requested_range) this.db.prepare('UPDATE report_context SET reply_to=? WHERE run_id=?').run(previous.run_id, run.id);
      const preference = this.db.prepare('SELECT revision,instructions FROM report_preferences WHERE assignment_id=? ORDER BY revision DESC LIMIT 1')
        .get(run.assignment_id) as ExecutionContext['preference'];
      authority = { access, assignmentInstructions: agent.assignmentInstructions! };
      if (preference) authority.preference = preference;
      if (occurrence) authority.occurrence = { scheduleId: occurrence.scheduleId, dueDate: occurrence.dueDate,
        dueAt: new Date(occurrence.due_at).toISOString() };
      if (details.requested_range) authority.range = JSON.parse(details.requested_range);
      else if (previous) authority.priorReport = JSON.parse(previous.evidence);
    }
    const messages = z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })).parse(this.db.prepare("SELECT author AS role,text FROM (SELECT * FROM messages WHERE conversation_id=? AND sequence <= (SELECT sequence FROM messages WHERE id=?) AND text != '' ORDER BY sequence DESC LIMIT 40) ORDER BY sequence").all(conversation, run.user_message_id));
    let remaining = 32_000;
    const bounded = messages.reverse().flatMap((message) => {
      if (!remaining) return [];
      const text = message.text.slice(-remaining);
      remaining -= text.length;
      return [{ ...message, text }];
    }).reverse();
    const context = ExecutionContext.parse({ ...authority, agentId: agent.agentId, assignmentId: run.assignment_id, runId: run.id, definitionVersion: agent.revision, instructions: agent.instructions, messages: authority.occurrence ? bounded.slice(-1) : bounded });
    const dispatch = Dispatch.parse({ type: 'dispatch', version: 1, dispatchId: delivery.id, context,
      ...(authority.occurrence ? { reportMessages: { conversationId: conversation, userId: run.user_message_id, assistantId: run.assistant_message_id } } : {}) });
    this.db.prepare('UPDATE dispatches SET payload=? WHERE id=?').run(JSON.stringify(dispatch), delivery.id);
    return dispatch;
  }
  accept(runnerId: string, dispatchId: string) {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT r.* FROM runs r JOIN dispatches d ON r.id=d.run_id WHERE d.id=? AND d.payload IS NOT NULL AND r.runner_id=?').get(dispatchId, runnerId);
      if (!row) throw new Conflict('Unknown dispatch');
      const run = Run.parse(row);
      this.db.prepare('UPDATE dispatches SET accepted=1 WHERE id=?').run(dispatchId);
      if (run.state === 'queued') { this.db.prepare("UPDATE runs SET state='accepted' WHERE id=?").run(run.id); this.event('dispatch_accepted', { runId: run.id }); }
    })();
  }
  receive(runnerId: string, input: unknown) {
    const delivery = Delivery.parse(input), payload = JSON.stringify(delivery);
    return this.db.transaction(() => {
      const old = this.db.prepare('SELECT payload,result FROM delivery_receipts WHERE runner_id=? AND delivery_id=?').get(runnerId, delivery.deliveryId);
      if (old) {
        const saved = z.object({ payload: z.string(), result: z.string().nullable() }).parse(old);
        if (saved.payload !== payload) {
          const previous = JSON.parse(saved.payload);
          const matches = previous.kind === 'history_receipt'
            ? ['progress','activity'].includes(delivery.event.kind) && JSON.stringify(compactReceipt(delivery)) === saved.payload
            : JSON.stringify(Delivery.parse(previous)) === payload;
          if (!matches) throw new Conflict('Delivery ID reused with different content');
        }
        const result = saved.result;
        return result ? OperationResult.parse(JSON.parse(result)) : undefined;
      }
      const dispatched = this.db.prepare(`SELECT r.* FROM runs r JOIN dispatches d ON d.run_id=r.id
        WHERE r.id=? AND r.runner_id=? AND d.payload IS NOT NULL`).get(delivery.runId, runnerId);
      if (!dispatched) throw new Conflict('Run has no authorized dispatch');
      const run = Run.parse(dispatched);
      if (run.last_sequence + 1 !== delivery.sequence) throw new Conflict('Delivery sequence gap');
      if (['completed', 'blocked', 'waiting_for_user'].includes(run.state)) throw new Conflict('Run already closed');
      const event = delivery.event;
      let result: OperationResult | undefined;
      if (event.kind === 'progress') {
        this.db.prepare("UPDATE messages SET text=?,state='streaming' WHERE id=?").run(event.text, run.assistant_message_id);
        this.db.prepare("UPDATE runs SET state=CASE WHEN state='approval' THEN state ELSE 'running' END WHERE id=?").run(run.id);
      } else if (event.kind === 'operation') {
        try { result = this.adminOperation(runnerId, run.id, event.operation); }
        catch (error) {
          if (!(error instanceof Conflict)) throw error;
          result = { error: error.message };
          this.event('operation_rejected', { runId: run.id, tool: event.operation.tool, ...result });
        }
      } else if (event.kind === 'usage') {
        const dispatch = Dispatch.parse(JSON.parse(String(this.db.prepare('SELECT payload FROM dispatches WHERE run_id=?').pluck().get(run.id))));
        if (dispatch.context.access?.runnerId !== runnerId || JSON.stringify(dispatch.context.range) !== JSON.stringify(event.report.range))
          throw new Conflict('Usage result outside report scope');
        const saved = this.db.prepare('UPDATE report_context SET evidence=? WHERE run_id=? AND evidence IS NULL').run(JSON.stringify(event.report), run.id);
        if (!saved.changes) throw new Conflict('Report evidence already recorded');
      } else if (event.kind === 'outcome') {
        if (event.outcome.status === 'completed' && this.db.prepare('SELECT 1 FROM report_context WHERE run_id=? AND requested_range IS NOT NULL AND evidence IS NULL').get(run.id))
          throw new Conflict('Missing report evidence');
        if (event.outcome.assignmentPreference) {
          const reply = this.db.prepare('SELECT reply_to FROM report_context WHERE run_id=? AND requested_range IS NULL').pluck().get(run.id);
          if (!reply || event.outcome.status !== 'completed') throw new Conflict('A completed report reply is required to update assignment memory');
          this.db.prepare(`INSERT INTO report_preferences(assignment_id,revision,instructions,source_run)
            SELECT ?,COALESCE(MAX(revision),0)+1,?,? FROM report_preferences WHERE assignment_id=?`)
            .run(run.assignment_id, event.outcome.assignmentPreference, run.id, run.assignment_id);
          this.event('assignment_preference_saved', { assignmentId: run.assignment_id, sourceRun: run.id, reportRun: reply });
        }
        this.db.prepare('UPDATE messages SET text=?,state=? WHERE id=?').run(event.outcome.message, event.outcome.status, run.assistant_message_id);
        this.db.prepare('UPDATE runs SET state=? WHERE id=?').run(event.outcome.status, run.id);
        this.db.prepare("UPDATE approvals SET decision=COALESCE(decision,'decline'),acknowledged=1 WHERE run_id=?").run(run.id);
      } else if (event.kind === 'approval') {
        this.db.prepare('INSERT INTO approvals(id,run_id,command) VALUES (?,?,?)').run(event.approval.approvalId, run.id, event.approval.command);
        this.db.prepare("UPDATE runs SET state='approval' WHERE id=?").run(run.id);
      }
      this.db.prepare('UPDATE runs SET last_sequence=? WHERE id=?').run(delivery.sequence, run.id);
      this.db.prepare('INSERT INTO delivery_receipts VALUES (?,?,?,?)').run(runnerId, delivery.deliveryId, payload, result ? JSON.stringify(result) : null);
      this.event(event.kind, { runId: run.id, ...(event.kind === 'activity' ? { message: event.message } : {}) });
      return result;
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
      recovery: this.recovery.status(), retentionDays: this.retention.days(),
      conversations: this.db.prepare(`SELECT c.id,a.name,(a.id=?) AS administrator,COALESCE(ra.closed,0) AS closed FROM conversations c JOIN agents a ON a.id=c.agent_id JOIN assignments s ON s.conversation_id=c.id LEFT JOIN reporting_assignments ra ON ra.assignment_id=s.id ORDER BY administrator DESC,c.rowid`).all(this.id('administrator')),
      schedules: this.db.prepare(`SELECT p.id,p.assignment_id AS assignmentId,p.runner_id AS runnerId,p.time,p.backfill,p.state,
        s.conversation_id AS conversationId,a.name FROM report_schedules p JOIN assignments s ON s.id=p.assignment_id
        JOIN conversations c ON c.id=s.conversation_id JOIN agents a ON a.id=c.agent_id WHERE p.state IN ('pending','active')`).all(),
      grants: this.db.prepare(`SELECT p.id,a.name,s.conversation_id AS conversationId FROM report_access p JOIN assignments s ON s.id=p.assignment_id
        JOIN conversations c ON c.id=s.conversation_id JOIN agents a ON a.id=c.agent_id WHERE p.decision IS NULL`).all(),
      messages: this.db.prepare(`SELECT m.id,m.conversation_id AS conversationId,m.author,m.text,m.state,
        c.evidence, EXISTS(SELECT 1 FROM runs r JOIN report_context q ON q.run_id=r.id WHERE r.user_message_id=m.id AND q.requested_range IS NOT NULL) AS requestedReport
        FROM messages m LEFT JOIN runs r ON r.assistant_message_id=m.id AND r.state='completed'
        LEFT JOIN report_context c ON c.run_id=r.id ORDER BY m.sequence`).all().map((row) => {
        const message = row as { id: string; conversationId: string; author: string; text: string; state: string; requestedReport: number; evidence: string | null };
        return { ...message, evidence: message.evidence ? JSON.parse(message.evidence) : null };
      }),
      approvals: this.db.prepare('SELECT a.id,a.run_id AS runId,s.conversation_id AS conversationId,a.command FROM approvals a JOIN runs r ON r.id=a.run_id JOIN assignments s ON s.id=r.assignment_id WHERE a.decision IS NULL').all(),
      runs: this.db.prepare(`SELECT r.id,r.state,r.assistant_message_id AS messageId,h.pinned,h.phase AS history,h.error AS historyError
        FROM runs r JOIN run_history h ON h.run_id=r.id`).all(),
      runners: this.db.prepare('SELECT id,status FROM runners').all(),
      cursor: z.object({ cursor: z.number() }).parse(this.db.prepare('SELECT COALESCE(MAX(sequence),0) AS cursor FROM events').get()).cursor,
    }))();
  }
  events(after: number) { return this.db.prepare('SELECT sequence,kind,data,created_at AS createdAt FROM events WHERE sequence>? ORDER BY sequence LIMIT 200').all(after); }
}
