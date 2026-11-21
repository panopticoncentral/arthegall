import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ServerStore } from '../apps/server/src/store.js';
import { RunnerStore } from '../apps/runner/src/store.js';
import { dueAt } from '../apps/server/src/scheduler.js';
import { readUsage } from '../apps/runner/src/usage.js';
import { reportingUpgrade } from './helpers/reporting-upgrade.js';

test('Pacific due times across short, long, missing and repeated local hours', () => {
  const instant = (date: string, time: string) => new Date(dueAt(Temporal.PlainDate.from(date), time)).toISOString();
  assert.equal(instant('2020-03-07','08:00'), '2020-03-07T16:00:00.000Z');
  assert.equal(instant('2020-03-08','08:00'), '2020-03-08T15:00:00.000Z');
  assert.equal(instant('2020-03-08','02:30'), '2020-03-08T10:30:00.000Z');
  assert.equal(instant('2020-10-31','08:00'), '2020-10-31T15:00:00.000Z');
  assert.equal(instant('2020-11-01','08:00'), '2020-11-01T16:00:00.000Z');
  assert.equal(instant('2020-11-01','01:30'), '2020-11-01T08:30:00.000Z');
});

for (const backfill of [false, true]) test(`offline runner catches up after restart, backfill=${backfill}`, async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-clock-'));
  const old = await reportingUpgrade(root);
  let now = new Date('2020-03-09T14:59:59Z'); // Monday 07:59:59 PDT
  const open = () => new ServerStore(old.serverPath, () => now);
  let server = open(), runner = new RunnerStore(old.runnerPath, old.ids.runner);
  const next = () => server.nextDispatch(old.ids.runner);
  try {
    assert.equal(server.session(old.browserToken), old.session);
    server.send(old.session, { commandId: randomUUID(), text: 'Propose a schedule' });
    const admin = next()!;
    const proposal = { tool: 'schedule_usage_report', args: { name: 'Rowan', time: '08:00', ...(backfill ? { backfill } : {}) } };
    const result = server.adminOperation(old.ids.runner, admin.context.runId, proposal);
    assert('access' in result && result.access === 'requires user approval');
    assert.deepEqual(server.adminOperation(old.ids.runner, admin.context.runId, proposal), result);
    server.receive(old.ids.runner, { type: 'delivery', version: 1, runId: admin.context.runId, deliveryId: randomUUID(), sequence: 1, event: { kind: 'outcome', outcome: { status: 'completed', message: 'Proposed' } } });
    const schedule = String(server.db.prepare('SELECT id FROM report_schedules').pluck().get());
    now = new Date('2020-03-09T15:00:00Z');
    assert.equal(next(), undefined); // The existing on-demand grant cannot schedule a run.
    server.scheduler.decide(schedule, old.session, true);
    server.scheduler.decide(schedule, old.session, true);
    assert.throws(() => server.scheduler.decide(schedule, old.session, false));
    server.close();
    now = new Date('2020-03-11T21:00:00Z');
    server = open();
    const dates = backfill ? ['08','09','10'] : ['10'];
    for (const day of dates) {
      const dispatch = next()!, run = dispatch.context.runId;
      assert.equal(dispatch.context.occurrence!.scheduleId, schedule);
      const period = '2020-03-' + day;
      assert.deepEqual(dispatch.context.range, { start: period, end: period });
      assert.equal(dispatch.context.access?.duration, 'recurring');
      runner.accept(dispatch); runner.accept(next());
      server.accept(old.ids.runner, dispatch.dispatchId);
      runner.start(run);
      const evidence = await readUsage(dispatch.context.range!, old.roots);
      runner.publish(run, { kind: 'usage', report: evidence });
      runner.finish(run, { status: 'completed', message: 'Synthetic report for ' + period });
      for (const kind of ['usage','outcome']) {
        const delivery = runner.nextDelivery()!;
        assert.equal(delivery.event.kind, kind);
        server.receive(old.ids.runner, delivery); // ACK is lost after commit.
        server.close(); runner.close(); server = open(); runner = new RunnerStore(old.runnerPath, old.ids.runner);
        assert.deepEqual(runner.nextDelivery(), delivery);
        server.receive(old.ids.runner, delivery);
        runner.acknowledge(delivery.deliveryId);
      }
    }
    assert.equal(next(), undefined);
    assert.equal(next(), undefined);
    const rows = server.db.prepare('SELECT due_date,period,run_id IS NULL AS skipped FROM report_occurrences ORDER BY due_date').all();
    assert.deepEqual(rows, ['09','10','11'].map((day, index) => ({ due_date: '2020-03-' + day,
      period: '2020-03-' + ['08','09','10'][index], skipped: Number(!backfill && index !== 2) })));
    assert.equal(server.db.prepare("SELECT count(*) FROM messages WHERE author='assistant' AND text LIKE 'Synthetic report for %'").pluck().get(), dates.length);
    server.reporting.closeAssignment(old.dm, old.session);
    now = new Date('2020-03-12T15:00:00Z');
    assert.equal(next(), undefined);
    assert.deepEqual(server.db.pragma('foreign_key_check'), []);
  } finally { server.close(); runner.close(); rmSync(root, { recursive: true, force: true }); }
});
