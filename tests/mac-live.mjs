// Native Swift client against an actual host package and a signed-in Codex provider.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import Database from 'better-sqlite3';
import { availablePort } from '../dist/tests/helpers/port.js';
import { buildProbe, run } from './helpers/mac-test.mjs';

const pkg = process.env.ARTHEGALL_PACKAGE_PATH;
if (process.env.ARTHEGALL_LIVE_CODEX !== '1' || !pkg)
  throw new Error('Set ARTHEGALL_LIVE_CODEX=1 and ARTHEGALL_PACKAGE_PATH to the built host package');
const cli = resolve(pkg, 'bin', 'arthegall');
assert(existsSync(cli), 'Packaged host launcher is missing');
const port = await availablePort();
const origin = `http://127.0.0.1:${port}`;
const root = mkdtempSync(join(tmpdir(), 'arthegall-mac-live-'));
const codexUsage = join(root, 'synthetic-codex-usage'), claudeUsage = join(root, 'synthetic-claude-usage');
mkdirSync(join(codexUsage, 'sessions'), { recursive: true });
mkdirSync(join(claudeUsage, 'projects'), { recursive: true });
writeFileSync(join(codexUsage, 'sessions', 'fixture.jsonl'), JSON.stringify({
  timestamp: '2020-06-15T15:00:00Z', type: 'token_usage_record', payload: { response_id: 'synthetic',
    usage: { input_tokens: 124, cached_input_tokens: 5, output_tokens: 13, reasoning_output_tokens: 2, total_tokens: 137 } },
}));
const env = { ...process.env, ARTHEGALL_DATA_DIR: root, ARTHEGALL_PORT: String(port), ARTHEGALL_ORIGIN: origin,
  ARTHEGALL_CODEX_USAGE_DIR: codexUsage, ARTHEGALL_CLAUDE_USAGE_DIR: claudeUsage };
const bundle = 'org.arthegall.fixture.live-' + randomUUID();
const manifest = join(root, 'fixture.json');
let server, runner, passed = false;
try {
  const setup = execFileSync(cli, ['setup'], { env, encoding: 'utf8' });
  const code = setup.match(/Pairing code \(valid for ten minutes\): (\S+)/)?.[1];
  assert(code, 'Package setup did not issue a pairing code');
  writeFileSync(manifest, JSON.stringify({ origin, code }), { mode: 0o600 });
  const executable = buildProbe(root, bundle, 'MacLiveProbe');
  await start();
  await run(executable, [manifest, 'pair']);
  await stop(runner);
  await stop(server);
  await start();
  await run(executable, [manifest, 'continue']);
  verify();
  passed = true;
  console.log('Verified packaged live Codex DMs across restart, native approve and decline, and a report reply tied to saved synthetic evidence.');
} finally {
  await stop(runner);
  await stop(server);
  if (passed) rmSync(root, { recursive: true, force: true });
  else console.error(`Isolated live test records retained at ${root}`);
}

async function start() {
  server = spawn(cli, ['server'], { env, stdio: 'inherit' });
  runner = spawn(cli, ['runner', '--approval-exercise'], { env, stdio: 'inherit' });
  for (let i = 0; i < 100; ++i) {
    const response = await fetch(origin + '/client/v1/snapshot', { headers: { 'X-Arthegall-Client': '1' } }).catch(() => undefined);
    if (response?.status === 401) return;
    await delay(100);
  }
  assert.fail('Packaged host did not expose the native pairing API');
}

async function stop(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { child.kill('SIGTERM'); await exited; } finally { clearTimeout(timeout); }
}

function verify() {
  const central = new Database(join(root, 'server', 'server.sqlite'), { readonly: true });
  const journal = new Database(join(root, 'runner', 'runner.sqlite'), { readonly: true });
  try {
    const executions = journal.prepare('SELECT state, model, thread_id FROM executions ORDER BY rowid').all();
    assert.equal(executions.length, 7);
    assert(executions.every(row => row.state === 'done' && row.model && row.thread_id), 'Missing authenticated provider records');
    assert.equal(executions[0].thread_id, executions[1].thread_id, 'Administrator provider context did not survive the restart');
    const decisions = central.prepare(`SELECT a.run_id, a.decision, a.acknowledged, s.id AS session, d.payload FROM approvals a
      JOIN browser_sessions s ON s.id=a.session_id JOIN dispatches d ON d.run_id=a.run_id ORDER BY a.rowid`).all();
    assert.deepEqual(decisions.map(row => row.decision), ['accept', 'decline']);
    assert(decisions.every(row => row.session === decisions[0].session && row.acknowledged === 1));
    for (const decision of decisions) {
      const assignment = JSON.parse(decision.payload).context.assignmentId;
      const file = join(root, 'workspaces', assignment, `approval-note-${decision.run_id}.txt`);
      if (decision.decision === 'accept') assert.equal(readFileSync(file, 'utf8'), 'synthetic');
      else assert.equal(existsSync(file), false);
    }
    const reply = central.prepare(`SELECT selected.assistant_message_id AS message, selectedEvidence.evidence,
      json_extract(receipt.payload,'$.replyTo') AS replyTo FROM report_context followup
      JOIN runs selected ON selected.id=followup.reply_to JOIN report_context selectedEvidence ON selectedEvidence.run_id=selected.id
      JOIN command_receipts receipt ON receipt.run_id=followup.run_id`).get();
    assert(reply?.message && reply.message === reply.replyTo, 'Reply must target the saved report message');
    assert.equal(JSON.parse(reply.evidence).codex.total, 137);
  } finally { journal.close(); central.close(); }
}
