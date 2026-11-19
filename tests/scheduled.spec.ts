import { test, expect, chromium } from '@playwright/test';
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

for (const live of [false, true]) test(`${live ? 'Live Codex' : 'Synthetic'} scheduled deliveries after upgrade with browser closed`, async () => {
  test.skip(live && process.env.ARTHEGALL_LIVE_CODEX !== '1', 'Opt in to real Codex calls');
  test.setTimeout(480_000);
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
  const app = await createServer(store, origin, resolve('dist/web'));
  await app.listen({ host: '127.0.0.1', port });
  if (!live) writeFileSync(join(root, 'mode'), 'scheduled');
  const work = join(root, 'work');
  const runner = await startRunner(local, { token: old.runnerToken, runnerId: old.ids.runner, serverUrl: origin, workspaceRoot: work, usageRoots: old.roots,
    ...(!live ? { rpcFactory: (workspace: string) => new CodexRpc(process.execPath, [resolve('dist/tests/fixtures/provider.js'), root], workspace) } : {}) });
  const open = () => chromium.launchPersistentContext(join(root, 'browser'));
  let browser = await open();
  const completed = () => store.db.prepare(`SELECT o.due_date,o.period,r.id,m.id AS message,m.text,c.evidence,d.payload FROM report_occurrences o
    JOIN runs r ON r.id=o.run_id JOIN report_context c ON c.run_id=r.id JOIN dispatches d ON d.run_id=r.id JOIN messages m ON m.id=r.assistant_message_id
    WHERE r.state='completed' AND m.conversation_id=? ORDER BY o.due_date`).all(old.dm) as {
      due_date: string; period: string; id: string; message: string; text: string; evidence: string; payload: string }[];
  try {
    await browser.addCookies([{ url: origin, name: 'arthegall', value: old.browserToken, expires: Math.floor(Date.now()/1000)+3600, httpOnly: true }]);
    let page = await browser.newPage();
    await page.goto(origin);
    await page.getByLabel('Message Administrator', { exact: true }).fill('Schedule Rowan’s existing usage report every morning at 8:00 AM Pacific. Use the default catch-up policy.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Recurring reporting access requested' })).toBeVisible({ timeout: 90_000 });
    await expect(page.locator('.approval')).toContainText('08:00 America/Los_Angeles');
    await page.getByRole('button', { name: 'Allow recurring reports' }).click();
    await expect(page.locator('.approval')).toHaveCount(0);
    await browser.close();
    clock = new Date('2020-06-15T15:00:00Z');
    await expect.poll(() => completed().length, { timeout: 140_000 }).toBe(1);
    const first = completed()[0]!;
    expect(first.period).toBe('2020-06-14');
    expect(JSON.parse(first.evidence).codex.total).toBe(34);
    browser = await open(); page = await browser.newPage(); await page.goto(origin);
    await page.getByRole('button', { name: 'Rowan', exact: true }).click();
    await expect(page.getByText('Earlier synthetic report', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Reply to report' }).last().click();
    await page.getByLabel('Message Rowan', { exact: true }).fill('Put source coverage first from now on.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect.poll(() => store.db.prepare('SELECT count(*) FROM report_preferences').pluck().get(), { timeout: 90_000 }).toBe(1);
    await browser.close();
    clock = new Date('2020-06-16T15:00:00Z');
    await expect.poll(() => completed().length, { timeout: 140_000 }).toBe(2);
    const [earlier, second] = completed();
    expect(earlier).toEqual(first);
    expect(second!.period).toBe('2020-06-15');
    expect(JSON.parse(second!.evidence).codex.total).toBe(35);
    const contexts = completed().map(row => JSON.parse(row.payload).context);
    expect(contexts[0].preference).toBeUndefined();
    expect(contexts[1].preference.instructions).toMatch(/coverage/i);
    expect(contexts[1].assignmentInstructions).toContain('Report Codex and Claude');
    const coveragePosition = second!.text.search(/coverage|local records|sources? (checked|available)/i);
    expect(coveragePosition).toBeGreaterThanOrEqual(0);
    expect(coveragePosition).toBeLessThan(180);
    expect(second!.text.indexOf('35')).toBeGreaterThan(coveragePosition);
    const reply = store.db.prepare(`SELECT p.revision,c.reply_to FROM report_preferences p JOIN report_context c ON c.run_id=p.source_run
      WHERE p.assignment_id=?`).get(old.assignment);
    expect(reply).toEqual({ revision: 1, reply_to: first.id });
    for (const row of completed()) {
      expect(existsSync(join(work, old.assignment, 'runs', row.id))).toBe(true);
      expect(local.execution(row.id).payload).toBe(row.payload);
      const receipt = local.db.prepare("SELECT id FROM deliveries WHERE run_id=? AND json_extract(payload,'$.event.kind')='outcome'").pluck().get(row.id);
      expect(store.db.prepare('SELECT 1 FROM delivery_receipts WHERE runner_id=? AND delivery_id=?').pluck().get(old.ids.runner, receipt)).toBe(1);
      await expect.poll(() => local.db.prepare('SELECT acknowledged FROM deliveries WHERE id=?').pluck().get(receipt)).toBe(1);
    }
    expect(local.execution(first.id).thread_id).toBeTruthy();
    expect(local.execution(second!.id).thread_id).toBeTruthy();
    expect(local.execution(second!.id).thread_id).not.toBe(local.execution(first.id).thread_id);
    expect(local.execution(old.run).thread_id).toBe('prior-report-thread');
    browser = await open(); page = await browser.newPage(); await page.goto(origin);
    await page.getByRole('button', { name: 'Rowan', exact: true }).click();
    await expect(page.locator('.message-text').last()).toHaveText(second!.text);
    expect(store.db.prepare('SELECT evidence FROM report_context WHERE run_id=?').pluck().get(old.run)).toBe(old.evidence);
  } finally {
    await browser.close(); await runner.close(); await app.close(); store.close(); local.close(); rmSync(root, { recursive: true, force: true });
  }
});
