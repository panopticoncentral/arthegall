import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ServerStore } from '../apps/server/src/store.js';
import { createServer } from '../apps/server/src/server.js';
import { RunnerStore } from '../apps/runner/src/store.js';
import type { Scan } from '../apps/server/src/restore-recovery.js';
import { RunActivityPage } from '../packages/contracts/src/index.js';
import { reportingUpgrade } from './helpers/reporting-upgrade.js';

test('paired Mac run activity, pin changes and restore decisions share the server journal and pause', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-native-recovery-'));
  const prior = await reportingUpgrade(root);
  const store = new ServerStore(prior.serverPath);
  const runner = new RunnerStore(prior.runnerPath, prior.ids.runner);
  const server = await createServer(store, 'http://localhost');
  const mac = store.pair(store.createPairingCode(), 'fixture')!;
  const headers = { host: 'localhost', authorization: 'Bearer ' + mac.token, 'x-arthegall-client': '1' };
  const runPath = '/client/v1/runs/' + prior.run;
  const write = (url: string, payload: object = {}) => server.inject({ method: 'POST', url, headers, payload });
  const snapshot = async () => (await server.inject({ url: '/client/v1/snapshot', headers })).json();
  try {
    assert.equal((await snapshot()).recoveryVersion, 1);
    for (let i = 0; i < 62; ++i) store.reporting.event('activity', { runId: prior.run, message: `Synthetic activity ${i}` });
    store.reporting.event('progress', { runId: prior.run });
    store.reporting.event('activity', { runId: randomUUID(), message: 'An unrelated synthetic run' });
    assert.equal((await server.inject({ url: runPath + '/activity', headers: { ...headers, authorization: '' } })).statusCode, 401);
    const page = RunActivityPage.parse((await server.inject({ url: runPath + '/activity', headers })).json());
    assert.equal(page.events.length, 50);
    assert.equal(page.events[0]?.detail, 'Synthetic activity 61');
    const older = RunActivityPage.parse((await server.inject({ url: runPath + '/activity?before=' + page.nextBefore, headers })).json());
    assert.deepEqual([...page.events, ...older.events].map(row => row.detail),
      Array.from({ length: 62 }, (_, i) => `Synthetic activity ${61 - i}`));
    assert.equal(older.nextBefore, null);

    assert.equal((await write(runPath + '/pin', { pinned: true })).statusCode, 200);
    assert.equal((await snapshot()).runs[0].pinned, 1);
    assert.equal((await write(runPath + '/pin', { pinned: false })).statusCode, 200);
    assert.equal((await snapshot()).runs[0].pinned, 0);

    store.recovery.initialize();
    const resume = '/client/v1/recovery/resume';
    assert.equal((await write(runPath + '/pin', { pinned: true })).statusCode, 409);
    assert.equal((await write(resume)).statusCode, 409);
    assert.equal((await write('/client/v1/recovery/recheck')).statusCode, 200);
    store.recovery.begin(prior.ids.runner);
    store.recovery.apply(prior.ids.runner, { received: 0, failed: false }, { kind: 'end' });
    assert.match((await snapshot()).recovery.issues[0].reason, /no matching execution/);
    assert.equal((await write(resume)).statusCode, 409);
    store.recovery.begin(prior.ids.runner);
    const scan: Scan = { received: 0, failed: false };
    for (const item of runner.inventory()) store.recovery.apply(prior.ids.runner, scan, item);
    assert.equal((await snapshot()).recovery.ready, true);
    assert.equal((await write(resume)).statusCode, 200);
    assert.equal((await snapshot()).recovery, null);
  } finally {
    await server.close();
    runner.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
