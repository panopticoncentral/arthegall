import { availablePort } from './helpers/port.js';
import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

test('live Codex administrator retains context after runner and server restart', async ({ page }) => {
  test.skip(process.env.ARTHEGALL_LIVE_CODEX !== '1', 'Explicit opt-in required for model calls');
  test.setTimeout(360_000);
  const root = mkdtempSync(join(tmpdir(), 'arthegall-live-test-'));
  const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ARTHEGALL_DATA_DIR: root, ARTHEGALL_PORT: String(port) };
  const cli = resolve('dist/scripts/arthegall.js');
  const setup = execFileSync(process.execPath, [cli, 'setup'], { env, encoding: 'utf8' });
  const code = setup.match(/minutes\): (\S+)/)?.[1];
  if (!code) throw new Error('Pairing code missing');
  const launch = (command: string) => spawn(process.execPath, [cli, command, ...(command === 'runner' ? ['--approval-exercise'] : [])], { env, stdio: 'ignore' });
  const stop = async (child: ChildProcess) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once('close', resolve));
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try { await closed; } finally { clearTimeout(timer); }
  };
  let server = launch('server'), runner = launch('runner');
  try {
    await expect.poll(async () => { try { return (await fetch(origin)).status; } catch { return 0; } }).toBe(200);
    await page.goto(origin);
    await page.getByLabel('Pairing code').fill(code);
    await page.getByRole('button', { name: 'Pair browser' }).click();
    const composer = page.getByLabel('Message Administrator', { exact: true });
    await composer.fill('Remember the synthetic phrase cobalt meadow. Reply with just that phrase and report the completed outcome.');
    await composer.press('Enter');
    const completed = page.locator('.message').filter({ hasText: 'Administrator' }).filter({ hasText: 'cobalt meadow' });
    await expect(completed).toHaveCount(1, { timeout: 90_000 });
    await expect(page.locator('.message-state').filter({ hasText: 'Responding' })).toHaveCount(0);
    await stop(runner); await stop(server);
    server = launch('server'); runner = launch('runner');
    await expect(page.getByRole('status')).not.toContainText('Server unavailable');
    await composer.fill('What was the synthetic phrase? Reply only with those two words and report the completed outcome.');
    await composer.press('Enter');
    await expect(completed).toHaveCount(2, { timeout: 90_000 });
    const db = new Database(join(root, 'runner', 'runner.sqlite'), { readonly: true });
    try {
      await expect.poll(() => (db.prepare("SELECT count(*) AS n FROM executions WHERE state='done'").get() as { n: number }).n).toBe(2);
      const rows = db.prepare('SELECT model,effort,thread_id FROM executions ORDER BY rowid').all() as { model: string; effort: string; thread_id: string }[];
      expect(rows[0]?.thread_id).toBe(rows[1]?.thread_id);
      expect(rows.every((row) => row.model && row.effort)).toBe(true);
      for (const decision of ['Approve once', 'Decline']) {
        await composer.fill('/test native approval');
        await composer.press('Enter');
        await expect(page.getByRole('heading', { name: 'Approval needed' })).toBeVisible({ timeout: 90_000 });
        const run = db.prepare('SELECT run_id,payload,thread_id FROM executions ORDER BY rowid DESC LIMIT 1').get() as { run_id: string; payload: string; thread_id: string };
        expect(run.thread_id).not.toBe(rows[0]?.thread_id);
        const assignmentId = JSON.parse(run.payload).context.assignmentId as string;
        const filename = join(root, 'workspaces', assignmentId, `approval-note-${run.run_id}.txt`);
        expect(existsSync(filename)).toBe(false);
        // The provider remains active across refresh; the exact pending request is restored.
        await page.reload();
        await expect(page.getByRole('heading', { name: 'Approval needed' })).toBeVisible();
        await page.getByRole('button', { name: decision, exact: true }).click();
        await expect.poll(() => (db.prepare('SELECT state FROM executions WHERE run_id=?').get(run.run_id) as { state: string }).state, { timeout: 90_000 }).toBe('done');
        await expect(page.getByRole('heading', { name: 'Approval needed' })).toHaveCount(0);
        if (decision === 'Approve once') expect(readFileSync(filename, 'utf8')).toBe('synthetic');
        else expect(existsSync(filename)).toBe(false);
        expect((db.prepare('SELECT thread_id FROM sessions WHERE assignment_id=?').get(assignmentId) as { thread_id: string }).thread_id).toBe(rows[0]?.thread_id);
      }
      await composer.fill('Write a numbered list of 150 invented two-word garden names. Then report the entire list as the completed outcome.');
      await composer.press('Enter');
      await expect(page.locator('.message-state').filter({ hasText: 'Responding' })).toBeVisible({ timeout: 90_000 });
      const active = db.prepare('SELECT run_id,text FROM executions ORDER BY rowid DESC LIMIT 1').get() as { run_id: string; text: string };
      expect(active.text.length).toBeGreaterThan(0);
      await page.reload();
      await expect.poll(() => (db.prepare('SELECT state FROM executions WHERE run_id=?').get(active.run_id) as { state: string }).state, { timeout: 90_000 }).toBe('done');
      await expect(page.locator('.message')).toHaveCount(10);
      await expect(page.locator('.message-state').filter({ hasText: 'Responding' })).toHaveCount(0);
    } finally { db.close(); }
  } finally { await stop(runner); await stop(server); rmSync(root, { recursive: true, force: true }); }
});
