// Synthetic milestone 2 installation, including its last completed report.
import { randomUUID, createHash } from 'node:crypto';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { migrations as serverMigrations } from '../../apps/server/src/migrations.js';
import { migrations as runnerMigrations } from '../../apps/runner/src/migrations.js';
import { readUsage } from '../../apps/runner/src/usage.js';
import { onDemandAdministratorInstructions } from '../../apps/server/src/reporting.js';

export async function reportingUpgrade(root: string, reportText = 'Earlier synthetic report') {
  const serverPath = join(root, 'server.sqlite'), runnerPath = join(root, 'runner.sqlite');
  const server = new Database(serverPath), runner = new Database(runnerPath);
  const ids = { server: randomUUID(), runner: randomUUID(), administrator: randomUUID(), conversation: randomUUID(), assignment: randomUUID() };
  const reporter = randomUUID(), dm = randomUUID(), assignment = randomUUID(), grant = randomUUID();
  const session = randomUUID(), browserToken = randomUUID(), runnerToken = randomUUID();
  const digest = (value: string) => createHash('sha256').update(value).digest('hex');
  const run = randomUUID(), user = randomUUID(), answer = randomUUID(), dispatch = randomUUID();
  const range = { start: '2019-01-01', end: '2019-01-01' };
  const roots = { codex: join(root, 'synthetic-codex'), claude: join(root, 'synthetic-claude') };
  const evidence = JSON.stringify(await readUsage(range, roots));
  try {
    for (const m of serverMigrations.slice(0, 2)) server.exec(m.sql);
    for (const m of runnerMigrations.slice(0, 3)) runner.exec(m.sql);
    server.pragma('user_version=2'); runner.pragma('user_version=3');
    for (const [key, value] of Object.entries(ids)) server.prepare('INSERT INTO metadata VALUES (?,?)').run(key, value);
    for (const [id, name, instructions, conversation, job] of [
      [ids.administrator, 'Administrator', onDemandAdministratorInstructions, ids.conversation, ids.assignment],
      [reporter, 'Rowan', 'Prepare accurate usage reports.', dm, assignment],
    ] as const) {
      server.prepare('INSERT INTO agents VALUES (?,1,?,?)').run(id, name, instructions);
      server.prepare('INSERT INTO definition_history VALUES (?,1,?,NULL)').run(id, instructions);
      server.prepare('INSERT INTO conversations VALUES (?,?)').run(conversation, id);
      server.prepare('INSERT INTO assignments VALUES (?,?)').run(job, conversation);
    }
    server.prepare("INSERT INTO runners VALUES (?,?,'ready')").run(ids.runner, digest(runnerToken));
    server.prepare('INSERT INTO grants VALUES (?,?,?)').run(ids.assignment, ids.runner, '["read_context","report_outcome"]');
    server.prepare('INSERT INTO reporting_assignments VALUES (?,?,0)').run(assignment, 'Report Codex and Claude usage and source coverage.');
    server.prepare('INSERT INTO browser_sessions VALUES (?,?,?,0)').run(session, digest(browserToken), Date.now() + 3600_000);
    server.prepare("INSERT INTO report_access VALUES (?,?,?,'accept','assignment',?,NULL)").run(grant, assignment, ids.runner, session);
    server.prepare("INSERT INTO messages(id,conversation_id,author,text,state) VALUES (?,?,'user','Earlier report request','complete'),(?,?,'assistant',?,'completed')").run(user, dm, answer, dm, reportText);
    server.prepare("INSERT INTO runs VALUES (?,?,?,?,?,'completed',2)").run(run, assignment, ids.runner, user, answer);
    server.prepare('INSERT INTO report_context VALUES (?,?,NULL,?)').run(run, JSON.stringify(range), evidence);
    const payload = JSON.stringify({ type: 'dispatch', version: 1, dispatchId: dispatch, context: { agentId: reporter, assignmentId: assignment, runId: run, definitionVersion: 1,
      instructions: 'Prepare accurate usage reports.', access: { runnerId: ids.runner, approvalId: grant, duration: 'assignment', tool: 'read_usage' },
      range, assignmentInstructions: 'Report Codex and Claude usage and source coverage.', messages: [{ role: 'user', text: 'Earlier report request' }] } });
    server.prepare('INSERT INTO dispatches VALUES (?,?,?,1)').run(dispatch, run, payload);
    runner.prepare("INSERT INTO metadata VALUES ('runner',?)").run(ids.runner);
    runner.prepare("INSERT INTO sessions VALUES (?,'prior-report-thread','prior-configuration')").run(assignment);
    runner.prepare("INSERT INTO sessions VALUES (?,'prior-admin-thread','prior-admin-configuration')").run(ids.assignment);
    runner.prepare("INSERT INTO executions(run_id,dispatch_id,payload,state,thread_id,sequence) VALUES (?,?,?,'done','prior-report-thread',2)").run(run, dispatch, payload);
    const events = [{ kind: 'usage', report: JSON.parse(evidence) }, { kind: 'outcome', outcome: { status: 'completed', message: reportText } }];
    for (const [index, event] of events.entries()) {
      const deliveryId = randomUUID();
      const delivery = JSON.stringify({ type: 'delivery', version: 1, deliveryId, runId: run, sequence: index + 1, event });
      runner.prepare('INSERT INTO deliveries(id,run_id,payload,acknowledged) VALUES (?,?,?,1)').run(deliveryId, run, delivery);
      server.prepare('INSERT INTO delivery_receipts VALUES (?,?,?,NULL)').run(ids.runner, deliveryId, delivery);
    }
  } finally { server.close(); runner.close(); }
  return { ids, serverPath, runnerPath, session, browserToken, runnerToken, assignment, dm, grant, run, evidence, roots };
}
