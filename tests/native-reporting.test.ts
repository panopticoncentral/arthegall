import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NativeTestClient, pairNative, waitFor } from './helpers/native-client.js';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { availablePort } from './helpers/port.js';
import { ServerStore } from '../apps/server/src/store.js';
import { RunnerStore } from '../apps/runner/src/store.js';
import { createServer } from '../apps/server/src/server.js';
import { CodexRpc } from '../apps/runner/src/codex/rpc.js';
import { startRunner } from '../apps/runner/src/runner.js';

test('native reporting uses scoped usage and replaces an unverified predecessor thread', async () => {
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
  const app = await createServer(server, origin);
  await app.listen({ host: '127.0.0.1', port });
  const local = new RunnerStore(join(root, 'runner.sqlite'), ids.runnerId);
  // A schema upgrade preserves the old mapping with an unknown configuration.
  // Resuming this thread would give the new administrator its predecessor's history.
  local.db.prepare('INSERT INTO sessions(assignment_id,thread_id) VALUES (?,?)').run(ids.assignmentId, 'legacy-thread');
  writeFileSync(join(root, 'mode'), 'reporting');
  const runner = await startRunner(local, { token, runnerId: ids.runnerId, serverUrl: origin, workspaceRoot: join(root, 'work'), usageRoots,
    rpcFactory: workspace => new CodexRpc(process.execPath, [resolve('dist/tests/fixtures/provider.js'), root], workspace) });
  try {
    const paired = await pairNative(origin, server.createPairingCode());
    const client = new NativeTestClient(origin, paired.token);
    await client.send(ids.conversationId, 'Create a reporting agent named Rowan and an assignment to report local Codex and Claude usage. Request access and queue its report for June 15, 2020, now.');
    const grant = await waitFor('scoped usage request', async () => (await client.snapshot()).grants[0]);
    assert.equal(grant.name, 'Rowan');
    assert.equal(grant.runnerId, ids.runnerId);
    await client.post('access/' + grant.id, { decision: 'accept', duration: 'assignment' });
    const saved = await waitFor('report and recorded usage', async () => (await client.snapshot()).messages.find(message =>
      message.conversationId === grant.conversationId && message.state === 'completed' && message.evidence));
    assert.match(saved.text, /137/);
    assert.equal(saved.evidence?.range.start, '2020-06-15');
    assert.equal(saved.evidence?.codex.total, 137);
    assert.equal(saved.evidence?.claude.coverage, 'no_records');
    const reply = await client.send(grant.conversationId, 'How many cached input tokens did that report count?', saved.id);
    const settled = await waitFor('completed report reply', async () => {
      const snapshot = await client.snapshot();
      const run = snapshot.runs.find(item => item.id === reply.runId && item.state === 'completed');
      return snapshot.messages.find(message => message.id === run?.messageId);
    });
    assert.equal(settled.text, 'Synthetic cached input: 5');
    assert.notEqual(local.session(ids.assignmentId)?.thread_id, 'legacy-thread');
    assert(!readFileSync(join(root, 'calls'), 'utf8').split('\n').includes('thread/resume'));
    assert.equal(local.db.prepare('SELECT count(DISTINCT thread_id) FROM sessions').pluck().get(), 2);
    assert.equal(server.db.prepare('SELECT count(*) FROM report_context WHERE reply_to IS NOT NULL').pluck().get(), 1);
    assert.equal((await client.snapshot()).messages.filter(message => message.conversationId === grant.conversationId).length, 4);
  } finally {
    await runner.close(); await app.close(); local.close(); server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
