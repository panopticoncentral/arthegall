import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireProcessLock } from '../scripts/process-lock.js';
test('only one process can own a server or runner data directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-lock-'));
  const release = acquireProcessLock(root, 'runner');
  try {
    assert.throws(() => acquireProcessLock(root, 'runner'), /already owns/);
    acquireProcessLock(root, 'server')();
  } finally { release(); }
  try { acquireProcessLock(root, 'runner')(); } finally { rmSync(root, { recursive: true, force: true }); }
});
