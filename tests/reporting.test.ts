import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import { ServerStore, hash } from '../apps/server/src/store.js';
import { RunnerStore } from '../apps/runner/src/store.js';
import { migrations as serverMigrations } from '../apps/server/src/migrations.js';
import { migrations as runnerMigrations } from '../apps/runner/src/migrations.js';
import type { AdminOperation } from '../packages/contracts/src/reporting.js';
import { readUsage } from '../apps/runner/src/usage.js';

test('upgrade deployed schema with paired browser, prior messages and provider thread', () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-upgrade-'));
  try {
    const path = join(root, 'server'), runnerPath = join(root, 'runner');
    const old = new Database(path), oldRunner = new Database(runnerPath);
    const runner = randomUUID(), admin = randomUUID(), dm = randomUUID(), assignment = randomUUID(), session = randomUUID();
    old.exec(serverMigrations[0]!.sql); oldRunner.exec(runnerMigrations[0]!.sql);
    old.pragma('user_version=1'); oldRunner.pragma('user_version=1');
    for (const [key, id] of Object.entries({ server: randomUUID(), runner, administrator: admin, conversation: dm, assignment }))
      old.prepare('INSERT INTO metadata VALUES (?,?)').run(key,id);
    old.prepare("INSERT INTO agents VALUES (?,1,'Administrator','Synthetic old instructions')").run(admin);
    old.prepare('INSERT INTO conversations VALUES (?,?)').run(dm,admin);
    old.prepare('INSERT INTO assignments VALUES (?,?)').run(assignment,dm);
    old.prepare('INSERT INTO runners(id,credential_hash) VALUES (?,?)').run(runner,hash('synthetic'));
    old.prepare('INSERT INTO grants VALUES (?,?,?)').run(assignment,runner,'["read_context","report_outcome"]');
    old.prepare('INSERT INTO browser_sessions VALUES (?,?,?,0)').run(session,hash('synthetic-browser'),Date.now()+60_000);
    old.prepare("INSERT INTO messages(id,conversation_id,author,text,state) VALUES (?,?,'assistant','Earlier result','completed')").run(randomUUID(),dm);
    oldRunner.prepare('INSERT INTO sessions VALUES (?,?)').run(assignment,'synthetic-thread');
    old.close(); oldRunner.close();
    const server = new ServerStore(path), local = new RunnerStore(runnerPath, runner);
    try {
      assert.equal(server.session('synthetic-browser'),session);
      assert.equal(server.setup('synthetic').conversationId,dm);
      assert.equal(server.db.prepare('SELECT count(*) FROM definition_history').pluck().get(),3);
      assert.deepEqual(local.session(assignment), { thread_id: 'synthetic-thread', thread_configuration: null });
      server.send(session,{ commandId: randomUUID(), text: 'Continue' });
      const dispatch = server.nextDispatch(runner)!;
      assert.equal(dispatch.context.definitionVersion,3); assert.equal(dispatch.context.administrator,true);
      assert.equal(dispatch.context.messages[0]?.text,'Earlier result');
      assert.deepEqual(server.db.pragma('foreign_key_check'),[]);
    } finally { server.close(); local.close(); }
  } finally { rmSync(root,{ recursive:true,force:true }); }
});

test('durable setup, narrowed access, scoped reports, rejection, redelivery and assignment closure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-reporting-'));
  const server = new ServerStore(join(root,'server')), ids = server.setup('synthetic');
  const runner = new RunnerStore(join(root,'runner'),ids.runnerId);
  const browser = server.pair(server.createPairingCode(),'synthetic-client')!;
  const deliver = () => {
    let receipt;
    for (let d = runner.nextDelivery(); d; d = runner.nextDelivery()) {
      receipt = server.receive(ids.runnerId,d);
      assert.deepEqual(server.receive(ids.runnerId,d),receipt);
      runner.acknowledge(d.deliveryId,receipt);
    }
    return receipt;
  };
  const start = () => {
    const dispatch = server.nextDispatch(ids.runnerId)!;
    server.accept(ids.runnerId, dispatch.dispatchId); runner.accept(dispatch); runner.start(dispatch.context.runId);
    return dispatch.context;
  };
  const done = (runId: string) => { runner.finish(runId,{ status:'completed',message:'Synthetic result' }); deliver(); };
  try {
    server.send(browser.id,{ commandId:randomUUID(),text:'Synthetic private administrator context' });
    const admin = start();
    const setup: AdminOperation = { tool:'create_reporting_assignment',args:{ name:'Rowan', instructions:'Report usage' } };
    const op = runner.requestOperation(admin.runId,setup);
    assert.equal(runner.requestOperation(admin.runId,setup),op);
    deliver();
    const created = runner.operationResult(op);
    assert(created && !('error' in created));
    const range = { start:'2020-03-01', end:'2020-03-01' };
    const request: AdminOperation = { tool:'run_usage_report', args:{ name:'Rowan',range } };
    runner.requestOperation(admin.runId,request); deliver();
    done(admin.runId);
    assert.equal(server.nextDispatch(ids.runnerId),undefined);
    const pending = () => String(server.db.prepare('SELECT id FROM report_access WHERE decision IS NULL').pluck().get());
    const waiting = server.db.prepare("SELECT d.id,d.run_id FROM dispatches d JOIN runs r ON r.id=d.run_id WHERE r.state='awaiting_access'").get() as { id: string; run_id: string };
    assert.throws(() => server.accept(ids.runnerId, waiting.id), /Unknown dispatch/);
    assert.throws(() => server.receive(ids.runnerId, { type: 'delivery', version: 1, sequence: 1, runId: waiting.run_id,
      deliveryId: randomUUID(), event: { kind: 'progress', text: 'Premature' } }), /authorized dispatch/);
    const proposal = pending();
    server.reporting.decide(browser.id, proposal, 'accept','run');
    assert.throws(() => server.reporting.decide(browser.id, proposal, 'accept','assignment'));
    const report = start();
    assert.equal(report.access?.duration,'run'); assert.equal(report.administrator,undefined);
    assert.equal(report.messages.length,1); assert.deepEqual(report.range,range);
    assert.throws(() => server.adminOperation(ids.runnerId,report.runId,setup));
    assert.throws(() => runner.requestOperation(report.runId,setup));
    assert.throws(() => server.reporting.closeAssignment(created.conversationId,browser.id));
    const evidence = await readUsage(range,{ codex:join(root,'codex'),claude:join(root,'claude') });
    runner.publish(report.runId,{ kind:'usage',report:evidence }); done(report.runId);
    const answer = String(server.db.prepare('SELECT assistant_message_id FROM runs WHERE id=?').pluck().get(report.runId));
    assert.throws(() => server.send(browser.id,{ commandId:randomUUID(),text:'Wrong DM',replyTo:answer }));
    server.send(browser.id,{ commandId:randomUUID(),conversationId:created.conversationId,text:'Follow up',replyTo:answer });
    assert.equal(server.nextDispatch(ids.runnerId),undefined);
    server.reporting.decide(browser.id,pending(),'decline','assignment');
    assert.equal(server.nextDispatch(ids.runnerId),undefined);
    server.send(browser.id,{ commandId:randomUUID(),conversationId:created.conversationId,text:'Another follow-up',replyTo:answer });
    server.reporting.decide(browser.id,pending(),'accept','assignment');
    const follow = start();
    assert.deepEqual(follow.priorReport,evidence); assert.equal(follow.range,undefined);
    assert.equal(follow.assignmentId,report.assignmentId);
    done(follow.runId);
    assert.equal(server.db.prepare('SELECT count(*) FROM report_preferences').pluck().get(), 0);
    for (const [index, instruction] of ['Lead with coverage.', 'Lead with coverage, then show spend.'].entries()) {
      server.send(browser.id, { commandId: randomUUID(), conversationId: created.conversationId, replyTo: answer, text: instruction + ' From now on.' });
      const reply = start();
      assert.equal(reply.preference?.revision, index || undefined);
      runner.finish(reply.runId, { status: 'completed', message: 'Saved.', assignmentPreference: instruction }); deliver();
    }
    assert.deepEqual(server.db.prepare('SELECT revision,instructions FROM report_preferences WHERE assignment_id=? ORDER BY revision').all(report.assignmentId),
      [{ revision: 1, instructions: 'Lead with coverage.' }, { revision: 2, instructions: 'Lead with coverage, then show spend.' }]);
    server.reporting.closeAssignment(created.conversationId,browser.id);
    assert.equal(server.reporting.grant(report.assignmentId,ids.runnerId,null),undefined);
    assert.throws(() => server.send(browser.id,{ commandId:randomUUID(),conversationId:created.conversationId,text:'After closure' }));
    assert.equal(server.snapshot().conversations.length,2);
  } finally { runner.close(); server.close(); rmSync(root,{ recursive:true,force:true }); }
});
