// Run after npm run build on macOS. All services, credentials, and usage records are synthetic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from '../dist/apps/server/src/server.js';
import { ServerStore } from '../dist/apps/server/src/store.js';
import { RunnerStore } from '../dist/apps/runner/src/store.js';
import { startRunner } from '../dist/apps/runner/src/runner.js';
import { CodexRpc } from '../dist/apps/runner/src/codex/rpc.js';
import { availablePort } from '../dist/tests/helpers/port.js';

import { buildProbe, macTestEnvironment, run, runMacUI } from './helpers/mac-test.mjs';

const uiEnvironment = macTestEnvironment('tests/mac-reporting.mjs');
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
    await runMacUI('ReportingTests', bundle, manifest, uiEnvironment);
  } else {
    const executable = buildProbe(root, bundle, 'MacReportingProbe');
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
