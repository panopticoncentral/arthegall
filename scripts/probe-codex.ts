import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CodexRpc } from '../apps/runner/src/codex/rpc.js';
import { launchArgs, providerEnvironment, threadConfig } from '../apps/runner/src/codex/config.js';
import { startToolService } from '../apps/runner/src/mcp.js';
import type { Outcome } from '../packages/contracts/src/index.js';

// Raw provider messages, identities, paths and account details never enter the report.
const root = await realpath(await mkdtemp(join(tmpdir(), 'arthegall-probe-')));
const workspace = join(root, 'workspace');
await mkdir(workspace);
await writeFile(join(root, 'server-secret.txt'), 'SYNTHETIC-SERVER-SECRET');
await writeFile(join(workspace, 'setup-note.txt'), 'SYNTHETIC-WORKSPACE-NOTE');
const executable = process.env.ARTHEGALL_CODEX_BIN ?? 'codex';
const environment = providerEnvironment(process.env);
const service = await startToolService();
const checks: string[] = [];
const pass = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
const Result = z.object({ exitCode: z.number(), stdout: z.string(), stderr: z.string() });
const Thread = z.object({ thread: z.object({ id: z.string() }), model: z.string(), reasoningEffort: z.string().nullable() });
const Completed = z.object({ threadId: z.string(), turn: z.object({ id: z.string(), status: z.string() }) });
const ctx = {
  agentId: randomUUID(), assignmentId: randomUUID(), runId: randomUUID(), definitionVersion: 1,
  instructions: 'Synthetic integration probe. Use only the supplied context and requested tools.', messages: [],
};
const outcomes: Outcome[] = [];
let recordedBeforeCompletion = false;
let rpc: CodexRpc;
let permissionProfile = `arthegall_${randomUUID()}`;
const start = async () => {
  permissionProfile = `arthegall_${randomUUID()}`;
  const connection = new CodexRpc(executable, launchArgs(permissionProfile), workspace, environment);
  await connection.initialize();
  return connection;
};
const bind = () => service.bind({ ...ctx, runId: randomUUID() }, async (outcome) => {
  // Await durable storage before the MCP response, as the real runner must do.
  await writeFile(join(root, 'outcome.json'), JSON.stringify(outcome), { mode: 0o600 });
  outcomes.push(outcome);
});
let binding = bind();
async function turn(threadId: string, text: string, extra: Record<string, unknown> = {}) {
  const finished = rpc.waitFor((event) => event.method === 'turn/completed' && Completed.parse(event.params).threadId === threadId);
  void finished.catch(() => {});
  await rpc.request('turn/start', {
    threadId, input: [{ type: 'text', text }], permissions: permissionProfile, approvalPolicy: 'never',
    ...extra,
  });
  return Completed.parse((await finished).params).turn;
}
try {
  console.log(`Codex ${execFileSync(executable, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()}`);
  rpc = await start();
  const config = z.object({ config: z.object({ mcp_servers: z.record(z.string(), z.unknown()).nullable().optional() }) }).parse(await rpc.request('config/read', { includeLayers: false }));
  const inherited = config.config.mcp_servers ?? {};
  const models = z.object({ data: z.array(z.object({ model: z.string(), isDefault: z.boolean(), defaultReasoningEffort: z.string() })) }).parse(await rpc.request('model/list', { limit: 100 }));
  const model = models.data.find((m) => m.isDefault);
  assert(model, 'Provider must advertise a default model');
  console.log(`Configuration: ${model.model}, ${model.defaultReasoningEffort}`);
  const allowed = Result.parse(await rpc.request('command/exec', {
    command: ['/bin/cat', join(workspace, 'setup-note.txt')], cwd: workspace, permissionProfile, timeoutMs: 5_000,
  }));
  assert.equal(allowed.exitCode, 0);
  assert.equal(allowed.stdout, 'SYNTHETIC-WORKSPACE-NOTE');
  const denied = Result.parse(await rpc.request('command/exec', {
    command: ['/bin/cat', join(root, 'server-secret.txt')], cwd: workspace, permissionProfile, timeoutMs: 5_000,
  }));
  assert.notEqual(denied.exitCode, 0);
  assert(!denied.stdout.includes('SYNTHETIC-SERVER-SECRET'));
  pass('workspace readable; sibling server storage denied');

  const client = new Client({ name: 'arthegall-probe', version: '0.1.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${binding.token}` } } }));
  try {
    const impostor = await client.callTool({ name: 'read_context', arguments: { agentId: randomUUID() } });
    assert.equal(impostor.isError, true);
    const response = await fetch(service.url, { method: 'POST', body: '{}', headers: { Authorization: 'Bearer invalid', 'Content-Type': 'application/json' } });
    assert.equal(response.status, 401);
    pass('MCP rejects forged identity and invalid credentials');
  } finally { await client.close(); }

  const instructions = 'You are the Arthegall administrator in an isolated integration test. Follow the user prompt. Use read_context first, then report_outcome with status completed and your answer as message. Do not use any other tool. Never spawn agents.';
  const params = () => ({
    cwd: workspace, runtimeWorkspaceRoots: [workspace], model: model.model,
    permissions: permissionProfile, approvalPolicy: 'never', approvalsReviewer: 'user',
    baseInstructions: instructions, developerInstructions: instructions,
    config: threadConfig(inherited, service.url, binding.token),
  });
  const thread = Thread.parse(await rpc.request('thread/start', params()));
  let deltas = 0;
  const unsubscribe = rpc.subscribe((event) => {
    if (event.method === 'item/agentMessage/delta') deltas++;
    if (event.method === 'turn/completed') recordedBeforeCompletion = outcomes.length > 0;
  });
  const first = await turn(thread.thread.id, 'Remember these two synthetic words: amber orchard. Report them as the result.', { model: model.model, effort: model.defaultReasoningEffort });
  assert.equal(first.status, 'completed');
  assert(outcomes.at(-1)?.message.toLowerCase().includes('amber orchard'));
  assert(recordedBeforeCompletion);
  assert(deltas > 0);
  pass('real turn streams text and records MCP outcome before completion');
  unsubscribe();
  await rpc.close();
  binding.revoke();
  binding = bind();
  rpc = await start();
  await rpc.request('thread/resume', { ...params(), threadId: thread.thread.id, excludeTurns: true });
  outcomes.length = 0;
  const second = await turn(thread.thread.id, 'What were the two words I asked you to remember? Report only those words as the result.');
  assert.equal(second.status, 'completed');
  assert(outcomes.at(-1)?.message.toLowerCase().includes('amber orchard'));
  pass('provider restart and thread resume retain synthetic context');
  const history = z.object({ data: z.array(z.object({ id: z.string(), status: z.string() })) }).parse(await rpc.request('thread/turns/list', { threadId: thread.thread.id, limit: 10 }));
  assert(history.data.some((entry) => entry.id === second.id && entry.status === 'completed'));
  pass('completed turn recoverable through provider history');

  // Native execution is enabled only on this synthetic probe thread. The
  // administrator configuration keeps shell access disabled.
  const nativeInstructions = 'You are testing approval delivery. Use the shell tool with login=false for exactly the requested command. Ask for escalation if the read-only sandbox prevents it. Do not try alternative operations after a denial. Never spawn agents.';
  const native = Thread.parse(await rpc.request('thread/start', {
    ...params(), baseInstructions: nativeInstructions, developerInstructions: nativeInstructions,
    approvalPolicy: 'on-request',
    config: { ...threadConfig(inherited, service.url, binding.token), 'features.shell_tool': true },
  }));
  const Approval = z.object({ threadId: z.string(), turnId: z.string(), command: z.string(), cwd: z.string() });
  for (const decision of ['accept', 'decline'] as const) {
    const filename = decision === 'accept' ? 'approved-note.txt' : 'rejected-note.txt';
    const expected = `printf 'synthetic' > ${filename}`;
    let asked = false;
    rpc.onRequest = async (method, raw) => {
      assert.equal(method, 'item/commandExecution/requestApproval');
      const request = Approval.parse(raw);
      assert.equal(request.threadId, native.thread.id);
      assert.equal(request.cwd, workspace);
      assert(['/bin/zsh', '/bin/bash', '/bin/sh'].some((shell) => request.command === `${shell} -c \"${expected}\"`), 'Probe approves only an exact synthetic command in a non-login shell');
      asked = true;
      return { decision };
    };
    await turn(native.thread.id, `Run exactly this shell command: ${expected}. Request approval for this write. If rejected, stop without trying another tool or command.`, { approvalPolicy: 'on-request' });
    assert(asked, 'Expected a provider approval request');
    if (decision === 'accept') assert.equal(await readFile(join(workspace, filename), 'utf8'), 'synthetic');
    else await assert.rejects(readFile(join(workspace, filename)), { code: 'ENOENT' });
    pass(`native synthetic file operation ${decision === 'accept' ? 'approved and executed' : 'rejected without effect'}`);
  }

  // Hold a real approval request so interruption cannot race a fast completion.
  const pendingApproval = Promise.withResolvers<z.infer<typeof Approval>>();
  const decision = Promise.withResolvers<unknown>();
  rpc.onRequest = async (method, raw) => {
    assert.equal(method, 'item/commandExecution/requestApproval');
    pendingApproval.resolve(Approval.parse(raw));
    return decision.promise;
  };
  const interrupted = rpc.waitFor((event) => event.method === 'turn/completed' && Completed.parse(event.params).threadId === native.thread.id);
  void interrupted.catch(() => {});
  await rpc.request('turn/start', {
    threadId: native.thread.id, input: [{ type: 'text', text: "Run exactly: printf 'synthetic' > interrupted-note.txt. Request approval for this write." }], permissions: permissionProfile, approvalPolicy: 'on-request',
  });
  const request = await Promise.race([pendingApproval.promise, interrupted.then(() => { throw new Error('Turn ended before approval'); })]);
  await rpc.request('turn/interrupt', { threadId: request.threadId, turnId: request.turnId });
  assert.equal(Completed.parse((await interrupted).params).turn.status, 'interrupted');
  decision.resolve({ decision: 'decline' });
  await assert.rejects(readFile(join(workspace, 'interrupted-note.txt')), { code: 'ENOENT' });
  pass('active turn interruption cancels pending approval without effect');

  const crashApproval = Promise.withResolvers<z.infer<typeof Approval>>();
  const crashDecision = Promise.withResolvers<unknown>();
  rpc.onRequest = async (method, raw) => {
    assert.equal(method, 'item/commandExecution/requestApproval');
    crashApproval.resolve(Approval.parse(raw));
    return crashDecision.promise;
  };
  const crashing = turn(native.thread.id, "Run exactly: printf 'synthetic' > crashed-note.txt. Request approval for this write.", { approvalPolicy: 'on-request' });
  void crashing.catch(() => {});
  const crashedRequest = await Promise.race([crashApproval.promise, crashing.then(() => { throw new Error('Turn ended before approval'); })]);
  await rpc.close('SIGKILL');
  crashDecision.resolve({ decision: 'decline' });
  await assert.rejects(crashing);
  rpc = await start();
  const recovered = z.object({ data: z.array(z.object({ id: z.string(), status: z.string() })) }).parse(await rpc.request('thread/turns/list', { threadId: native.thread.id, limit: 10 }));
  const lostTurn = recovered.data.find((entry) => entry.id === crashedRequest.turnId);
  assert(lostTurn, 'Interrupted attempt must remain inspectable');
  assert.notEqual(lostTurn.status, 'completed');
  await assert.rejects(readFile(join(workspace, 'crashed-note.txt')), { code: 'ENOENT' });
  pass(`abrupt provider exit leaves inspectable ${lostTurn.status} turn; no automatic replay`);
  console.log(JSON.stringify({ checks, completed: checks.length }, null, 2));
} finally {
  binding.revoke();
  if (rpc!) await rpc.close();
  await service.close();
}
