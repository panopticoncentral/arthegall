import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ServerStore } from '../apps/server/src/store.js';
import { createServer } from '../apps/server/src/server.js';
import { DailyBackups } from '../scripts/daily-backups.js';

test('Mac settings share browser records, enforce revision checks and attribute decisions to the paired client', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-native-settings-'));
  const store = new ServerStore(join(root, 'server', 'server.sqlite'));
  const { serverId, runnerId } = store.setup('synthetic');
  const mac = store.pair(store.createPairingCode(), 'fixture', Date.now(), 'app')!;
  const browser = store.pair(store.createPairingCode(), 'fixture')!;
  const { runId } = store.send(browser.id, { commandId: randomUUID(), text: 'Set up a usage report.' });
  const dm = store.reporting.create('Rowan', 'Draft reports.', 'Summarize usage.', runId);
  const { assignmentId } = store.reporting.assignment(dm);
  const host = 'localhost';
  const native = { host, 'x-arthegall-client': '1', authorization: 'Bearer ' + mac.token };
  const web = { host, origin: 'http://localhost', cookie: 'arthegall=' + browser.token };
  const backups = new DailyBackups(root, serverId, [join(root, 'server')], () => store.recovery.paused(), () => {});
  const server = await createServer(store, web.origin, undefined, backups);
  const post = (path: string, payload: Record<string, unknown>) =>
    server.inject({ method: 'POST', url: '/client/v1/' + path, headers: native, payload });
  const conversation = 'conversations/' + dm;
  try {
    const denied = await server.inject({ method: 'POST', url: '/client/v1/retention',
      headers: { ...web, 'x-arthegall-client': '1' }, payload: { days: 7 } });
    assert.equal(denied.statusCode, 401);
    assert.equal((await post('retention', { days: 7 })).statusCode, 200);
    assert.equal((await server.inject({ url: '/api/snapshot', headers: web })).json().retentionDays, 7);

    const edit = (instructions: string) => post(conversation + '/definition', { revision: 1, instructions });
    assert.equal((await edit('Lead with coverage.')).statusCode, 200);
    assert.equal((await edit('Stale edit.')).statusCode, 409);
    const page = (await server.inject({ url: '/api/' + conversation + '/settings', headers: web })).json();
    assert.equal(page.instructions, 'Lead with coverage.');
    assert.equal(page.history.length, 2);

    store.reporting.propose(assignmentId, runnerId, 'fixture');
    const snapshot = (await server.inject({ url: '/client/v1/snapshot', headers: native })).json();
    assert.equal(snapshot.settingsVersion, 1);
    const [grant] = snapshot.grants;
    assert.equal(grant.assignmentId, assignmentId);
    assert.equal(grant.runnerId, runnerId);
    assert.equal((await post('access/' + grant.id, { decision: 'accept', duration: 'run' })).statusCode, 200);
    assert.equal(store.db.prepare('SELECT session_id FROM report_access WHERE id=?').pluck().get(grant.id), mac.id);
    assert.equal((await post(conversation + '/schedule', { activeId: null, time: '08:00', backfill: false })).statusCode, 200);
    const schedule = store.db.prepare('SELECT id FROM report_schedules WHERE proposed_by=?').pluck().get(mac.id);
    assert.ok(schedule);
    const decision = '/schedules/' + schedule;
    assert.equal((await server.inject({ method: 'POST', url: '/api' + decision, headers: web, payload: { decision: 'accept' } })).statusCode, 200);
    assert.equal((await post('schedules/' + schedule, { decision: 'decline' })).statusCode, 409);
    assert.equal((await post(conversation + '/close', {})).statusCode, 200);
    assert.equal(store.reporting.assignment(dm).closed, 1);

    store.recovery.initialize();
    assert.equal((await post('retention', { days: 3 })).statusCode, 409);
    const destination = join(root, 'backups');
    assert.equal((await post('backups/settings', { destination, keep: 3, enabled: true })).statusCode, 200);
    assert.equal((await post('backups/retry', {})).statusCode, 200);
    const status = (await server.inject({ url: '/api/snapshot', headers: web })).json().backups;
    assert.equal(status.destination, destination);
    assert.equal(status.keep, 3);
    assert.equal(status.enabled, true);
  } finally {
    await server.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
