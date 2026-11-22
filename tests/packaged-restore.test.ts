// This drill runs the same CLI and services operators use. Set ARTHEGALL_PACKAGE_PATH
// to exercise the bundled runtime, server and runner.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeTestClient, pairNative, setupCode, waitFor, waitForServer } from './helpers/native-client.js';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, cpSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { dailyCopy } from '../scripts/daily-copy.js';
import { availablePort } from './helpers/port.js';
import { reportingUpgrade } from './helpers/reporting-upgrade.js';
import { ServerStore } from '../apps/server/src/store.js';
import { RunnerStore } from '../apps/runner/src/store.js';

test('rotated daily backup restores acknowledged reports and preserves a paired client',
  { timeout: 180_000, skip: process.platform === 'win32' }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'arthegall-restore-')));
  const prior = await reportingUpgrade(root);
  const port = await availablePort(), origin = 'http://127.0.0.1:' + port;
  for (const role of ['server','runner']) {
    mkdirSync(join(root,role)); renameSync(join(root,role + '.sqlite'),join(root,role,role + '.sqlite'));
  }
  const config = { runnerId: prior.ids.runner, token: prior.runnerToken, port, origin };
  writeFileSync(join(root,'local.json'),JSON.stringify(config));
  const provider = join(root,'provider');
  writeFileSync(provider, '#!/usr/bin/env node\nprocess.argv[2]=' + JSON.stringify(root) + ';\nimport(' +
    JSON.stringify(pathToFileURL(resolve('dist/tests/fixtures/provider.js')).href) + ');\n', { mode: 0o700 });
  writeFileSync(join(root,'mode'),'scheduled');
  const env = { ...process.env, ARTHEGALL_DATA_DIR: root, ARTHEGALL_CODEX_BIN: provider,
    CODEX_HOME: prior.roots.codex, CLAUDE_CONFIG_DIR: prior.roots.claude };
  const pkg = process.env.ARTHEGALL_PACKAGE_PATH;
  const bin = pkg ? join(pkg,'bin','arthegall') : process.execPath;
  const args = pkg ? [] : [resolve('dist/scripts/arthegall.js')];
  const cli = (...command: string[]) => execFileSync(bin,[...args,...command],{ env,stdio:'pipe' });
  const children = new Set<ChildProcess>();
  function launch(role: string) {
    const child = spawn(bin,[...args,role],{env,stdio:'ignore'}); children.add(child); return child;
  }
  async function stop(child: ChildProcess) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child,'exit'); child.kill('SIGTERM'); await exited;
    }
    children.delete(child);
  }
  const path = join(root,'server','server.sqlite'), localPath = join(root,'runner','runner.sqlite');
  function query(sql: string, ...params: unknown[]) {
    const db = new Database(path,{readonly:true});
    try { return db.prepare(sql).all(...params); } finally { db.close(); }
  }
  const report = () => query(`SELECT o.run_id,o.due_at,r.state,r.user_message_id,r.assistant_message_id,m.conversation_id,m.text,c.evidence,d.id AS dispatch_id
    FROM scheduled_occurrences o JOIN runs r ON r.id=o.run_id JOIN messages m ON m.id=r.assistant_message_id
    JOIN report_context c ON c.run_id=r.id JOIN dispatches d ON d.run_id=r.id ORDER BY o.due_at`) as {run_id:string;state:string;assistant_message_id:string;conversation_id:string;period:string;text:string;evidence:string}[];
  const destination = join(root,'daily'), offline = join(root,'disconnected');
  mkdirSync(destination);
  const manual = join(destination,'operator-snapshot');
  let backup: string;
  let local: RunnerStore | undefined;
  try {
    const seed = new ServerStore(path);
    const pairing = seed.pair(seed.createPairingCode(), 'synthetic-installed-client')!;
    const client = new NativeTestClient(origin, pairing.token);
    const pinnedTrace = 'Synthetic retained provider trace';
    const history = new Database(localPath);
    try {
      history.prepare('UPDATE executions SET text=?,turn_id=? WHERE run_id=?').run(pinnedTrace,'synthetic-pinned-turn',prior.run);
    } finally { history.close(); }
    seed.reporting.event('activity',{runId:prior.run,message:pinnedTrace});
    // Two earlier days make the packaged scheduler rotate on its first real tick.
    for (const day of ['2020-01-01','2020-01-02']) await dailyCopy({ root, destination, keep: 2, day,
      serverId: prior.ids.server, protectedPaths: [] });
    cli('backup',manual);
    renameSync(destination,offline);
    const due = Temporal.Now.zonedDateTimeISO('America/Los_Angeles').add({seconds:78}).with({second:0,millisecond:0,microsecond:0,nanosecond:0});
    seed.scheduler.operate(prior.assignment, prior.ids.runner, { tool: 'schedule_item', args: {
      instruction: 'Report usage for the previous Pacific calendar day.', missed: 'latest',
      when: { kind: 'cron', expression: `${due.minute} ${due.hour} * * *`, timeZone: 'America/Los_Angeles' } } });
    seed.close();
    let server = launch('server');
    await waitForServer(origin);
    const retired = await fetch(origin + '/api/snapshot', { headers: { Cookie: 'arthegall=' + prior.browserToken } });
    assert.equal(retired.status, 404);
    assert.equal((await fetch(origin)).status, 404);
    const earlier = (await client.snapshot()).messages.find(message => message.text === 'Earlier synthetic report');
    assert(earlier?.evidence);
    assert.deepEqual(earlier.evidence, JSON.parse(prior.evidence));
    const fresh = await pairNative(origin, setupCode(cli('pair').toString()));
    assert.notEqual(fresh.sessionId, pairing.id);
    assert.deepEqual((await new NativeTestClient(origin, fresh.token).snapshot()).messages, (await client.snapshot()).messages);
    assert.deepEqual(query(`SELECT access.session_id FROM report_access access
      JOIN browser_sessions session ON session.id=access.session_id WHERE access.id=?`, prior.grant), [{ session_id: prior.session }]);
    await client.post('backups/settings', { enabled: true, destination, keep: 2 });
    const failure = await waitFor('backup error', async () => (await client.snapshot()).backups?.error);
    assert.equal((await client.snapshot()).backups?.error, failure);
    const catalog = new Database(join(root,'server','daily-backups.sqlite'),{readonly:true});
    try {
      const copies = () => catalog.prepare('SELECT day,name FROM copies WHERE sha256 IS NOT NULL ORDER BY day').all() as {day:string;name:string}[];
      const before = copies();
      assert.deepEqual(before.map(c=>c.day), ['2020-01-01','2020-01-02']);
      for (const c of before) assert.equal(existsSync(join(offline,c.name,'manifest.json')), true);
      renameSync(offline,destination);
      await client.post('backups/retry');
      await waitFor('rotated backup', async () => {
        const status = (await client.snapshot()).backups;
        return status && !status.running && !status.error && status.lastPath;
      });
      const kept = copies();
      assert.deepEqual(kept.map(c=>c.day), ['2020-01-02',Temporal.Now.plainDateISO().toString()]);
      assert.equal(existsSync(join(destination,before[0]!.name)), false);
      assert.equal(existsSync(join(manual,'manifest.json')), true);
      backup = join(destination,kept[1]!.name);
      assert.equal((await client.snapshot()).backups?.lastPath, backup);
    } finally { catalog.close(); }
    assert(Date.now() < due.epochMilliseconds);
    assert.deepEqual(report(), []);
    // Pin AFTER the backup. Restoring that snapshot must preserve the hold.
    await client.post('runs/' + prior.run + '/pin', { pinned: true });
    assert.equal((await client.snapshot()).runs.find(run => run.id === prior.run)?.pinned, 1);
    assert.equal((await client.snapshot()).retentionDays, 30);
    const period = due.subtract({days:1}).toPlainDate().toString();
    mkdirSync(join(prior.roots.codex,'sessions'),{recursive:true});
    writeFileSync(join(prior.roots.codex,'sessions','fixture.jsonl'),JSON.stringify({timestamp:period+'T20:00:00Z',type:'token_usage_record',
      payload:{response_id:'synthetic-response',usage:{input_tokens:8,output_tokens:5,total_tokens:13}}}));
    let runner = launch('runner');
    await waitFor('first scheduled report', () => report()[0]?.state === 'completed', 90_000);
    const original = report()[0]!;
    assert.equal(original.conversation_id, prior.dm);
    assert.equal(original.text, 'Synthetic total: 13');
    local = new RunnerStore(localPath,prior.ids.runner);
    await waitFor('the runner to acknowledge all deliveries', () => !local!.nextDelivery());
    // Materialize the following day's occurrence with the same scheduler at an
    // advanced clock. The running packaged runner executes the queued dispatch.
    const nextDue = (query('SELECT next_due FROM scheduled_items')[0] as {next_due:number}).next_due;
    const nextDay = new ServerStore(path,()=>new Date(nextDue));
    try { nextDay.scheduler.tick(); assert(nextDay.nextDispatch(prior.ids.runner)?.context.scheduledItem); } finally { nextDay.close(); }
    await waitFor('second scheduled report', () => report()[1]?.state === 'completed');
    const second = report()[1]!;
    const completedReports = [original,second];
    await client.post('runs/' + second.run_id + '/pin', { pinned: true });
    assert.equal((await client.snapshot()).runs.find(run => run.id === second.run_id)?.pinned, 1);
    const pinnedFile = join(root,'workspaces',prior.assignment,'runs',second.run_id,'intermediate.txt');
    writeFileSync(pinnedFile,'Synthetic pinned workspace evidence');
    await waitFor('the runner to acknowledge all deliveries', () => !local!.nextDelivery());
    const fullDetails = () => ({
      execution:local!.execution(second.run_id), file:readFileSync(pinnedFile,'utf8'),
      deliveries:local!.db.prepare('SELECT * FROM deliveries WHERE run_id=? ORDER BY position').all(second.run_id),
      receipts:query("SELECT * FROM delivery_receipts WHERE json_extract(payload,'$.runId')=? ORDER BY delivery_id",second.run_id)
    });
    const pinnedDetails = fullDetails();
    assert(pinnedDetails.execution.thread_id);
    assert(pinnedDetails.execution.turn_id);
    const providerRuns = () => readFileSync(join(root,'scheduled-executions'),'utf8').trim().split('\n');
    assert.deepEqual(providerRuns(), completedReports.map(r=>r.run_id));
    const receipts = () => query("SELECT * FROM delivery_receipts WHERE json_extract(payload,'$.runId')=? ORDER BY delivery_id",original.run_id);
    const beforePruning = receipts() as {delivery_id:string;payload:string}[];
    const originalDetail = beforePruning.map(row=>JSON.parse(row.payload)).find(d=>['progress','activity'].includes(d.event.kind));
    assert(originalDetail);
    const workspace = join(root,'workspaces',prior.assignment,'runs',original.run_id);
    writeFileSync(join(workspace,'intermediate.txt'),'Synthetic temporary execution evidence');
    // Age these isolated closed runs, then exercise normal automatic cleanup
    // by shortening the policy from 30 days to 2 through the paired client.
    const aging = new Database(path);
    try { aging.prepare('UPDATE run_history SET closed_at=? WHERE run_id IN (?,?,?)')
      .run(Date.now()-5*86_400_000,prior.run,original.run_id,second.run_id); } finally { aging.close(); }
    await client.post('retention', { days: 2 });
    await waitFor('unpin cleanup', () =>
      query('SELECT phase FROM run_history WHERE run_id=?', original.run_id).some(row => (row as { phase: string }).phase === 'pruned'));
    assert.equal(existsSync(workspace), false);
    assert.equal(local.execution(original.run_id).turn_id, null);
    const originalReceipts = receipts() as {delivery_id:string;payload:string}[];
    assert.deepEqual(originalReceipts.map(row=>row.delivery_id), beforePruning.map(row=>row.delivery_id));
    assert.equal(originalReceipts.some(row=>JSON.parse(row.payload).kind==='history_receipt'), true);
    const pinnedEvidence = () => ({
      detail:local!.execution(prior.run), trace:query("SELECT data FROM events WHERE kind='activity' AND json_extract(data,'$.runId')=?",prior.run),
      report:query('SELECT evidence FROM report_context WHERE run_id=?',prior.run),
      hold:query('SELECT pinned,phase FROM run_history WHERE run_id=?',prior.run)
    });
    const preserved = pinnedEvidence();
    assert.equal(preserved.detail.text, pinnedTrace);
    assert.equal(preserved.detail.turn_id, 'synthetic-pinned-turn');
    assert.equal(preserved.trace.length, 1);
    assert.deepEqual(preserved.hold, [{pinned:1,phase:'full'}]);
    assert.deepEqual(report(), completedReports);
    assert.deepEqual(fullDetails(), pinnedDetails);
    const progress = () => query('SELECT id,next_due FROM scheduled_items');
    const originalProgress = progress();
    await stop(runner); await stop(server);

    // Advance the installed scheduler by one local day while services are stopped.
    // Today's completed report is now in the newest archive. Restore yesterday's.
    const { DailyBackups } = await import(pathToFileURL(resolve(pkg ?? '.', 'dist/scripts/daily-backups.js')).href) as typeof import('../scripts/daily-backups.js');
    let clock = new Date();
    const scheduler = new DailyBackups(root,prior.ids.server,[],()=>false,()=>{},()=>clock);
    let newest: string;
    try {
      clock = new Date(scheduler.status().nextDue!);
      await scheduler.tick();
      assert.equal(scheduler.status().error, null);
      newest = scheduler.status().lastPath!;
      assert.notEqual(newest, backup);
      const retained = new Database(join(root,'server','daily-backups.sqlite'),{readonly:true});
      try {
        assert.deepEqual(retained.prepare('SELECT name FROM copies WHERE sha256 IS NOT NULL ORDER BY day').pluck().all(),
          [backup.split(/[\\/]/).at(-1),newest.split(/[\\/]/).at(-1)]);
      } finally { retained.close(); }
      assert.equal(existsSync(join(backup,'manifest.json')), true);
      const archived = new Database(join(newest,'server.sqlite'),{readonly:true});
      try { assert.deepEqual(archived.prepare('SELECT run_id FROM scheduled_occurrences ORDER BY due_at').pluck().all(), completedReports.map(r=>r.run_id)); }
      finally { archived.close(); }
    } finally { await scheduler.close(); }
    const bad = join(root,'corrupt'); cpSync(backup,bad,{recursive:true});
    writeFileSync(join(bad,'server.sqlite'),'synthetic corruption');
    assert.throws(() => cli('restore', bad), /checksum/);
    assert.deepEqual(report(), completedReports);
    assert.deepEqual(fullDetails(), pinnedDetails);
    cli('restore',backup);
    server = launch('server');
    await waitForServer(origin);
    const paused = await client.snapshot();
    assert.equal(paused.backups?.lastPath, newest);
    assert.equal(paused.backups?.keep, 2);
    assert.equal(paused.recovery?.runners[0]?.status, 'offline');
    assert.equal(paused.recovery?.ready, false);
    assert.deepEqual(report(), []);

    // Replay just the header and first event for the newer run, then lose the server.
    const ws = new WebSocket(origin.replace('http:','ws:')+'/runner',{headers:{Authorization:'Bearer '+prior.runnerToken,'X-Arthegall-Runner':prior.ids.runner}});
    const journal = local.inventory();
    let unexpectedDispatch = false;
    ws.on('message',raw=>{
      const frame = JSON.parse(raw.toString());
      if (frame.type === 'dispatch') unexpectedDispatch = true;
      if (frame.type !== 'inventory_next') return;
      const item = journal.next().value;
      const entry = item?.kind === 'delivery' ? item.delivery : item?.kind === 'history_receipt' ? item : undefined;
      if (item && !(entry && entry.runId === original.run_id && entry.sequence > 1))
        ws.send(JSON.stringify({type:'inventory',version:1,item}));
    });
    await once(ws,'open');
    ws.send(JSON.stringify({type:'hello',version:1,runnerId:prior.ids.runner,inventoryVersion:1}));
    await waitFor('partial inventory receipt', () => receipts().length === 1);
    await stop(server); ws.terminate();
    server = launch('server');
    await waitForServer(origin);
    assert.equal((await client.snapshot()).recovery?.runners[0]?.status, 'offline');
    runner = launch('runner');
    await waitFor('runner reconciliation', async () => (await client.snapshot()).recovery?.ready);
    assert.deepEqual(pinnedEvidence(), preserved);
    assert.equal((await client.snapshot()).retentionDays, 2);
    assert.deepEqual(query('SELECT pinned,phase FROM run_history WHERE run_id=?',second.run_id), [{pinned:1,phase:'full'}]);
    assert.deepEqual(query('SELECT phase FROM run_history WHERE run_id=?',original.run_id), [{phase:'pruned'}]);
    assert.equal(unexpectedDispatch, false);
    assert.deepEqual(report(), completedReports);
    assert.deepEqual(fullDetails(), pinnedDetails);
    assert.deepEqual(receipts(), originalReceipts);
    assert.deepEqual(progress(), originalProgress);
    const recovered = await client.snapshot();
    const saved = recovered.messages.filter(message => message.id === original.assistant_message_id);
    assert.equal(saved.length, 1);
    assert.equal(saved[0]?.text, original.text);
    assert.equal(saved[0]?.evidence?.codex.total, 13);
    assert.deepEqual(saved[0]?.evidence, JSON.parse(original.evidence));
    assert.equal(recovered.runs.find(run => run.id === prior.run)?.pinned, 1);
    assert.equal(recovered.runs.find(run => run.id === original.run_id)?.history, 'pruned');

    // Accept a targeted reply while paused, then verify the original report link.
    const reply = await client.send(prior.dm, 'Which synthetic sources had records?', original.assistant_message_id);
    assert.deepEqual(query('SELECT reply_to FROM report_context WHERE run_id=?', reply.runId), [{ reply_to: original.run_id }]);
    assert.equal(local.db.prepare('SELECT count(*) FROM executions').pluck().get(), 3);
    await client.post('recovery/recheck');
    await waitFor('runner reconciliation', async () => (await client.snapshot()).recovery?.ready);
    assert.deepEqual(receipts(), originalReceipts);
    // Model a lost receipt after recovery. Ordinary delivery must also deduplicate.
    local.db.prepare("UPDATE deliveries SET acknowledged=0 WHERE run_id=? AND json_extract(payload,'$.event.kind')='outcome'").run(original.run_id);
    assert.equal(readFileSync(join(root,'calls'),'utf8').split('\n').filter(x=>x==='turn/start').length, 2);
    await client.post('recovery/resume');
    await waitFor('the recovered outcome receipt', () => local!.nextDelivery()?.runId !== original.run_id);
    assert.deepEqual(report(), completedReports);
    assert.deepEqual(fullDetails(), pinnedDetails);
    assert.deepEqual(receipts(), originalReceipts);
    assert.deepEqual(providerRuns(), completedReports.map(r=>r.run_id));
    assert.equal(local.db.prepare('SELECT count(*) FROM executions WHERE run_id=?').pluck().get(original.run_id), 1);
    const replyRun = await waitFor('completed reply to the recovered report', async () =>
      (await client.snapshot()).runs.find(run => run.id === reply.runId && run.state === 'completed'));
    assert.equal((await client.snapshot()).messages.find(message => message.id === replyRun.messageId)?.text, 'Saved your preference.');
    assert.deepEqual(query('SELECT session_id FROM command_receipts WHERE run_id=?', reply.runId), [{ session_id: pairing.id }]);
    await stop(runner); await stop(server);

    // Now remove the matching execution from the synthetic runner only. The
    // older server has evidence for this run; the disagreement must stay visible.
    cli('restore',backup);
    local.db.prepare('DELETE FROM deliveries WHERE run_id=?').run(prior.run);
    local.db.prepare('DELETE FROM executions WHERE run_id=?').run(prior.run);
    server = launch('server'); runner = launch('runner');
    await waitForServer(origin);
    const issue = await waitFor('missing runner execution', async () => (await client.snapshot()).recovery?.issues.find(row => row.runId === prior.run));
    assert.match(issue.reason, /no matching execution/);
    assert.equal((await client.snapshot()).recovery?.ready, false);
    assert.equal(query('SELECT reason FROM restore_issues WHERE run_id=?',prior.run).length, 1);
  } finally {
    for (const child of [...children].reverse()) await stop(child);
    local?.close(); rmSync(root,{recursive:true,force:true});
  }
});
