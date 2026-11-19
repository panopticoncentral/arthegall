import { expect, test } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from '../apps/server/src/server.js';
import { ServerStore } from '../apps/server/src/store.js';
import { availablePort } from './helpers/port.js';
import { reportingUpgrade } from './helpers/reporting-upgrade.js';

const reportText = `**Synthetic activity report**

## Source coverage

- Codex: *No local records*
- Claude: **Unknown usage**

| Source | Input tokens | Cached input | Output tokens | Reasoning output | Total tokens |
| ------ | ----------- | ------------ | ------------- | ---------------- | ------------ |
| Codex  | Unknown     | Unknown      | Unknown       | Unknown          | Unknown      |
| Claude | Unknown     | Unknown      | Unknown       | Unknown          | Unknown      |

1. Check the [collection guide](https://example.org/guide).
2. Treat missing records as unknown.

<mark>literal markup</mark> and [unsupported destination](data:text/plain,example)
![diagram description](https://example.org/diagram.png)`;

test('a persisted Markdown report survives reload with its evidence and reply target', async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-markdown-'));
  const old = await reportingUpgrade(root, reportText);
  const store = new ServerStore(old.serverPath);
  const port = await availablePort(), origin = 'http://127.0.0.1:' + port;
  const app = await createServer(store, origin, resolve('dist/web'));
  try {
    await app.listen({ host: '127.0.0.1', port });
    await page.context().addCookies([{ url: origin, name: 'arthegall', value: old.browserToken, httpOnly: true }]);
    await page.goto(origin);
    await page.getByRole('button', { name: 'Rowan', exact: true }).click();

    const report = page.getByRole('article').filter({ has: page.getByRole('button', { name: 'Reply to report' }) });
    const body = report.locator('.message-text');
    async function checkReport() {
      await expect(page.getByRole('heading', { name: 'Rowan', exact: true })).toBeVisible();
      await expect(body.locator('strong').first()).toHaveText('Synthetic activity report');
      await expect(body.getByRole('heading', { name: 'Source coverage', level: 2 })).toBeVisible();
      await expect(body.locator('ul > li')).toHaveCount(2);
      await expect(body.locator('ol > li')).toHaveCount(2);
      await expect(body.locator('li em')).toHaveText('No local records');
      await expect(body.locator('li strong')).toHaveText('Unknown usage');
      await expect(body.getByRole('columnheader')).toHaveCount(6);
      await expect(body.getByRole('row')).toHaveCount(3);
      await expect(body.getByRole('link', { name: 'collection guide' })).toHaveAttribute('href', 'https://example.org/guide');
      await expect(body.getByRole('link')).toHaveCount(1);
      await expect(body).toContainText('<mark>literal markup</mark>');
      await expect(body).toContainText('unsupported destination');
      await expect(body).toContainText('diagram description');
      await expect(body.locator('mark,img')).toHaveCount(0);
    }
    await checkReport();
    await page.setViewportSize({ width: 360, height: 780 });
    await page.reload();
    await checkReport();
    const table = body.getByRole('table');
    await table.getByRole('columnheader', { name: 'Total tokens' }).scrollIntoViewIfNeeded();
    await expect(table.getByRole('columnheader', { name: 'Total tokens' })).toBeInViewport();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(360);

    await report.getByText('Original message text', { exact: true }).click();
    expect(await report.locator('.original pre').textContent()).toBe(reportText);
    await report.getByText('Recorded usage · 2019-01-01').click();
    await expect(report.locator('.usage').getByText(/No local records/)).toHaveCount(2);
    await expect(report.locator('.usage').getByText(/No local records/).first()).toBeVisible();
    await report.getByRole('button', { name: 'Reply to report' }).click();
    await expect(page.getByText(/Replying to the report for 2019-01-01/)).toBeVisible();
    await page.getByLabel('Message Rowan', { exact: true }).fill('Which sources had records?');
    await page.getByRole('button', { name: 'Queue message' }).click();
    await expect(page.getByText('Queued for the runner…', { exact: true })).toBeVisible();
    expect(store.db.prepare('SELECT reply_to FROM report_context WHERE reply_to IS NOT NULL').pluck().all()).toEqual([old.run]);
    expect(store.db.prepare('SELECT evidence FROM report_context WHERE run_id=?').pluck().get(old.run)).toBe(old.evidence);
    expect(store.db.prepare('SELECT text FROM messages JOIN runs ON messages.id=runs.assistant_message_id WHERE runs.id=?').pluck().get(old.run)).toBe(reportText);
  } finally {
    await app.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
