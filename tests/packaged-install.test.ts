import { availablePort } from './helpers/port.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeTestClient, pairNative, setupCode, waitFor, waitForServer } from './helpers/native-client.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

test('packaged macOS user services retain a live conversation through stop/start and repeat setup', {
  skip: process.platform !== 'darwin' || !process.env.ARTHEGALL_PACKAGE_PATH || process.env.ARTHEGALL_LIVE_CODEX !== '1',
  timeout: 240_000,
}, async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-install-'));
  const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
  const launcher = join(process.env.ARTHEGALL_PACKAGE_PATH!, 'bin', 'arthegall');
  const env = { ...process.env, ARTHEGALL_DATA_DIR: root, ARTHEGALL_PORT: String(port), ARTHEGALL_ORIGIN: origin, ARTHEGALL_LAUNCH_AGENTS_DIR: join(root, 'LaunchAgents') };
  const command = (action: string) => execFileSync(launcher, [action], { env, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });
  try {
    const code = setupCode(command('install'));
    await waitForServer(origin);
    await waitFor('launchd runner', () => command('status').includes('runner: running'));
    assert.throws(() => command('runner'), /already running|owns|in use/i);
    const pairing = await pairNative(origin, code);
    const client = new NativeTestClient(origin, pairing.token);
    const admin = (await client.snapshot()).conversations.find(conversation => conversation.administrator);
    assert(admin);
    const verifyReply = async (runId: string) => {
      const message = await waitFor('saved live reply', async () => {
        const snapshot = await client.snapshot();
        const run = snapshot.runs.find(item => item.id === runId && item.state === 'completed');
        return snapshot.messages.find(item => item.id === run?.messageId);
      }, 90_000);
      assert.match(message.text, /silver willow/i);
    };
    const initial = await client.send(admin.id, 'Remember the synthetic phrase silver willow. Report only that phrase as the completed outcome.');
    await verifyReply(initial.runId);
    command('stop');
    await waitFor('the server to stop', async () => !await fetch(origin + '/client/v1/snapshot', { headers: client.headers }).catch(() => undefined));
    command('setup');
    command('install');
    await waitForServer(origin);
    assert.equal((await client.snapshot()).runs.find(run => run.id === initial.runId)?.state, 'completed');
    const followup = await client.send(admin.id, 'What was the synthetic phrase? Report just those two words as the completed outcome.');
    await verifyReply(followup.runId);
    const db = new Database(join(root, 'runner', 'runner.sqlite'), { readonly: true });
    try {
      const rows = db.prepare('SELECT state,thread_id FROM executions').all() as { state: string; thread_id: string }[];
      assert.equal(rows.length, 2);
      assert(rows.every(row => row.state === 'done'));
      assert.equal(rows[0]!.thread_id, rows[1]!.thread_id);
    } finally { db.close(); }
    assert.equal(readdirSync(join(root, 'releases')).length, 1);
    command('restart');
    await waitFor('launchd server after restart', () => command('status').includes('server: running'));
    command('stop');
    assert(command('status').includes('runner: stopped'));
  } finally {
    try { command('stop'); } finally { rmSync(root, { recursive: true, force: true }); }
  }
});
