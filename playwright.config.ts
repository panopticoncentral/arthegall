import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: '*.spec.ts', workers: 1,
  timeout: 60_000, expect: { timeout: 15_000 },
  use: { browserName: 'chromium', viewport: { width: 1200, height: 900 }, trace: 'retain-on-failure' },
});
