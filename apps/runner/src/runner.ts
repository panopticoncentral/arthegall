import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { z } from 'zod';
import { Dispatch, Outcome, ServerFrame } from '../../../packages/contracts/src/index.js';
import { CodexRpc } from './codex/rpc.js';
import { launchArgs, providerEnvironment, threadConfig } from './codex/config.js';
import { startToolService } from './mcp.js';
import { RunnerStore } from './store.js';

export type RunnerOptions = { runnerId: string; token: string; serverUrl: string; workspaceRoot: string; codex?: string; fake?: boolean };
const Turn = z.object({ threadId: z.string(), turn: z.object({ id: z.string(), status: z.string() }) });
class SignInNeeded extends Error {}

export async function startRunner(store: RunnerStore, options: RunnerOptions) {
  const service = await startToolService();
  let socket: WebSocket | undefined;
  let rpc: CodexRpc | undefined;
  let stopping = false, working = false, recovered = false;
  let status: 'ready' | 'sign_in_needed' | 'unavailable' = 'unavailable';
  let alive = true, nextConnectAt = 0;
  const approvals = new Map<string, { runId: string; resolve: (decision: unknown) => void }>();
  const send = (value: unknown) => {
    if (socket?.readyState === WebSocket.OPEN && socket.bufferedAmount < 512 * 1024) socket.send(JSON.stringify(value));
  };
  const setStatus = (value: typeof status) => { if (status !== value) { status = value; send({ type: 'status', version: 1, status }); } };
  const url = new URL('/runner', options.serverUrl);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('Remote runner access requires HTTPS');
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const connect = () => {
    if (stopping || Date.now() < nextConnectAt || socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    nextConnectAt = Date.now() + 1_000;
    const connection = new WebSocket(url, { headers: { Authorization: `Bearer ${options.token}`, 'X-Arthegall-Runner': options.runnerId }, maxPayload: 256 * 1024 });
    socket = connection;
    connection.on('open', () => {
      alive = true;
      send({ type: 'hello', version: 1, runnerId: options.runnerId });
      send({ type: 'status', version: 1, status });
    });
    connection.on('message', (raw) => {
      if (stopping) return;
      try {
        const frame = ServerFrame.parse(JSON.parse(raw.toString()));
        if (frame.type === 'dispatch') {
          const dispatch = store.accept(frame);
          send({ type: 'accepted', version: 1, dispatchId: dispatch.dispatchId });
        } else if (frame.type === 'receipt') store.acknowledge(frame.deliveryId);
        else {
          const decision = store.decision(frame);
          const pending = approvals.get(decision.approvalId);
          if (pending && pending.runId === decision.runId) {
            pending.resolve({ decision: decision.decision }); approvals.delete(decision.approvalId);
          }
          send({ type: 'decision_ack', version: 1, approvalId: decision.approvalId });
        }
      } catch { connection.close(1008, 'Invalid delivery or storage failure'); }
    });
    connection.on('error', () => {}); // Reconnect timer; never log bearer credentials.
    connection.on('pong', () => { alive = true; });
  };
  async function provider(workspace: string) {
    const permissionProfile = `arthegall_${randomUUID()}`;
    rpc = new CodexRpc(options.codex ?? 'codex', launchArgs(permissionProfile), workspace, providerEnvironment(process.env));
    await rpc.initialize();
    const account = z.object({ account: z.unknown().nullable() }).parse(await rpc.request('account/read', { refreshToken: false }));
    if (account.account === null) throw new SignInNeeded();
    const config = z.object({ config: z.object({ mcp_servers: z.record(z.string(), z.unknown()).nullable().optional() }) }).parse(await rpc.request('config/read', { includeLayers: false }));
    const models = z.object({ data: z.array(z.object({ model: z.string(), isDefault: z.boolean(), defaultReasoningEffort: z.string() })) }).parse(await rpc.request('model/list', { limit: 100 }));
    const model = models.data.find((entry) => entry.isDefault);
    if (!model) throw new Error('No default provider configuration');
    return { rpc, model, permissionProfile, inherited: config.config.mcp_servers ?? {} };
  }
  async function recover() {
    for (const run of store.interrupted()) {
      let outcome: Outcome = { status: 'blocked', message: `${run.text.slice(0, 28_000)}\n\nExecution was interrupted. Its effects are uncertain; review activity before retrying.`.trim() };
      if (run.thread_id && run.turn_id && run.outcome && !options.fake) {
        try {
          const workspace = join(options.workspaceRoot, Dispatch.parse(JSON.parse(run.payload)).context.assignmentId);
          const connection = await provider(workspace);
          const turns = z.object({ data: z.array(z.object({ id: z.string(), status: z.string() })) }).parse(await connection.rpc.request('thread/turns/list', { threadId: run.thread_id, limit: 100 }));
          if (turns.data.some((turn) => turn.id === run.turn_id && turn.status === 'completed')) outcome = Outcome.parse(JSON.parse(run.outcome));
        } catch { /* Missing evidence is a blocked outcome, never an automatic replay. */ }
        finally { await rpc?.close(); rpc = undefined; }
      }
      store.finish(run.run_id, outcome);
    }
    recovered = true;
  }
  async function execute(dispatch: Dispatch) {
    const { context } = dispatch;
    const workspace = join(options.workspaceRoot, context.assignmentId);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    if (options.fake) {
      setStatus('ready');
      store.start(context.runId);
      store.publish(context.runId, { kind: 'activity', message: 'Deterministic test provider; no model was called.' });
      store.publish(context.runId, { kind: 'progress', text: 'Synthetic response in progress…' });
      if (context.messages.at(-1)?.text === '/test approval') {
        const approvalId = randomUUID();
        const decision = new Promise<unknown>((resolve) => approvals.set(approvalId, { runId: context.runId, resolve }));
        store.publish(context.runId, { kind: 'approval', approval: { approvalId, command: 'Synthetic test: read setup-note.txt' } });
        const result = z.object({ decision: z.enum(['accept', 'decline']) }).parse(await decision);
        store.finish(context.runId, { status: 'completed', message: `Synthetic approval ${result.decision === 'accept' ? 'accepted' : 'declined'}. No file operation was performed by this test provider.` });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
      store.finish(context.runId, { status: 'completed', message: `Synthetic response: ${context.messages.at(-1)?.text ?? ''}` });
      return;
    }
    let revoke: (() => void) | undefined;
    let unsubscribe: (() => void) | undefined;
    let flush: NodeJS.Timeout | undefined;
    try {
      const connection = await provider(workspace);
      setStatus('ready');
      store.start(context.runId); // Persist before any request that could start work.
      const binding = service.bind(context, async (outcome) => { store.stageOutcome(context.runId, outcome); });
      revoke = binding.revoke;
      const params = {
        cwd: workspace, runtimeWorkspaceRoots: [workspace], permissions: connection.permissionProfile, approvalPolicy: 'never', approvalsReviewer: 'user',
        model: connection.model.model, config: threadConfig(connection.inherited, service.url, binding.token),
        baseInstructions: 'You are an Arthegall agent. Use the runner MCP tools for context and explicit outcomes. Never spawn agents or use tools outside your grant.',
        developerInstructions: `${context.instructions}\nRead context first. Reply to the latest user message. Call report_outcome exactly once with the full user-facing answer in message. A provider turn ending alone does not complete the assignment.`,
      };
      const priorThread = store.session(context.assignmentId);
      const thread = z.object({ thread: z.object({ id: z.string() }), model: z.string() }).parse(await connection.rpc.request(priorThread ? 'thread/resume' : 'thread/start', priorThread ? { ...params, threadId: priorThread, excludeTurns: true } : params));
      store.mapThread(context.runId, context.assignmentId, thread.thread.id, thread.model, connection.model.defaultReasoningEffort);
      store.publish(context.runId, { kind: 'activity', message: `Codex ${thread.model}; effort ${connection.model.defaultReasoningEffort}; definition ${context.definitionVersion}.` });
      let text = '', savedText = '';
      const flushText = () => {
        if (text !== savedText) { store.publish(context.runId, { kind: 'progress', text }); savedText = text; }
      };
      unsubscribe = connection.rpc.subscribe((event) => {
        if (event.method === 'item/agentMessage/delta') {
          const delta = z.object({ threadId: z.string(), delta: z.string() }).parse(event.params);
          if (delta.threadId === thread.thread.id) text = (text + delta.delta).slice(0, 32_000);
        }
      });
      flush = setInterval(flushText, 250);
      // Default bootstrap configuration has no native shell. Any unexpected
      // request is denied; adding native execution requires a separate grant.
      connection.rpc.onRequest = async () => { throw new Error('Tool is outside bootstrap grant'); };
      const finished = connection.rpc.waitFor((event) => event.method === 'turn/completed' && Turn.parse(event.params).threadId === thread.thread.id, 10 * 60_000);
      void finished.catch(() => {});
      const started = z.object({ turn: z.object({ id: z.string() }) }).parse(await connection.rpc.request('turn/start', {
        threadId: thread.thread.id, input: [{ type: 'text', text: context.messages.at(-1)?.text ?? 'Read the current context.' }],
        permissions: connection.permissionProfile, approvalPolicy: 'never', effort: connection.model.defaultReasoningEffort,
      }));
      store.mapTurn(context.runId, started.turn.id);
      const terminal = Turn.parse((await finished).params);
      clearInterval(flush); flush = undefined;
      flushText();
      const outcome = store.execution(context.runId).outcome;
      if (terminal.turn.status !== 'completed' || !outcome) throw new Error('No explicit completed provider outcome');
      store.finish(context.runId, Outcome.parse(JSON.parse(outcome)));
    } catch (error) {
      if (error instanceof SignInNeeded) { setStatus('sign_in_needed'); return; }
      setStatus('unavailable');
      const run = store.execution(context.runId);
      if (run.state === 'running') {
        store.publish(context.runId, { kind: 'activity', message: 'Provider execution ended without confirmed completion. The saved thread and attempt require reconciliation; no automatic replay was attempted.' });
        store.finish(context.runId, { status: 'blocked', message: `${run.text.slice(0, 28_000)}\n\nCodex execution could not be confirmed. Review activity before asking for a retry.`.trim() });
      }
      // Startup failures leave work queued. The bounded polling interval permits
      // recovery after installation or sign-in without replaying started work.
    } finally {
      if (flush) clearInterval(flush);
      unsubscribe?.(); revoke?.();
      await rpc?.close(); rpc = undefined;
    }
  }
  let nextAttemptAt = 0;
  const tick = async () => {
    connect();
    const delivery = store.nextDelivery();
    if (delivery) send(delivery);
    if (working || stopping || Date.now() < nextAttemptAt) return;
    working = true;
    try {
      if (!recovered) await recover();
      const dispatch = store.queued();
      if (dispatch) { await execute(dispatch); nextAttemptAt = Date.now() + (status === 'ready' ? 0 : 5_000); }
    } finally { working = false; }
  };
  let active = Promise.resolve();
  const heartbeat = setInterval(() => {
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (!alive) socket.terminate();
    else { alive = false; socket.ping(); }
  }, 15_000);
  const timer = setInterval(() => {
    if (!working) active = tick().catch(() => { setStatus('unavailable'); });
    else {
      connect();
      const delivery = store.nextDelivery();
      if (delivery) send(delivery);
    }
  }, 250);
  connect();
  return {
    async close() {
      stopping = true; clearInterval(timer); clearInterval(heartbeat);
      socket?.terminate();
      for (const approval of approvals.values()) approval.resolve({ decision: 'decline' });
      await rpc?.close();
      await active;
      await service.close();
    },
  };
}
