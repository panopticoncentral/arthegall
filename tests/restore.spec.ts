// This drill runs the same CLI and services operators use. Set ARTHEGALL_PACKAGE_PATH
// to exercise the bundled runtime, server, runner and web assets.
import { test, expect } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, cpSync } from 'node:fs';
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

test('rotated daily backup restores an acknowledged occurrence through the paired DM', async ({ page }) => {
  test.setTimeout(180_000);
  const root = mkdtempSync(join(tmpdir(), 'arthegall-restore-'));
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
  const report = () => query(`SELECT o.*,r.state,r.user_message_id,r.assistant_message_id,m.conversation_id,m.text,c.evidence,d.id AS dispatch_id
    FROM report_occurrences o JOIN runs r ON r.id=o.run_id JOIN messages m ON m.id=r.assistant_message_id
    JOIN report_context c ON c.run_id=r.id JOIN dispatches d ON d.run_id=r.id ORDER BY o.due_date`) as {run_id:string;state:string;assistant_message_id:string;conversation_id:string;period:string;text:string;evidence:string}[];
  const destination = join(root,'daily'), offline = join(root,'disconnected');
  mkdirSync(destination);
  const manual = join(destination,'operator-snapshot');
  let backup: string;
  let local: RunnerStore | undefined;
  try {
    const seed = new ServerStore(path);
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
    const time = due.toPlainTime().toString({smallestUnit:'minute'});
    seed.scheduler.propose(prior.assignment,prior.ids.runner,time,false,prior.run);
    seed.scheduler.decide(String(seed.db.prepare('SELECT id FROM report_schedules').pluck().get()),prior.session,true);
    seed.close();
    let server = launch('server');
    await expect.poll(async () => fetch(origin).then(r=>r.status).catch(()=>0)).toBe(200);
    await page.context().addCookies([{url:origin,name:'arthegall',value:prior.browserToken,httpOnly:true}]);
    await page.goto(origin);
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.getByText('Daily server backups',{exact:false}).first().click();
    await page.getByLabel('Backup folder on the server').fill(destination);
    await page.getByLabel('Daily copies to keep').fill('2');
    await page.getByRole('button',{name:'Enable daily backups'}).click();
    await expect(page.getByRole('alert')).toContainText('Daily backup needs attention');
    await page.reload();
    await expect(page.getByRole('alert')).toContainText('Daily backup needs attention');
    const catalog = new Database(join(root,'server','daily-backups.sqlite'),{readonly:true});
    try {
      const copies = () => catalog.prepare('SELECT day,name FROM copies WHERE sha256 IS NOT NULL ORDER BY day').all() as {day:string;name:string}[];
      const before = copies();
      expect(before.map(c=>c.day)).toEqual(['2020-01-01','2020-01-02']);
      for (const c of before) expect(existsSync(join(offline,c.name,'manifest.json'))).toBe(true);
      renameSync(offline,destination);
      await page.getByRole('button',{name:'Back to conversation'}).click();
      await page.getByRole('button',{name:'Open backup settings'}).click();
      await page.getByRole('button',{name:'Retry daily backup'}).click();
      await expect(page.getByRole('alert')).toHaveCount(0);
      const kept = copies();
      expect(kept.map(c=>c.day)).toEqual(['2020-01-02',Temporal.Now.plainDateISO().toString()]);
      expect(existsSync(join(destination,before[0]!.name))).toBe(false);
      expect(existsSync(join(manual,'manifest.json'))).toBe(true);
      backup = join(destination,kept[1]!.name);
      await expect(page.getByText(/Last verified/)).toContainText(kept[1]!.name);
    } finally { catalog.close(); }
    expect(Date.now()).toBeLessThan(due.epochMilliseconds);
    expect(report()).toEqual([]);
    // Pin AFTER the backup. Restoring that snapshot must preserve the hold.
    await page.getByRole('button',{name:'Rowan',exact:true}).click();
    const pinnedReport = page.getByRole('article').filter({hasText:'Earlier synthetic report'});
    await pinnedReport.getByText('Run details',{exact:true}).click();
    await pinnedReport.getByRole('button',{name:'Pin run',exact:true}).click();
    await expect(pinnedReport.getByRole('button',{name:'Unpin run'})).toBeVisible();
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.locator('summary').filter({hasText:'Execution history'}).click();
    await expect(page.getByLabel('Days to keep completed run details')).toHaveValue('30');
    await page.getByRole('button',{name:'Back to conversation'}).click();
    const period = due.subtract({days:1}).toPlainDate().toString();
    mkdirSync(join(prior.roots.codex,'sessions'),{recursive:true});
    writeFileSync(join(prior.roots.codex,'sessions','fixture.jsonl'),JSON.stringify({timestamp:period+'T20:00:00Z',type:'token_usage_record',
      payload:{response_id:'synthetic-response',usage:{input_tokens:8,output_tokens:5,total_tokens:13}}}));
    let runner = launch('runner');
    await expect.poll(()=>report()[0]?.state,{timeout:90_000}).toBe('completed');
    const original = report()[0]!;
    expect(original.conversation_id).toBe(prior.dm);
    expect(original.text).toBe('Synthetic total: 13');
    local = new RunnerStore(localPath,prior.ids.runner);
    await expect.poll(()=>local!.nextDelivery()).toBeUndefined();
    // Materialize the following day's occurrence with the same scheduler at an
    // advanced clock. The running packaged runner executes the queued dispatch.
    const nextDue = (query('SELECT next_due FROM report_schedules')[0] as {next_due:number}).next_due;
    const nextDay = new ServerStore(path,()=>new Date(nextDue));
    try { expect(nextDay.nextDispatch(prior.ids.runner)?.context.occurrence).toBeTruthy(); } finally { nextDay.close(); }
    await expect.poll(()=>report()[1]?.state).toBe('completed');
    const second = report()[1]!;
    const completedReports = [original,second];
    const secondMessage = page.getByRole('article').filter({hasText:second.text});
    await secondMessage.getByText('Run details',{exact:true}).click();
    await secondMessage.getByRole('button',{name:'Pin run',exact:true}).click();
    await expect(secondMessage.getByRole('button',{name:'Unpin run'})).toBeVisible();
    const pinnedFile = join(root,'workspaces',prior.assignment,'runs',second.run_id,'intermediate.txt');
    writeFileSync(pinnedFile,'Synthetic pinned workspace evidence');
    await expect.poll(()=>local!.nextDelivery()).toBeUndefined();
    const fullDetails = () => ({
      execution:local!.execution(second.run_id), file:readFileSync(pinnedFile,'utf8'),
      deliveries:local!.db.prepare('SELECT * FROM deliveries WHERE run_id=? ORDER BY position').all(second.run_id),
      receipts:query("SELECT * FROM delivery_receipts WHERE json_extract(payload,'$.runId')=? ORDER BY delivery_id",second.run_id)
    });
    const pinnedDetails = fullDetails();
    expect(pinnedDetails.execution.thread_id).toBeTruthy();
    expect(pinnedDetails.execution.turn_id).toBeTruthy();
    const providerRuns = () => readFileSync(join(root,'scheduled-executions'),'utf8').trim().split('\n');
    expect(providerRuns()).toEqual(completedReports.map(r=>r.run_id));
    const receipts = () => query("SELECT * FROM delivery_receipts WHERE json_extract(payload,'$.runId')=? ORDER BY delivery_id",original.run_id);
    const beforePruning = receipts() as {delivery_id:string;payload:string}[];
    const originalDetail = beforePruning.map(row=>JSON.parse(row.payload)).find(d=>['progress','activity'].includes(d.event.kind));
    expect(originalDetail).toBeTruthy();
    const workspace = join(root,'workspaces',prior.assignment,'runs',original.run_id);
    writeFileSync(join(workspace,'intermediate.txt'),'Synthetic temporary execution evidence');
    // Age these isolated closed runs, then exercise normal automatic cleanup
    // by shortening the policy from 30 days to 2 in the paired operator UI.
    const aging = new Database(path);
    try { aging.prepare('UPDATE run_history SET closed_at=? WHERE run_id IN (?,?,?)')
      .run(Date.now()-5*86_400_000,prior.run,original.run_id,second.run_id); } finally { aging.close(); }
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.locator('summary').filter({hasText:'Execution history'}).click();
    await page.getByLabel('Days to keep completed run details').fill('2');
    await page.getByRole('button',{name:'Save history retention'}).click();
    await expect.poll(()=>query('SELECT phase FROM run_history WHERE run_id=?',original.run_id)).toEqual([{phase:'pruned'}]);
    expect(existsSync(workspace)).toBe(false);
    expect(local.execution(original.run_id).turn_id).toBeNull();
    const originalReceipts = receipts() as {delivery_id:string;payload:string}[];
    expect(originalReceipts.map(row=>row.delivery_id)).toEqual(beforePruning.map(row=>row.delivery_id));
    expect(originalReceipts.some(row=>JSON.parse(row.payload).kind==='history_receipt')).toBe(true);
    const pinnedEvidence = () => ({
      detail:local!.execution(prior.run), trace:query("SELECT data FROM events WHERE kind='activity' AND json_extract(data,'$.runId')=?",prior.run),
      report:query('SELECT evidence FROM report_context WHERE run_id=?',prior.run),
      hold:query('SELECT pinned,phase FROM run_history WHERE run_id=?',prior.run)
    });
    const preserved = pinnedEvidence();
    expect(preserved.detail.text).toBe(pinnedTrace);
    expect(preserved.detail.turn_id).toBe('synthetic-pinned-turn');
    expect(preserved.trace).toHaveLength(1);
    expect(preserved.hold).toEqual([{pinned:1,phase:'full'}]);
    expect(report()).toEqual(completedReports);
    expect(fullDetails()).toEqual(pinnedDetails);
    const progress = () => query('SELECT id,next_date,next_due FROM report_schedules');
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
      expect(scheduler.status().error).toBeNull();
      newest = scheduler.status().lastPath!;
      expect(newest).not.toBe(backup);
      const retained = new Database(join(root,'server','daily-backups.sqlite'),{readonly:true});
      try {
        expect(retained.prepare('SELECT name FROM copies WHERE sha256 IS NOT NULL ORDER BY day').pluck().all())
          .toEqual([backup.split(/[\\/]/).at(-1),newest.split(/[\\/]/).at(-1)]);
      } finally { retained.close(); }
      expect(existsSync(join(backup,'manifest.json'))).toBe(true);
      const archived = new Database(join(newest,'server.sqlite'),{readonly:true});
      try { expect(archived.prepare('SELECT run_id FROM report_occurrences ORDER BY due_date').pluck().all()).toEqual(completedReports.map(r=>r.run_id)); }
      finally { archived.close(); }
    } finally { await scheduler.close(); }
    const bad = join(root,'corrupt'); cpSync(backup,bad,{recursive:true});
    writeFileSync(join(bad,'server.sqlite'),'synthetic corruption');
    expect(()=>cli('restore',bad)).toThrow(/checksum/);
    expect(report()).toEqual(completedReports);
    expect(fullDetails()).toEqual(pinnedDetails);
    cli('restore',backup);
    server = launch('server');
    await expect.poll(async () => fetch(origin).then(r=>r.status).catch(()=>0)).toBe(200);
    await page.goto(origin);
    await page.getByRole('button',{name:'Settings',exact:true}).click();
    await page.locator('summary').filter({hasText:'Daily server backups'}).click();
    await expect(page.getByText(/Last verified/)).toContainText(newest);
    await expect(page.getByLabel('Daily copies to keep')).toHaveValue('2');
    await expect(page.getByText(/Offline — waiting for reconnect/)).toBeVisible();
    await expect(page.getByRole('button',{name:'Resume dispatch'})).toBeDisabled();
    expect(report()).toEqual([]);

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
    await expect.poll(()=>receipts().length).toBe(1);
    await stop(server); ws.terminate();
    server = launch('server');
    await expect(page.getByText(/Offline — waiting for reconnect/)).toBeVisible();
    runner = launch('runner');
    await expect(page.getByRole('button',{name:'Resume dispatch'})).toBeEnabled();
    expect(pinnedEvidence()).toEqual(preserved);
    await page.locator('summary').filter({hasText:'Execution history'}).click();
    await expect(page.getByLabel('Days to keep completed run details')).toHaveValue('2');
    expect(query('SELECT pinned,phase FROM run_history WHERE run_id=?',second.run_id)).toEqual([{pinned:1,phase:'full'}]);
    expect(query('SELECT phase FROM run_history WHERE run_id=?',original.run_id)).toEqual([{phase:'pruned'}]);
    expect(unexpectedDispatch).toBe(false);
    expect(report()).toEqual(completedReports);
    expect(fullDetails()).toEqual(pinnedDetails);
    expect(receipts()).toEqual(originalReceipts);
    expect(progress()).toEqual(originalProgress);
    await page.getByRole('button',{name:'Rowan',exact:true}).click();
    await page.reload();
    const recovered = page.getByRole('article').filter({hasText:original.text});
    await expect(recovered).toHaveCount(1);
    await expect(pinnedReport.getByText('Run details · Pinned')).toBeVisible();
    await recovered.getByText('Run details',{exact:true}).click();
    await expect(recovered.getByText('Detailed execution history pruned')).toBeVisible();
    await recovered.getByText('Original message text').click();
    expect(await recovered.locator('.original pre').textContent()).toBe(original.text);
    await recovered.getByText(/Recorded usage/).click();
    await expect(recovered.locator('.usage')).toContainText('13');
    await recovered.getByRole('button',{name:'Reply to report'}).click();
    expect(await page.evaluate(()=>sessionStorage.getItem('arthegall.reply'))).toBe(original.assistant_message_id);

    // A queued reply exercises the interactive dispatch gate during reconciliation.
    await page.getByLabel('Message Rowan',{exact:true}).fill('Which synthetic sources had records?');
    await page.getByRole('button',{name:'Queue message',exact:true}).click();
    await expect.poll(()=>query('SELECT reply_to FROM report_context WHERE reply_to=?',original.run_id)).toEqual([{reply_to:original.run_id}]);
    expect(local.db.prepare('SELECT count(*) FROM executions').pluck().get()).toBe(3);
    await page.getByRole('button',{name:'Check runners again'}).click();
    await expect(page.getByRole('button',{name:'Resume dispatch'})).toBeEnabled();
    expect(receipts()).toEqual(originalReceipts);
    // Model a lost receipt after recovery. Ordinary delivery must also deduplicate.
    local.db.prepare("UPDATE deliveries SET acknowledged=0 WHERE run_id=? AND json_extract(payload,'$.event.kind')='outcome'").run(original.run_id);
    expect(readFileSync(join(root,'calls'),'utf8').split('\n').filter(x=>x==='turn/start')).toHaveLength(2);
    await page.getByRole('button',{name:'Resume dispatch'}).click();
    await expect.poll(()=>local!.nextDelivery()?.runId).not.toBe(original.run_id);
    expect(report()).toEqual(completedReports);
    expect(fullDetails()).toEqual(pinnedDetails);
    expect(receipts()).toEqual(originalReceipts);
    expect(providerRuns()).toEqual(completedReports.map(r=>r.run_id));
    expect(local.db.prepare('SELECT count(*) FROM executions WHERE run_id=?').pluck().get(original.run_id)).toBe(1);
    await stop(runner); await stop(server);

    // Now remove the matching execution from the synthetic runner only. The
    // older server has evidence for this run; the disagreement must stay visible.
    cli('restore',backup);
    local.db.prepare('DELETE FROM deliveries WHERE run_id=?').run(prior.run);
    local.db.prepare('DELETE FROM executions WHERE run_id=?').run(prior.run);
    server = launch('server'); runner = launch('runner');
    await expect(page.getByText(new RegExp(prior.run+' .*Runner has no matching execution'))).toBeVisible();
    await expect(page.getByRole('button',{name:'Resume dispatch'})).toBeDisabled();
    expect(query('SELECT reason FROM restore_issues WHERE run_id=?',prior.run)).toHaveLength(1);
  } finally {
    for (const child of [...children].reverse()) await stop(child);
    local?.close(); rmSync(root,{recursive:true,force:true});
  }
});
