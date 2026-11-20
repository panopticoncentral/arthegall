// Run after npm run build on macOS. The fixture uses its own stores, Keychain service and app ID.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { DailyBackups } from '../dist/scripts/daily-backups.js';
import { ServerStore } from '../dist/apps/server/src/store.js';
import { createServer } from '../dist/apps/server/src/server.js';
import { RunnerStore } from '../dist/apps/runner/src/store.js';
import { startRunner } from '../dist/apps/runner/src/runner.js';
import { availablePort } from '../dist/tests/helpers/port.js';

const root = mkdtempSync(join(tmpdir(), 'arthegall-mac-ui-'));
const store = new ServerStore(join(root, 'server', 'server.sqlite'));
const ids = store.setup('synthetic');
let reportDM;
if (!process.argv.includes('--session-only')) {
  reportDM = store.reporting.create('Rowan', 'Prepare usage reports.', 'Report local activity.', null);
  const insert = store.db.prepare('INSERT INTO messages(id,conversation_id,author,text,state) VALUES (?,?,?,?,?)');
  insert.run(randomUUID(), reportDM, 'user', 'How did usage compare across providers?', 'complete');
  insert.run(randomUUID(), reportDM, 'assistant', [
    '## Usage by provider', '',
    'Codex accounted for **two thirds** of the total. Both sources reported local records.', '',
    '| Provider | Input tokens | Output tokens |', '| --- | ---: | ---: |',
    '| Codex | 8,000 | 2,000 |', '| Claude | 4,000 | 1,000 |', '',
    '### Collection notes', '',
    '- Cached input is included in the input column.',
    '- Totals cover the same reporting period.', '',
    '```text', '15,000 tokens across 2 providers', '```',
  ].join('\n'), 'completed');
}
const port = await availablePort();
const origin = 'http://127.0.0.1:' + port;
const backupFolder = join(root, 'backups');
mkdirSync(backupFolder, { mode: 0o700 });
const backups = new DailyBackups(root, ids.serverId, [join(root, 'server')], () => store.recovery.paused(),
  () => store.reporting.event('backup_status', {}));
const server = await createServer(store, origin, undefined, backups);
let sends = 0;
let clientClosed = false;
// The sandboxed XCTest runner can read the fixture manifest and contact loopback.
const closedPath = '/fixture/' + randomUUID() + '/closed';
server.post(closedPath, async () => {
  clientClosed = true;
  return { ok: true };
});
server.addHook('onSend', async (request, reply, payload) => {
  if (request.routeOptions.url === '/client/v1/messages' && ++sends === 1) {
    // The receipt has committed. Lose only the first HTTP acknowledgment.
    reply.raw.destroy();
  }
  return payload;
});
const local = new RunnerStore(join(root, 'runner.sqlite'), ids.runnerId);
await server.listen({ host: '127.0.0.1', port });
const runner = await startRunner(local, { runnerId: ids.runnerId, token: 'synthetic', serverUrl: origin,
  workspaceRoot: join(root, 'workspaces'), fake: true });
const control = store.pair(store.createPairingCode(), 'synthetic');
const bundle = 'org.arthegall.fixture.t' + randomUUID();
const manifest = join(root, 'fixture.json');
writeFileSync(manifest, JSON.stringify({ origin, code: store.createPairingCode(), bundle, backupFolder, adminDM: ids.conversationId, reportDM, closedURL: origin + closedPath }), { mode: 0o600 });
const timer = setInterval(() => {
  if (!clientClosed) return;
  const approval = store.snapshot().approvals[0];
  if (approval) store.decide(control.id, approval.id, 'decline');
  if (store.snapshot().messages.some(m => m.text.startsWith('Synthetic approval declined'))) {
    writeFileSync(join(root, 'finished'), '');
    clearInterval(timer);
  }
}, 100);
try {
  if (process.argv.includes('--session-only')) {
    const contents = join(root, 'SessionProbe.app', 'Contents');
    mkdirSync(join(contents, 'MacOS'), { recursive: true });
    writeFileSync(join(contents, 'Info.plist'), `<plist version="1.0"><dict>
      <key>CFBundleExecutable</key><string>SessionProbe</string>
      <key>CFBundleIdentifier</key><string>${bundle}</string>
      <key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
    const probe = join(contents, 'MacOS', 'SessionProbe');
    execFileSync('xcrun', ['swiftc', '-parse-as-library', '-module-cache-path', resolve('dist/mac-probe-cache'),
      ...['Client', 'SettingsData', 'Storage', 'ConversationModel'].map(name => 'apps/mac/Arthegall/' + name + '.swift'),
      'tests/fixtures/MacSessionProbe.swift', '-o', probe]);
    execFileSync('codesign', ['--force', '--sign', '-', join(root, 'SessionProbe.app')]);
    await run(probe, [manifest, 'pair']);
    await run(probe, [manifest, 'retry']);
    clientClosed = true;
    for (let check = 0; check < 150 && !existsSync(join(root, 'finished')); check++) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert(existsSync(join(root, 'finished')), 'Runner finished while the app was closed');
    await run(probe, [manifest, 'finish']);
  } else {
    await run('xcodebuild', ['-project', 'apps/mac/Arthegall.xcodeproj', '-scheme', 'Arthegall',
      '-destination', 'platform=macOS,arch=' + (process.arch === 'arm64' ? 'arm64' : 'x86_64'),
      '-derivedDataPath', resolve('dist/mac-ui'), '-parallel-testing-enabled', 'NO',
      'ARTHEGALL_APP_ID=' + bundle, 'test'], { ...process.env, TEST_RUNNER_ARTHEGALL_MAC_FIXTURE: manifest });
  }
  if (reportDM) {
    assert.equal(store.retention.days(), 14);
    assert.equal(backups.status().destination, backupFolder);
    assert.ok(backups.status().lastPath);
    assert.equal(backups.status().error, null);
    assert.equal(store.reporting.settings(reportDM).instructions, 'Lead with coverage.');
    assert.equal(store.db.prepare("SELECT COUNT(*) FROM report_schedules WHERE state='active'").pluck().get(), 1);
  }
  assert.equal(sends, 2);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM dispatches').pluck().get(), 1);
  assert.equal(store.db.prepare("SELECT COUNT(*) FROM messages WHERE author='user' AND conversation_id=?").pluck().get(ids.conversationId), 1);
  assert.equal(store.db.prepare('SELECT COUNT(*) FROM command_receipts').pluck().get(), 1);
  console.log('Verified two submissions, one message, one receipt and one dispatch.');
} finally {
  clearInterval(timer);
  await runner.close(); await server.close(); local.close(); store.close();
  rmSync(root, { recursive: true, force: true });
}

async function run(executable, args, env = process.env) {
  const child = spawn(executable, args, { stdio: 'inherit', env });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(status, 0, executable + ' completed');
}
