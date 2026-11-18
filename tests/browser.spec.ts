import { availablePort } from './helpers/port.js';
import { test, expect } from '@playwright/test';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

test('paired administrator DM, approvals, reconnect, refresh and narrow navigation', async ({ page }, info) => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-browser-test-'));
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const env = { ...process.env, ARTHEGALL_DATA_DIR: root, ARTHEGALL_PORT: String(port) };
  const cli = resolve('dist/scripts/arthegall.js');
  const setup = execFileSync(process.execPath, [cli, 'setup'], { env, encoding: 'utf8' });
  const code = setup.match(/minutes\): (\S+)/)?.[1];
  if (!code) throw new Error('Setup did not supply pairing code');
  const launch = (args: string[]) => spawn(process.execPath, [cli, ...args], { env, stdio: 'ignore' });
  async function stop(child: ChildProcess) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const closed = new Promise<void>((resolve) => child.once('close', resolve));
    child.kill('SIGTERM');
    const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000);
    try { await closed; } finally { clearTimeout(timeout); }
  }
  let server = launch(['server']), runner = launch(['runner', '--fake']);
  try {
    await expect.poll(async () => { try { return (await fetch(origin)).status; } catch { return 0; } }).toBe(200);
    await page.goto(origin);
    await page.getByLabel('Pairing code').fill('invalid');
    await page.getByRole('button', { name: 'Pair browser' }).click();
    await expect(page.getByRole('alert')).toContainText('invalid');
    await page.getByLabel('Pairing code').fill(code);
    await page.getByRole('button', { name: 'Pair browser' }).click();
    const composer = page.getByLabel('Message Administrator', { exact: true });
    await composer.fill('Hello from the synthetic browser test');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.getByText('Synthetic response: Hello from the synthetic browser test', { exact: true })).toBeVisible();
    await page.reload();
    await expect(page.getByText('Synthetic response: Hello from the synthetic browser test', { exact: true })).toHaveCount(1);
    await composer.fill('/test approval');
    await composer.press('Enter');
    await page.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(page.getByText('Synthetic approval declined.', { exact: false })).toBeVisible();
    await stop(runner);
    await expect(page.getByRole('status')).toContainText('Runner disconnected');
    await composer.fill('Queued while runner is offline');
    await page.getByRole('button', { name: 'Queue message' }).click();
    await expect(page.getByText('Queued for the runner…', { exact: true })).toBeVisible();
    runner = launch(['runner', '--fake']);
    await expect(page.getByText('Synthetic response: Queued while runner is offline', { exact: true })).toBeVisible();
    await stop(server);
    await expect(page.getByRole('status')).toContainText('Server unavailable');
    await composer.fill('Draft survives reconnect');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    server = launch(['server']);
    await expect(page.getByRole('status')).toContainText('Connected');
    await expect(composer).toHaveValue('Draft survives reconnect');
    await page.screenshot({ path: info.outputPath('desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Administrator', exact: true }).click();
    await expect(composer).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    await page.screenshot({ path: info.outputPath('mobile.png'), fullPage: true });
    await page.getByRole('button', { name: 'Open conversations' }).click();
    await page.getByRole('button', { name: 'Connections', exact: true }).click();
    await page.getByRole('button', { name: 'Administrator', exact: true }).click();
    await page.getByRole('button', { name: 'Unpair this browser' }).click();
    await expect(page.getByLabel('Pairing code')).toBeVisible();
  } finally { await stop(runner); await stop(server); rmSync(root, { recursive: true, force: true }); }
});
