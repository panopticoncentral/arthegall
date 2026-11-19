// This drill runs the same CLI and services operators use. Set ARTHEGALL_PACKAGE_PATH
// to exercise the bundled runtime, server, runner and web assets.
import { test, expect } from '@playwright/test';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, cpSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import Database from 'better-sqlite3';
import WebSocket from 'ws';
import { availablePort } from './helpers/port.js';
import { reportingUpgrade } from './helpers/reporting-upgrade.js';
import { ServerStore } from '../apps/server/src/store.js';
import { RunnerStore } from '../apps/runner/src/store.js';

test('server-only restore recovers an acknowledged occurrence through the paired DM', async ({ page }) => {
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
    JOIN report_context c ON c.run_id=r.id JOIN dispatches d ON d.run_id=r.id`) as {run_id:string;state:string;assistant_message_id:string;conversation_id:string;period:string;text:string;evidence:string}[];
  const backup = join(root,'snapshot');
  let local: RunnerStore | undefined;
  try {
    const seed = new ServerStore(path);
    const due = Temporal.Now.zonedDateTimeISO('America/Los_Angeles').add({seconds:68}).with({second:0,millisecond:0,microsecond:0,nanosecond:0});
    const time = due.toPlainTime().toString({smallestUnit:'minute'});
    seed.scheduler.propose(prior.assignment,prior.ids.runner,time,false,prior.run);
    seed.scheduler.decide(String(seed.db.prepare('SELECT id FROM report_schedules').pluck().get()),prior.session,true);
    seed.close();
    let server = launch('server');
    await expect.poll(async () => fetch(origin).then(r=>r.status).catch(()=>0)).toBe(200);
    cli('backup',backup);
    expect(Date.now()).toBeLessThan(due.epochMilliseconds);
    expect(report()).toEqual([]);
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
    const receipts = () => query("SELECT * FROM delivery_receipts WHERE json_extract(payload,'$.runId')=? ORDER BY delivery_id",original.run_id);
    const originalReceipts = receipts();
    const progress = () => query('SELECT id,next_date,next_due FROM report_schedules');
    const originalProgress = progress();
    await stop(runner); await stop(server);

    const bad = join(root,'corrupt'); cpSync(backup,bad,{recursive:true});
    writeFileSync(join(bad,'server.sqlite'),'synthetic corruption');
    expect(()=>cli('restore',bad)).toThrow(/checksum/);
    expect(report()).toEqual([original]);
    cli('restore',backup);
    server = launch('server');
    await expect.poll(async () => fetch(origin).then(r=>r.status).catch(()=>0)).toBe(200);
    await page.context().addCookies([{url:origin,name:'arthegall',value:prior.browserToken,httpOnly:true}]);
    await page.goto(origin);
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
      if (item && !(item.kind === 'delivery' && item.delivery.runId === original.run_id && item.delivery.sequence > 1))
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
    expect(unexpectedDispatch).toBe(false);
    expect(report()).toEqual([original]);
    expect(receipts()).toEqual(originalReceipts);
    expect(progress()).toEqual(originalProgress);
    await page.getByRole('button',{name:'Rowan',exact:true}).click();
    await page.reload();
    const recovered = page.getByRole('article').filter({hasText:original.text});
    await expect(recovered).toHaveCount(1);
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
    expect(local.db.prepare('SELECT count(*) FROM executions').pluck().get()).toBe(2);
    await page.getByRole('button',{name:'Check runners again'}).click();
    await expect(page.getByRole('button',{name:'Resume dispatch'})).toBeEnabled();
    expect(receipts()).toEqual(originalReceipts);
    // Model a lost receipt after recovery. Ordinary delivery must also deduplicate.
    local.db.prepare("UPDATE deliveries SET acknowledged=0 WHERE run_id=? AND json_extract(payload,'$.event.kind')='outcome'").run(original.run_id);
    expect(readFileSync(join(root,'calls'),'utf8').split('\n').filter(x=>x==='turn/start')).toHaveLength(1);
    await page.getByRole('button',{name:'Resume dispatch'}).click();
    await expect.poll(()=>local!.nextDelivery()?.runId).not.toBe(original.run_id);
    expect(report()).toEqual([original]);
    expect(receipts()).toEqual(originalReceipts);
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
