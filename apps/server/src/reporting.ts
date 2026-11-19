import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { ReportAccess } from '../../../packages/contracts/src/reporting.js';

export class Conflict extends Error {}

export const administratorInstructions = 'You are the Arthegall administrator. Use create_reporting_assignment to create a named Codex reporting agent, its DM and usage assignment. Use revise_reporting_agent for routine instruction changes. Use run_usage_report whenever asked to initiate a report, including during creation. Omit range for yesterday. Only the user can authorize access using the browser approval card. The reporter delivers the result in its DM.';

export class Reporting {
  constructor(private db: Database.Database) {}
  event(kind: string, data: unknown) {
    this.db.prepare('INSERT INTO events(kind,data) VALUES (?,?)').run(kind, JSON.stringify(data));
  }
  assignment(conversationId: string) {
    const row = this.db.prepare(`SELECT a.id AS agentId, a.name,a.instructions,a.revision,
      s.id AS assignmentId,c.id AS conversationId,ra.instructions AS assignmentInstructions,COALESCE(ra.closed,0) AS closed FROM conversations c JOIN assignments s ON s.conversation_id=c.id
      LEFT JOIN reporting_assignments ra ON ra.assignment_id=s.id JOIN agents a ON a.id=c.agent_id WHERE c.id=?`).get(conversationId);
    if (!row) throw new Conflict('Unknown conversation');
    return z.object({ agentId: z.uuid(), name: z.string(), instructions: z.string(), revision: z.number(), assignmentId: z.uuid(), conversationId: z.uuid(), assignmentInstructions: z.string().nullable(), closed: z.number() }).parse(row);
  }
  find(name: string) {
    return this.db.prepare('SELECT c.id FROM conversations c JOIN agents a ON a.id=c.agent_id WHERE a.name=? COLLATE NOCASE').pluck().get(name) as string | undefined;
  }
  create(name: string, instructions: string, assignment: string, source: string) {
    const agentId = randomUUID(), conversationId = randomUUID(), assignmentId = randomUUID();
    this.db.prepare('INSERT INTO agents VALUES (?,1,?,?)').run(agentId, name, instructions);
    this.db.prepare('INSERT INTO definition_history VALUES (?,1,?,?)').run(agentId, instructions, source);
    this.db.prepare('INSERT INTO conversations VALUES (?,?)').run(conversationId, agentId);
    this.db.prepare('INSERT INTO assignments VALUES (?,?)').run(assignmentId, conversationId);
    this.db.prepare('INSERT INTO reporting_assignments(assignment_id,instructions) VALUES (?,?)').run(assignmentId, assignment);
    this.event('reporting_assignment_created', { agentId, assignmentId, conversationId, source, name });
    return conversationId;
  }
  closeAssignment(conversationId: string, sessionId: string) {
    this.db.transaction(() => {
      const { assignmentId, assignmentInstructions, closed } = this.assignment(conversationId);
      if (!assignmentInstructions) throw new Conflict('Select a reporting assignment');
      if (closed) return;
      if (this.db.prepare(`SELECT 1 FROM runs r JOIN dispatches d ON d.run_id=r.id WHERE r.assignment_id=?
        AND d.payload IS NOT NULL AND r.state IN ('queued','accepted','running','approval')`).get(assignmentId))
        throw new Conflict('An authorized run is still in progress. Close the assignment after it finishes.');
      this.db.prepare('UPDATE reporting_assignments SET closed=1 WHERE assignment_id=?').run(assignmentId);
      this.db.prepare("UPDATE report_access SET decision='decline',duration='assignment',session_id=? WHERE assignment_id=? AND decision IS NULL").run(sessionId, assignmentId);
      this.db.prepare(`UPDATE messages SET state='blocked',text='Assignment closed.' WHERE id IN
        (SELECT assistant_message_id FROM runs WHERE assignment_id=? AND state IN ('queued','awaiting_access'))`).run(assignmentId);
      this.db.prepare("UPDATE runs SET state='blocked' WHERE assignment_id=? AND state IN ('queued','awaiting_access')").run(assignmentId);
      this.event('reporting_assignment_closed', { assignmentId, sessionId });
    })();
  }
  revise(agentId: string, instructions: string, source: string) {
    this.db.prepare('UPDATE agents SET revision=revision+1,instructions=? WHERE id=? AND instructions!=?').run(instructions, agentId, instructions);
    this.db.prepare('INSERT OR IGNORE INTO definition_history SELECT id,revision,instructions,? FROM agents WHERE id=?').run(source, agentId);
    this.event('definition_revised', { agentId, source });
  }
  grant(assignment: string, runner: string, run: string | null) {
    const row = this.db.prepare(`SELECT id AS approvalId,runner_id AS runnerId,duration,'read_usage' AS tool FROM report_access
      WHERE assignment_id IN (SELECT assignment_id FROM reporting_assignments WHERE closed=0) AND assignment_id=? AND runner_id=? AND decision='accept' AND (duration='assignment' OR used_by IS NULL OR used_by=?) ORDER BY rowid DESC LIMIT 1`).get(assignment, runner, run);
    return row ? ReportAccess.parse(row) : undefined;
  }
  propose(assignment: string, runner: string, source: string) {
    if (this.grant(assignment, runner, null)) return;
    const id = randomUUID();
    if (this.db.prepare('INSERT OR IGNORE INTO report_access(id,assignment_id,runner_id) VALUES (?,?,?)').run(id, assignment, runner).changes)
      this.event('access_requested', { approvalId: id, assignmentId: assignment, runnerId: runner, tool: 'read_usage', source });
  }
  decide(session: string, id: string, decision: 'accept' | 'decline', duration: 'run' | 'assignment') {
    const row = this.db.prepare('SELECT assignment_id,runner_id,decision,duration FROM report_access WHERE id=?').get(id);
    if (!row) throw new Conflict('Unknown access request');
    const request = z.object({ assignment_id: z.string(), runner_id: z.string(), decision: z.string().nullable(), duration: z.string().nullable() }).parse(row);
    if (request.decision) {
      if (request.decision !== decision || request.duration !== duration) throw new Conflict('Access request already answered');
      return;
    }
    this.db.prepare('UPDATE report_access SET decision=?,duration=?,session_id=? WHERE id=?').run(decision, duration, session, id);
    this.event('access_decided', { approvalId: id, decision, duration, sessionId: session, assignmentId: request.assignment_id, runnerId: request.runner_id });
    if (decision === 'decline') {
      this.db.prepare(`UPDATE messages SET state='blocked',text='Runner and usage access declined.' WHERE id IN
        (SELECT assistant_message_id FROM runs WHERE assignment_id=? AND state='awaiting_access')`).run(request.assignment_id);
      this.db.prepare("UPDATE runs SET state='blocked' WHERE assignment_id=? AND state='awaiting_access'").run(request.assignment_id);
    } else {
      this.db.prepare("UPDATE runs SET state='queued' WHERE assignment_id=? AND state='awaiting_access'").run(request.assignment_id);
    }
  }
}
