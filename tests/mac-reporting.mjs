// Run after npm run build on macOS. All services, credentials, and usage records are synthetic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createServer } from '../dist/apps/server/src/server.js';
import { ServerStore } from '../dist/apps/server/src/store.js';
import { RunnerStore } from '../dist/apps/runner/src/store.js';
import { startRunner } from '../dist/apps/runner/src/runner.js';
import { CodexRpc } from '../dist/apps/runner/src/codex/rpc.js';
import { availablePort } from '../dist/tests/helpers/port.js';

const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--ui')) {
  console.error('Usage: node tests/mac-reporting.mjs [--ui]');
  process.exit(1);
}
const uiEnvironment = args[0] === '--ui' ? xcodeEnvironment() : undefined;
const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), 'arthegall-mac-reporting-'));
const roots = { codex: join(root, 'codex'), claude: join(root, 'claude') };
mkdirSync(join(roots.codex, 'sessions'), { recursive: true });
mkdirSync(join(roots.claude, 'projects'), { recursive: true });
writeFileSync(join(roots.codex, 'sessions', 'fixture.jsonl'), [13, 14, 15].map(day => JSON.stringify({
  timestamp: `2020-06-${day}T18:00:00Z`, type: 'token_usage_record',
  payload: { response_id: `synthetic-${day}`, usage: { input_tokens: 20, cached_input_tokens: 0, output_tokens: day, total_tokens: 20 + day } },
})).join('\n'));
writeFileSync(join(root, 'mode'), 'mac-reporting');

let clock = new Date('2020-06-15T14:59:00Z');
const store = new ServerStore(join(root, 'server.sqlite'), () => clock);
const ids = store.setup('synthetic');
const local = new RunnerStore(join(root, 'runner.sqlite'), ids.runnerId);
const server = await createServer(store, origin);
const browser = store.pair(store.createPairingCode(), 'synthetic-browser');
const fixtureRoute = `/fixture/${randomUUID()}`;
const replyText = 'Put source coverage first from now on.';
let replySubmissions = 0;
server.addHook('onSend', async (request, reply, payload) => {
  if (request.routeOptions.url === '/client/v1/messages' && request.body?.text === replyText && ++replySubmissions === 1) {
    reply.raw.destroy();
  }
  return payload;
});
server.post(fixtureRoute, async (request, reply) => {
  if (request.body.day === 15 || request.body.day === 16) return { id: (await advance(request.body.day)).message_id };
  if (request.body.lookupRowan === true) {
    for (let i = 0; i < 150; ++i) {
      const id = store.reporting.find('Rowan');
      if (id) return { id };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const sent = store.snapshot().messages.some(message => message.conversationId === ids.conversationId && message.author === 'user');
    return reply.code(409).send({ error: sent ? 'The Administrator received a message, but Rowan was not created.' : 'No Administrator message reached the fixture server.' });
  }
  if (request.body.decline) await browserDecline(request.body.decline);
  else throw new Error('Unknown fixture action');
  return { ok: true };
});
await server.listen({ host: '127.0.0.1', port });
const runner = await startRunner(local, { runnerId: ids.runnerId, token: 'synthetic', serverUrl: origin,
  workspaceRoot: join(root, 'workspaces'), usageRoots: roots,
  rpcFactory: workspace => new CodexRpc(process.execPath, [resolve('dist/tests/fixtures/provider.js'), root], workspace) });
const bundle = 'org.arthegall.fixture.t' + randomUUID();
const manifest = join(root, 'fixture.json');
writeFileSync(manifest, JSON.stringify({ origin, code: store.createPairingCode(), bundle, adminDM: ids.conversationId,
  fixtureURL: origin + fixtureRoute }), { mode: 0o600 });
try {
  if (uiEnvironment) {
    await run('xcodebuild', ['-project', 'apps/mac/Arthegall.xcodeproj', '-scheme', 'Arthegall',
      '-destination', `platform=macOS,arch=${process.arch === 'arm64' ? 'arm64' : 'x86_64'}`,
      '-derivedDataPath', resolve('dist/mac-ui'), '-parallel-testing-enabled', 'NO',
      '-only-testing:ArthegallUITests/ReportingTests', `ARTHEGALL_APP_ID=${bundle}`, 'test'],
    { ...uiEnvironment, TEST_RUNNER_ARTHEGALL_MAC_FIXTURE: manifest });
  } else {
    const app = join(root, 'ReportingProbe.app');
    const executable = join(app, 'Contents', 'MacOS', 'ReportingProbe');
    mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
    writeFileSync(join(app, 'Contents', 'Info.plist'), `<plist version="1.0"><dict>
      <key>CFBundleExecutable</key><string>ReportingProbe</string>
      <key>CFBundleIdentifier</key><string>${bundle}</string>
      <key>CFBundlePackageType</key><string>APPL</string></dict></plist>`);
    execFileSync('xcrun', ['swiftc', '-parse-as-library', '-module-cache-path', resolve('dist/mac-probe-cache'),
      ...['Client', 'SettingsData', 'Storage', 'ConversationModel'].map(name => `apps/mac/Arthegall/${name}.swift`),
      'tests/fixtures/MacReportingProbe.swift', '-o', executable], { stdio: 'inherit' });
    execFileSync('codesign', ['--force', '--sign', '-', app]);
    await run(executable, [manifest, 'schedule']);
    await advance(15);
    await run(executable, [manifest, 'reply']);
    await run(executable, [manifest, 'retry']);
    await advance(16);
    await run(executable, [manifest, 'verify']);
  }

  assert.equal(replySubmissions, 2);
  const reports = completed();
  assert.deepEqual(reports.map(row => [row.due_date, JSON.parse(row.evidence).codex.total]),
    [['2020-06-15', 34], ['2020-06-16', 35]]);
  assert.equal(JSON.parse(reports[0].payload).context.preference, undefined);
  assert.equal(JSON.parse(reports[1].payload).context.preference.instructions, 'Put source coverage first.');
  assert.match(reports[1].text, /^Source coverage: local records\. Synthetic total: 35/);
  assert.deepEqual(store.db.prepare(`SELECT c.reply_to AS sourceRun, json_extract(q.payload,'$.replyTo') AS sourceMessage
    FROM report_preferences p JOIN report_context c ON c.run_id=p.source_run
    JOIN command_receipts q ON q.run_id=p.source_run`).all(), [{ sourceRun: reports[0].run_id, sourceMessage: reports[0].message_id }]);
  console.log('Verified two scheduled reports, distinct saved evidence, one targeted reply after retry, and the saved preference in the next dispatch.');
} finally {
  await runner.close();
  await server.close();
  local.close();
  store.close();
  rmSync(root, { recursive: true, force: true });
}

function xcodeEnvironment() {
  const version = env => spawnSync('xcodebuild', ['-version'], { env, encoding: 'utf8' });
  const selected = version(process.env);
  if (selected.status === 0) return process.env;

  const standard = '/Applications/Xcode.app/Contents/Developer';
  if (!process.env.DEVELOPER_DIR && existsSync(join(standard, 'usr/bin/xcodebuild'))) {
    const env = { ...process.env, DEVELOPER_DIR: standard };
    if (version(env).status === 0) {
      console.log('Using Xcode at /Applications/Xcode.app for this test.');
      return env;
    }
  }

  const detail = selected.stderr?.trim() || selected.error?.message;
  if (detail) console.error(detail);
  console.error('The Mac window test requires full Xcode. Install and open Xcode to finish setup, or select your installed copy with DEVELOPER_DIR.');
  console.error('Example: DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer node tests/mac-reporting.mjs --ui');
  process.exit(1);
}

function completed() {
  return store.db.prepare(`SELECT o.due_date, r.id AS run_id, m.id AS message_id, m.text, c.evidence, d.payload
    FROM report_occurrences o JOIN runs r ON r.id=o.run_id JOIN report_context c ON c.run_id=r.id
    JOIN messages m ON m.id=r.assistant_message_id JOIN dispatches d ON d.run_id=r.id
    WHERE r.state='completed' ORDER BY o.due_date`).all();
}

async function advance(day) {
  clock = new Date(`2020-06-${day}T15:00:00Z`);
  for (let i = 0; i < 200; ++i) {
    const report = completed().find(row => row.due_date === `2020-06-${day}`);
    if (report) return report;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`Scheduled delivery for June ${day} did not finish`);
}

async function browserDecline(id) {
  const response = await server.inject({ method: 'POST', url: `/api/schedules/${id}`,
    headers: { host: new URL(origin).host, origin, cookie: `arthegall=${browser.token}` }, payload: { decision: 'decline' } });
  assert.equal(response.statusCode, 200);
}

async function run(executable, args, env = process.env) {
  const child = spawn(executable, args, { stdio: 'inherit', env });
  const status = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', resolve);
  });
  assert.equal(status, 0, `${executable} completed`);
}
