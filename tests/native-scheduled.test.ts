import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeTestClient, pairNative, waitFor } from './helpers/native-client.js';
import { ReportingSettings } from '../packages/contracts/src/reporting.js';
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { availablePort } from './helpers/port.js';
import { reportingUpgrade } from './helpers/reporting-upgrade.js';
import { ServerStore } from '../apps/server/src/store.js';
import { RunnerStore } from '../apps/runner/src/store.js';
import { startRunner } from '../apps/runner/src/runner.js';
import { createServer } from '../apps/server/src/server.js';
import { CodexRpc } from '../apps/runner/src/codex/rpc.js';

for (const live of [false, true]) test(`${live ? 'Live Codex' : 'Synthetic'} scheduled deliveries after upgrade without a connected client`,
  { skip: live && process.env.ARTHEGALL_LIVE_CODEX !== '1', timeout: live ? 480_000 : 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-scheduled-'));
  const old = await reportingUpgrade(root);
  mkdirSync(join(old.roots.codex, 'sessions'), { recursive: true });
  const records = [14, 15].map(day => JSON.stringify({ timestamp: `2020-06-${day}T18:00:00Z`, type: 'token_usage_record',
    payload: { response_id: 'synthetic-' + day, usage: { input_tokens: 20, cached_input_tokens: 2, output_tokens: day, total_tokens: 20 + day } } }));
  writeFileSync(join(old.roots.codex, 'sessions', 'fixture.jsonl'), records.join('\n'));
  let clock = new Date('2020-06-15T14:59:00Z');
  const store = new ServerStore(old.serverPath, () => clock);
  const local = new RunnerStore(old.runnerPath, old.ids.runner);
  const port = await availablePort(), origin = 'http://127.0.0.1:' + port;
  const app = await createServer(store, origin);
  await app.listen({ host: '127.0.0.1', port });
  if (!live) writeFileSync(join(root, 'mode'), 'scheduled');
  const work = join(root, 'work');
  const runner = await startRunner(local, { token: old.runnerToken, runnerId: old.ids.runner, serverUrl: origin, workspaceRoot: work, usageRoots: old.roots,
    ...(!live ? { rpcFactory: (workspace: string) => new CodexRpc(process.execPath, [resolve('dist/tests/fixtures/provider.js'), root], workspace) } : {}) });
  const completed = () => store.db.prepare(`SELECT o.due_date,o.period,r.id,m.id AS message,m.text,c.evidence,d.payload FROM report_occurrences o
    JOIN runs r ON r.id=o.run_id JOIN report_context c ON c.run_id=r.id JOIN dispatches d ON d.run_id=r.id JOIN messages m ON m.id=r.assistant_message_id
    WHERE r.state='completed' AND m.conversation_id=? ORDER BY o.due_date`).all(old.dm) as {
      due_date: string; period: string; id: string; message: string; text: string; evidence: string; payload: string }[];
  try {
    const paired = await pairNative(origin, store.createPairingCode());
    const client = new NativeTestClient(origin, paired.token);
    await client.send(old.ids.conversation, 'Schedule Rowan’s existing usage report every morning at 8:00 AM Pacific. Use the default catch-up policy.');
    const schedule = await waitFor('recurring access request', async () => (await client.snapshot()).schedules.find(item => item.state === 'pending'), 90_000);
    assert.equal(schedule.time, '08:00');
    assert.equal(schedule.assignmentId, old.assignment);
    assert.equal(schedule.runnerId, old.ids.runner);
    await client.post('schedules/' + schedule.id, { decision: 'accept' });
    assert.equal((await client.snapshot()).schedules[0]?.state, 'active');

    // No event subscription or client request during delivery.
    clock = new Date('2020-06-15T15:00:00Z');
    const first = await waitFor('the first scheduled delivery', () => completed()[0], 140_000);
    assert.equal(first.period, '2020-06-14');
    assert.equal(JSON.parse(first.evidence).codex.total, 34);
    assert((await client.snapshot()).messages.some(message => message.conversationId === old.dm && message.text === 'Earlier synthetic report'));
    const preferenceRun = await client.send(old.dm, 'Put source coverage first from now on.', first.message);
    await waitFor('the saved preference', () => store.db.prepare('SELECT count(*) FROM report_preferences').pluck().get() === 1, 90_000);
    clock = new Date('2020-06-16T15:00:00Z');
    await waitFor('the second scheduled delivery', () => completed().length === 2, 140_000);
    const [earlier, second] = completed();
    assert.deepEqual(earlier, first);
    assert.equal(second!.period, '2020-06-15');
    assert.equal(JSON.parse(second!.evidence).codex.total, 35);
    const contexts = completed().map(row => JSON.parse(row.payload).context);
    assert.equal(contexts[0].preference, undefined);
    assert.match(contexts[1].preference.instructions, /coverage/i);
    assert(contexts[1].assignmentInstructions.includes('Report Codex and Claude'));
    const coveragePosition = second!.text.search(/coverage|local records|sources? (checked|available)/i);
    assert(coveragePosition >= 0);
    assert(coveragePosition < 180);
    assert(second!.text.indexOf('35') > coveragePosition);
    const reply = store.db.prepare(`SELECT p.revision,c.reply_to FROM report_preferences p JOIN report_context c ON c.run_id=p.source_run
      WHERE p.assignment_id=?`).get(old.assignment);
    assert.deepEqual(reply, { revision: 1, reply_to: first.id });
    for (const row of completed()) {
      assert.equal(existsSync(join(work, old.assignment, 'runs', row.id)), true);
      assert.equal(local.execution(row.id).payload, row.payload);
      const receipt = local.db.prepare("SELECT id FROM deliveries WHERE run_id=? AND json_extract(payload,'$.event.kind')='outcome'").pluck().get(row.id);
      assert.equal(store.db.prepare('SELECT 1 FROM delivery_receipts WHERE runner_id=? AND delivery_id=?').pluck().get(old.ids.runner, receipt), 1);
      await waitFor('acknowledged report outcome', () => local.db.prepare('SELECT acknowledged FROM deliveries WHERE id=?').pluck().get(receipt) === 1);
    }
    assert(local.execution(first.id).thread_id);
    assert(local.execution(second!.id).thread_id);
    assert.notEqual(local.execution(second!.id).thread_id, local.execution(first.id).thread_id);
    assert.equal(local.execution(old.run).thread_id, 'prior-report-thread');
    const current = await client.snapshot();
    const report = current.messages.find(message => message.id === second!.message);
    assert.equal(report?.text, second!.text);
    assert.deepEqual(report?.evidence, JSON.parse(second!.evidence));
    const response = await fetch(origin + '/client/v1/conversations/' + old.dm + '/settings', { headers: client.headers });
    assert.equal(response.status, 200);
    const settings = ReportingSettings.parse(await response.json());
    assert.match(settings.preference?.instructions ?? '', /coverage/i);
    const source = store.db.prepare('SELECT user_message_id FROM runs WHERE id=?').pluck().get(preferenceRun.runId);
    assert.equal(settings.preference?.messageId, source);
    assert.equal(store.db.prepare('SELECT evidence FROM report_context WHERE run_id=?').pluck().get(old.run), old.evidence);
  } finally {
    await runner.close(); await app.close(); store.close(); local.close(); rmSync(root, { recursive: true, force: true });
  }
});
