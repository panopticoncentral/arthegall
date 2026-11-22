// Run after npm run build. The backup and all server, runner and Mac state are isolated.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as controlServer } from 'node:http';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';
import { createServer } from '../dist/apps/server/src/server.js';
import { ServerStore } from '../dist/apps/server/src/store.js';
import { RunnerStore } from '../dist/apps/runner/src/store.js';
import { startRunner } from '../dist/apps/runner/src/runner.js';
import { CodexRpc } from '../dist/apps/runner/src/codex/rpc.js';
import { availablePort } from '../dist/tests/helpers/port.js';
import { reportingUpgrade } from '../dist/tests/helpers/reporting-upgrade.js';
import { buildProbe, macTestEnvironment, run, runMacUI } from './helpers/mac-test.mjs';

const uiEnvironment = macTestEnvironment('tests/mac-recovery.mjs');
const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), 'arthegall-mac-recovery-'));
const backup = join(root, 'backup');
const serverPath = join(root, 'server', 'server.sqlite');
const runnerPath = join(root, 'runner', 'runner.sqlite');
const controllerPath = '/' + randomUUID();
let clock = new Date('2020-06-15T14:59:00Z');
let prior, store, server, local, runner, report, cleanup;

const controller = controlServer(async (request, response) => {
  if (request.method !== 'POST' || !request.url?.startsWith(controllerPath + '/')) {
    response.writeHead(404).end();
    return;
  }
  try {
    const result = await advance(request.url.slice(controllerPath.length + 1));
    response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result ?? {}));
  } catch (error) {
    response.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: error.message }));
  }
});

try {
  prior = await reportingUpgrade(root);
  mkdirSync(join(root, 'server'));
  mkdirSync(join(root, 'runner'));
  renameSync(prior.serverPath, serverPath);
  renameSync(prior.runnerPath, runnerPath);
  writeFileSync(join(root, 'local.json'), JSON.stringify({ runnerId: prior.ids.runner, token: prior.runnerToken, port, origin }), { mode: 0o600 });
  writeFileSync(join(root, 'mode'), 'scheduled');
  mkdirSync(join(prior.roots.codex, 'sessions'), { recursive: true });
  writeFileSync(join(prior.roots.codex, 'sessions', 'synthetic.jsonl'), JSON.stringify({ timestamp: '2020-06-14T18:00:00Z',
    type: 'token_usage_record', payload: { response_id: 'synthetic', usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: 14, total_tokens: 34 } } }));

  await openServer();
  store.reporting.event('activity', { runId: prior.run, message: 'Synthetic retained provider trace.' });
  store.scheduler.operate(prior.assignment, prior.ids.runner, { tool: 'schedule_item', args: {
    instruction: 'Report usage for the previous Pacific calendar day.', missed: 'latest',
    when: { kind: 'cron', expression: '0 8 * * *', timeZone: 'America/Los_Angeles' } } });
  await openRunner(runnerPath);
  controller.listen(0, '127.0.0.1');
  await once(controller, 'listening');
  const bundle = 'org.arthegall.fixture.t' + randomUUID();
  const manifest = join(root, 'fixture.json');
  const priorMessage = store.snapshot().runs.find(run => run.id === prior.run).messageId;
  writeFileSync(manifest, JSON.stringify({ origin, bundle, code: store.createPairingCode(), dm: prior.dm,
    priorRun: prior.run, priorMessage, controller: `http://127.0.0.1:${controller.address().port}${controllerPath}` }), { mode: 0o600 });
  if (uiEnvironment) await runMacUI('RecoveryTests', bundle, manifest, uiEnvironment);
  else {
    const executable = buildProbe(root, bundle, 'MacRecoveryProbe');
    await run(executable, [manifest, 'prepare']);
    await advance('restore');
    await run(executable, [manifest, 'recover']);
  }

  assert.deepEqual(completedReport(), report);
  assert.equal(store.snapshot().runs.find(run => run.id === report.runId).pinned, 1);
  assert.equal(store.recovery.paused(), false);
  const command = store.db.prepare(`SELECT c.reply_to AS runId, json_extract(q.payload,'$.replyTo') AS messageId
    FROM report_preferences p JOIN report_context c ON c.run_id=p.source_run
    JOIN command_receipts q ON q.run_id=p.source_run WHERE p.assignment_id=?`).get(prior.assignment);
  assert.deepEqual(command, { runId: report.runId, messageId: report.messageId });
  assert.equal(store.db.prepare('SELECT count(*) FROM scheduled_occurrences').pluck().get(), 1);
  assert.equal(store.snapshot().runs.find(run => run.id === prior.run).history, 'pruned');
  assert.equal(store.reporting.settings(prior.dm).instructions, 'Synthetic instructions from the second client.');
  console.log('Verified CLI restore, runner recheck and resume, history cleanup, preserved report and pin, and a reply to the original report ID.');
} finally {
  if (controller.listening) await new Promise(resolve => controller.close(resolve));
  await closeServices();
  rmSync(root, { recursive: true, force: true });
}

function cli(command) {
  const pkg = process.env.ARTHEGALL_PACKAGE_PATH;
  const executable = pkg ? join(pkg, 'bin', 'arthegall') : process.execPath;
  const args = pkg ? [] : [resolve('dist/scripts/arthegall.js')];
  execFileSync(executable, [...args, command, backup], { env: { ...process.env, ARTHEGALL_DATA_DIR: root }, stdio: 'pipe' });
}

async function openServer() {
  store = new ServerStore(serverPath, () => clock);
  server = await createServer(store, origin);
  await server.listen({ host: '127.0.0.1', port });
}

async function openRunner(path) {
  local = new RunnerStore(path, prior.ids.runner);
  runner = await startRunner(local, { runnerId: prior.ids.runner, token: prior.runnerToken, serverUrl: origin,
    workspaceRoot: join(root, 'workspaces'), usageRoots: prior.roots,
    rpcFactory: workspace => new CodexRpc(process.execPath, [resolve('dist/tests/fixtures/provider.js'), root], workspace) });
}

async function closeRunner() {
  await runner?.close();
  runner = undefined;
  local?.close();
  local = undefined;
}

async function closeServices() {
  await closeRunner();
  await server?.close();
  server = undefined;
  store?.close();
  store = undefined;
}

function completedReport() {
  return store.db.prepare(`SELECT r.id AS runId, m.id AS messageId, m.text, c.evidence, d.id AS dispatchId
    FROM scheduled_occurrences o JOIN runs r ON r.id=o.run_id JOIN messages m ON m.id=r.assistant_message_id
    JOIN report_context c ON c.run_id=r.id JOIN dispatches d ON d.run_id=r.id WHERE r.state='completed'`).get();
}

async function until(description, predicate) {
  for (let i = 0; i < 200; ++i) {
    const result = predicate();
    if (result) return result;
    await sleep(100);
  }
  assert.fail(description);
}

async function advance(action) {
  switch (action) {
    case 'edit-from-second-client': {
      const second = store.pair(store.createPairingCode(), 'synthetic-second-client');
      assert(second);
      const response = await server.inject({ method: 'POST', url: `/client/v1/conversations/${prior.dm}/definition`,
        headers: { host: new URL(origin).host, 'x-arthegall-client': '1', authorization: 'Bearer ' + second.token },
        payload: { revision: 1, instructions: 'Synthetic instructions from the second client.' } });
      assert.equal(response.statusCode, 200);
      break;
    }
    case 'backup-and-deliver':
      cli('backup');
      clock = new Date('2020-06-15T15:00:00Z');
      report = await until('The scheduled report did not complete', completedReport);
      await until('The runner did not record the completed report acknowledgment', () => local.db.prepare(`SELECT acknowledged FROM deliveries
        WHERE run_id=? AND json_extract(payload,'$.event.kind')='outcome'`).pluck().get(report.runId) === 1);
      return { messageId: report.messageId, runId: report.runId };
    case 'restore':
      assert.equal(store.snapshot().runs.find(run => run.id === report.runId).pinned, 1);
      await closeServices();
      cli('restore');
      await openServer();
      assert.equal(completedReport(), undefined);
      assert.equal(store.recovery.status()?.ready, false);
      break;
    case 'connect-incomplete-runner':
      await openRunner(join(root, 'incomplete', 'runner.sqlite'));
      await until('The incomplete runner should leave an unresolved record', () => store.recovery.status()?.issues.length);
      break;
    case 'connect-intact-runner':
      await until('Check runners again did not start another inventory', () => store.db.prepare("SELECT count(*) FROM events WHERE kind='reconciliation_started'").pluck().get() >= 2);
      assert.equal(store.recovery.status()?.ready, false);
      await closeRunner();
      await openRunner(runnerPath);
      await until('The intact runner did not reconcile the restored snapshot', () => store.recovery.status()?.ready);
      assert.deepEqual(completedReport(), report);
      return { messageId: report.messageId, runId: report.runId };
    case 'prepare-cleanup':
      // Age only the earlier synthetic run so cleanup has a deterministic target.
      store.db.prepare('UPDATE run_history SET closed_at=? WHERE run_id=?').run(0, prior.run);
      cleanup = store.retention.next(prior.ids.runner);
      assert.equal(cleanup?.runId, prior.run);
      break;
    case 'finish-cleanup':
      await local.prune(cleanup, join(root, 'workspaces'));
      store.retention.result(prior.ids.runner, cleanup.runId, cleanup.dispatchId);
      break;
    default:
      throw new Error('Unknown recovery fixture action');
  }
}
