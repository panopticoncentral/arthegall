import { availablePort } from './helpers/port.js';
import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

test('packaged macOS user services retain a live conversation through stop/start and repeat setup', async ({ page }) => {
  test.skip(process.platform !== 'darwin' || !process.env.ARTHEGALL_PACKAGE_PATH || process.env.ARTHEGALL_LIVE_CODEX !== '1', 'Requires packaged macOS release and live-model opt-in');
  test.setTimeout(180_000);
  const root = mkdtempSync(join(tmpdir(), 'arthegall-install-'));
  const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
  const launcher = join(process.env.ARTHEGALL_PACKAGE_PATH!, 'bin', 'arthegall');
  const env = { ...process.env, ARTHEGALL_DATA_DIR: root, ARTHEGALL_PORT: String(port), ARTHEGALL_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents') };
  const command = (action: string) => execFileSync(launcher, [action], { env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const install = command('install');
    const code = install.match(/minutes\): (\S+)/)![1]!;
    await expect.poll(async () => { try { return (await fetch(origin)).status; } catch { return 0; } }).toBe(200);
    await expect.poll(() => command('status')).toContain('runner: running');
    const duplicate = (() => { try { command('runner'); return false; } catch { return true; } })();
    expect(duplicate).toBe(true);
    await page.goto(origin);
    await page.getByLabel('Pairing code').fill(code);
    await page.getByRole('button', { name: 'Pair browser' }).click();
    const composer = page.getByLabel('Message Administrator', { exact: true });
    await composer.fill('Remember the synthetic phrase silver willow. Report only that phrase as the completed outcome.');
    await composer.press('Enter');
    const replies = page.locator('.message').filter({ hasText: 'Administrator' }).filter({ hasText: 'silver willow' });
    await expect(replies).toHaveCount(1, { timeout: 90_000 });
    await expect(page.locator('.message-state').filter({ hasText: 'Responding' })).toHaveCount(0);
    command('stop');
    await expect(page.getByRole('status')).toContainText('Server unavailable');
    command('setup'); // Identities, history and browser cookie must survive this.
    command('install'); // Repeating installation reuses the immutable package.
    await expect(page.getByRole('status')).not.toContainText('Server unavailable');
    await composer.fill('What was the synthetic phrase? Report just those two words as the completed outcome.');
    await composer.press('Enter');
    await expect(replies).toHaveCount(2, { timeout: 90_000 });
    await expect(page.locator('.message-state').filter({ hasText: 'Responding' })).toHaveCount(0);
    const db = new Database(join(root, 'runner', 'runner.sqlite'), { readonly: true });
    try {
      const rows = db.prepare('SELECT state,thread_id FROM executions').all() as { state: string; thread_id: string }[];
      expect(rows).toHaveLength(2); expect(rows.every((row) => row.state === 'done')).toBe(true);
      expect(rows[0]!.thread_id).toBe(rows[1]!.thread_id);
    } finally { db.close(); }
    expect(readdirSync(join(root, 'releases'))).toHaveLength(1);
    command('restart');
    await expect.poll(() => command('status')).toContain('server: running');
    command('stop');
    expect(command('status')).toContain('runner: stopped');
  } finally {
    try { command('stop'); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
