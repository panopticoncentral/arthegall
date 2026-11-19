import { test, expect } from '@playwright/test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { availablePort } from './helpers/port.js';
import { ServerStore } from '../apps/server/src/store.js';
import { RunnerStore } from '../apps/runner/src/store.js';
import { createServer } from '../apps/server/src/server.js';
import { CodexRpc } from '../apps/runner/src/codex/rpc.js';
import { startRunner } from '../apps/runner/src/runner.js';

for (const live of [false, true]) test(`${live ? 'Live Codex' : 'Deterministic provider'} reporting DM, approval and follow-up`, async ({ page }) => {
  test.skip(live && process.env.ARTHEGALL_LIVE_CODEX !== '1', 'Opt in to real Codex calls');
  test.setTimeout(360_000);
  const root = mkdtempSync(join(tmpdir(), 'arthegall-report-test-'));
  const usageRoots = { codex: join(root, 'codex-records'), claude: join(root, 'claude-records') };
  mkdirSync(join(usageRoots.codex, 'sessions'), { recursive: true });
  writeFileSync(join(usageRoots.codex, 'sessions', 'synthetic.jsonl'), JSON.stringify({
    timestamp: '2020-06-15T15:00:00Z', type: 'token_usage_record', payload: { response_id: 'synthetic',
      usage: { input_tokens: 124, cached_input_tokens: 5, output_tokens: 13, reasoning_output_tokens: 2, total_tokens: 137 } },
  }));
  const server = new ServerStore(join(root, 'server.sqlite'));
  const token = 'synthetic-test-only', ids = server.setup(token);
  const port = await availablePort(), origin = 'http://127.0.0.1:' + port;
  const app = await createServer(server, origin, resolve('dist/web'));
  await app.listen({ host: '127.0.0.1', port });
  const local = new RunnerStore(join(root, 'runner.sqlite'), ids.runnerId);
  if (!live) writeFileSync(join(root, 'mode'), 'reporting');
  const runner = await startRunner(local, { token, runnerId: ids.runnerId, serverUrl: origin, workspaceRoot: join(root, 'work'), usageRoots,
    ...(!live ? { rpcFactory: (workspace: string) => new CodexRpc(process.execPath, [resolve('dist/tests/fixtures/provider.js'), root], workspace) } : {}) });
  try {
    await page.goto(origin);
    await page.getByLabel('Pairing code').fill(server.createPairingCode());
    await page.getByRole('button', { name: 'Pair browser' }).click();
    const send = async (name: string, message: string) => {
      const composer = page.getByLabel('Message ' + name, { exact: true });
      await composer.fill(message); await composer.press('Enter');
    };
    await send('Administrator', 'Create a reporting agent named Rowan and an assignment to report local Codex and Claude usage. Request access and queue its report for June 15, 2020, now.');
    await expect(page.getByRole('heading', { name: 'Reporting access requested' })).toBeVisible({ timeout: 90_000 });
    await page.reload();
    await page.getByRole('button', { name: 'Allow for this assignment' }).click();
    await page.getByRole('button', { name: 'Rowan', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reply to report' })).toBeVisible({ timeout: 150_000 });
    await expect(page.locator('.message-text').last()).toContainText('137');
    await page.getByText('Recorded usage · 2020-06-15').click();
    await expect(page.locator('.usage').getByText('No local records', { exact: false })).toBeVisible();
    await page.getByRole('button', { name: 'Reply to report' }).click();
    await send('Rowan', 'How many cached input tokens did that report count? Reply with the number in digits.');
    await expect.poll(() => local.db.prepare("SELECT count(*) FROM executions WHERE state='done'").pluck().get(), { timeout: 90_000 }).toBe(3);
    await expect(page.locator('.message').last()).toContainText('5');
    const sessions = local.db.prepare('SELECT count(DISTINCT thread_id) FROM sessions').pluck().get();
    expect(sessions).toBe(2);
    expect(server.db.prepare('SELECT count(*) FROM report_context WHERE reply_to IS NOT NULL').pluck().get()).toBe(1);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Rowan' })).toBeVisible();
    await expect(page.locator('.message')).toHaveCount(4);
  } finally {
    await runner.close(); await app.close(); local.close(); server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
