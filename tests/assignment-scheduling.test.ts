import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { migrations } from '../apps/server/src/migrations.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { ServerStore } from '../apps/server/src/store.js';
import { createServer } from '../apps/server/src/server.js';
import { RunnerStore } from '../apps/runner/src/store.js';
import { startRunner } from '../apps/runner/src/runner.js';
import { CodexRpc } from '../apps/runner/src/codex/rpc.js';
import { reportingUpgrade } from './helpers/reporting-upgrade.js';
import { availablePort } from './helpers/port.js';
import { NativeTestClient, pairNative, waitFor } from './helpers/native-client.js';

test('agent schedules through MCP, server fires offline after restart, runner executes each wake once', { timeout: 45_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-agent-schedule-'));
  const old = await reportingUpgrade(root);
  const port = await availablePort(), origin = 'http://127.0.0.1:' + port;
  let now = new Date('2020-06-15T15:00:00Z');
  const open = () => new ServerStore(old.serverPath, () => now);
  let store = open();
  const serve = async () => {
    const app = await createServer(store, origin);
    await app.listen({ host: '127.0.0.1', port });
    return app;
  };
  let app = await serve();
  const local = new RunnerStore(old.runnerPath, old.ids.runner);
  const connect = () => startRunner(local, { runnerId: old.ids.runner, token: old.runnerToken, serverUrl: origin,
    workspaceRoot: join(root, 'work'), rpcFactory: workspace => new CodexRpc(process.execPath, [resolve('dist/tests/fixtures/provider.js'), root], workspace) });
  writeFileSync(join(root, 'mode'), 'followups');
  let runner: Awaited<ReturnType<typeof connect>> | undefined = await connect();
  const count = (state: string) => store.db.prepare('SELECT count(*) FROM scheduled_occurrences WHERE state=?').pluck().get(state);
  try {
    const paired = await pairNative(origin, store.createPairingCode());
    const client = new NativeTestClient(origin, paired.token);
    const { runId } = await client.send(old.dm, 'Arrange the release follow-ups.');
    const response = await waitFor('the non-administrator agent to create, edit, cancel and list its items', () =>
      store.db.prepare("SELECT m.text FROM runs r JOIN messages m ON m.id=r.assistant_message_id WHERE r.id=? AND r.state='completed'").pluck().get(runId) as string);
    const { check, summary, items } = JSON.parse(response);
    assert.deepEqual(items.map((item: {instruction: string}) => item.instruction).sort(), ['Check the build', 'Send weekday summary']);
    assert.equal(check.nextDue, '2020-06-15T15:05:00.000Z');
    assert.equal(items.find((item: {id: string}) => item.id === summary.id).nextDue, '2020-06-16T00:00:00.000Z');
    await runner.close(); runner = undefined;
    await app.close(); store.close();
    store = open(); app = await serve();
    now = new Date('2020-06-15T15:05:00Z');
    await waitFor('durable occurrence with runner disconnected', () => count('queued') === 1);
    assert.equal(count('dispatched'), 0);
    // Restart again with a due occurrence already in the delivery queue.
    await app.close(); store.close();
    store = open(); app = await serve();
    now = new Date('2020-06-16T00:00:00Z');
    await waitFor('both due instructions, excluding cancelled ticket', () => count('queued') === 2);
    runner = await connect();
    await waitFor('two completed follow-ups', () => store.db.prepare(`SELECT count(*) FROM scheduled_occurrences o
      JOIN runs r ON r.id=o.run_id WHERE r.state='completed'`).pluck().get() === 2);
    const wakes = readFileSync(join(root, 'wakeups'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(wakes.map(row => [row.instruction, row.wake.id, row.wake.dueAt, row.access]), [
      ['Check the build', check.id, '2020-06-15T15:05:00.000Z', 'assignment'],
      ['Send weekday summary', summary.id, '2020-06-16T00:00:00.000Z', 'assignment'],
    ]);
    assert.equal(count('queued'), 0);
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
  } finally {
    await runner?.close(); await app.close(); store.close(); local.close(); rmSync(root, { recursive: true, force: true });
  }
});

test('missed cron occurrences, assignment isolation and closing pending work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-cron-'));
  const old = await reportingUpgrade(root);
  let now = new Date('2020-03-06T17:00:00Z');
  const store = new ServerStore(old.serverPath, () => now);
  const schedule = store.scheduler;
  try {
    const create = (missed: 'latest' | 'all') => {
      const result = schedule.operate(old.assignment, old.ids.runner, { tool: 'schedule_item',
        args: { instruction: 'Follow up', when: { kind: 'cron', expression: '0 9 * * MON-FRI', timeZone: 'America/Los_Angeles' }, missed } });
      assert('id' in result);
      // First Monday after the daylight-saving transition.
      assert.equal(result.nextDue, '2020-03-09T16:00:00.000Z');
      return result.id;
    };
    const latest = create('latest'), all = create('all');
    assert.throws(() => schedule.operate(old.ids.assignment, old.ids.runner, { tool: 'cancel_scheduled_item', args: { id: latest } }), /this assignment/);
    const states = (id: string) => store.db.prepare('SELECT state FROM scheduled_occurrences WHERE item_id=? ORDER BY due_at').pluck().all(id);
    now = new Date('2020-03-09T16:00:00Z'); schedule.tick();
    assert.deepEqual(states(latest), ['queued']);
    now = new Date('2020-03-11T16:00:00Z'); schedule.tick(); schedule.tick();
    assert.deepEqual(states(latest), ['skipped','skipped','queued']);
    assert.deepEqual(states(all), ['queued','queued','queued']);
    for (const [expression,timeZone] of [['* *', 'UTC'], ['0 9 * * *', 'Unknown/Place']] as const) {
      assert.throws(() => schedule.operate(old.assignment, old.ids.runner, { tool: 'change_scheduled_item', args: {
        id: latest, instruction: 'Invalid change', when: { kind: 'cron', expression, timeZone }, missed: 'latest' } }), /valid cron/);
    }
    const delivered = new Map([[latest, [] as string[]], [all, [] as string[]]]);
    for (let i = 0; i < 4; i++) {
      const { context } = store.nextDispatch(old.ids.runner)!;
      const wake = context.scheduledItem!;
      delivered.get(wake.id)!.push(wake.dueAt);
      store.receive(old.ids.runner, { type: 'delivery', version: 1, deliveryId: randomUUID(), runId: context.runId, sequence: 1,
        event: { kind: 'outcome', outcome: { status: 'completed', message: 'Synthetic follow-up' } } });
    }
    assert.deepEqual(delivered.get(latest), ['2020-03-11T16:00:00.000Z']);
    assert.deepEqual(delivered.get(all), ['2020-03-09T16:00:00.000Z','2020-03-10T16:00:00.000Z','2020-03-11T16:00:00.000Z']);
    now = new Date('2020-03-12T16:00:00Z'); schedule.tick();
    store.reporting.closeAssignment(old.dm, old.session);
    assert.deepEqual(states(latest), ['skipped','skipped','dispatched','cancelled']);
    assert.deepEqual(states(all), ['dispatched','dispatched','dispatched','cancelled']);
    now = new Date('2020-03-13T16:00:00Z'); schedule.tick();
    assert.equal(store.nextDispatch(old.ids.runner), undefined);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('upgrade removes active and pending report schedules without promoting their approvals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-schedule-upgrade-'));
  const old = await reportingUpgrade(root);
  const db = new Database(old.serverPath);
  const active = randomUUID(), pending = randomUUID();
  const due = Date.parse('2020-03-08T10:30:00Z'); // 02:30 Pacific shifts across the spring gap.
  try {
    for (const migration of migrations.filter(m => m.version > 2 && m.version <= 6)) db.exec(migration.sql);
    db.pragma('user_version=6');
    const insert = db.prepare(`INSERT INTO report_schedules(id,assignment_id,runner_id,time,backfill,source_run,state,session_id,next_date,next_due)
      VALUES (?,?,?,?,?,?,?,?,?,?)`);
    insert.run(active, old.assignment, old.ids.runner, '02:30', 1, old.run, 'active', old.session, '2020-03-08', due);
    insert.run(pending, old.assignment, old.ids.runner, '08:00', 0, old.run, 'pending', null, null, null);
  } finally { db.close(); }
  const store = new ServerStore(old.serverPath, () => new Date(due));
  try {
    assert.equal(store.db.prepare('SELECT COUNT(*) FROM scheduled_items').pluck().get(), 0);
    store.scheduler.tick();
    assert.equal(store.nextDispatch(old.ids.runner), undefined);
    assert.equal(store.db.prepare("SELECT count(*) FROM sqlite_schema WHERE name IN ('report_occurrences','report_schedules')").pluck().get(), 0);
    assert.equal(store.reporting.grant(old.assignment,old.ids.runner,null)?.approvalId, old.grant);
    assert.deepEqual(store.db.pragma('foreign_key_check'), []);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
