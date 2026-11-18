import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';

test('live Codex administrator retains context after runner and server restart', async ({ page }) => {
  test.skip(process.env.ARTHEGALL_LIVE_CODEX !== '1', 'Explicit opt-in required for model calls');
  test.setTimeout(180_000);
  const root = mkdtempSync(join(tmpdir(), 'arthegall-live-test-'));
  const port = 50_000 + Math.floor(Math.random() * 8_000), origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ARTHEGALL_DATA_DIR: root, ARTHEGALL_PORT: String(port) };
  const cli = resolve('dist/scripts/arthegall.js');
  const setup = execFileSync(process.execPath, [cli, 'setup'], { env, encoding: 'utf8' });
  const code = setup.match(/minutes\): (\S+)/)?.[1];
  if (!code) throw new Error('Pairing code missing');
  const launch = (command: string) => spawn(process.execPath, [cli, command], { env, stdio: 'ignore' });
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
    } finally { db.close(); }
  } finally { await stop(runner); await stop(server); rmSync(root, { recursive: true, force: true }); }
});
