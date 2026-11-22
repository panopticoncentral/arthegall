import Fastify, { type FastifyRequest, type RouteHandlerMethod } from 'fastify';
import websocket from '@fastify/websocket';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { BackupSettings, RetentionDays, RunActivityPage, RunnerFrame, Snapshot } from '../../../packages/contracts/src/index.js';
import type { DailyBackups } from '../../../scripts/daily-backups.js';
import type { Scan } from './restore-recovery.js';
import { Conflict, ServerStore } from './store.js';
import { EditDefinition, ReportingSettings } from '../../../packages/contracts/src/reporting.js';

export async function createServer(store: ServerStore, origin: string, backups?: DailyBackups) {
  const expected = new URL(origin);
  if (expected.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(expected.hostname)) throw new Error('Remote client access requires HTTPS');
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  const clients = new Map<WebSocket, { token: string; cursor: number }>();
  const runners = new Map<WebSocket, { runnerId: string; ready: boolean; retention?: boolean; nextCleanup: number; scan?: Scan }>();
  store.recovery.offline();
  const alive = new Set<WebSocket>();
  const track = (socket: WebSocket) => {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    socket.once('close', () => alive.delete(socket));
  };
  const heartbeat = setInterval(() => {
    for (const socket of [...clients.keys(), ...runners.keys()]) {
      if (!alive.delete(socket)) socket.terminate();
      else if (socket.readyState === 1) socket.ping();
    }
  }, 15_000);
  const send = (socket: WebSocket, value: unknown) => { if (socket.readyState === 1 && socket.bufferedAmount < 512 * 1024) socket.send(JSON.stringify(value)); };
  const tick = () => {
    for (const [socket, client] of clients) {
      if (!store.session(client.token)) { socket.close(1008, 'Session revoked'); continue; }
      for (const event of store.events(client.cursor)) {
        const item = z.object({ sequence: z.number() }).parse(event);
        if (socket.bufferedAmount >= 512 * 1024) { socket.close(1013, 'Reload snapshot'); break; }
        send(socket, { type: 'event', ...event as object });
        client.cursor = item.sequence;
      }
    }
    for (const [socket, runner] of runners) {
      if (!runner.ready || store.recovery.paused()) continue;
      const dispatch = store.nextDispatch(runner.runnerId);
      if (dispatch) send(socket, dispatch);
      if (runner.retention && Date.now() >= runner.nextCleanup) {
        const prune = store.retention.next(runner.runnerId);
        runner.nextCleanup = Date.now() + (prune ? 60_000 : 30_000);
        if (prune) send(socket,prune);
      }
      for (const decision of store.decisions(runner.runnerId)) send(socket, decision);
    }
  };
  const timer = setInterval(() => {
    try { tick(); } catch { for (const socket of runners.keys()) socket.close(1011, 'Storage unavailable'); }
  }, 500);
  const runScheduler = () => {
    if (!store.recovery.paused()) store.scheduler.tick();
  };
  const scheduleTimer = setInterval(() => {
    try { runScheduler(); } catch (error) { app.log.error({ err: error }, 'Schedule tick failed'); }
  }, 500);
  app.addHook('onReady', async () => { runScheduler(); });
  if (backups) {
    const timer = setInterval(() => { void backups.tick(); }, 30_000);
    app.addHook('onReady', async () => { void backups.tick(); });
    app.addHook('preClose', async () => { clearInterval(timer); await backups.close(); });
  }
  app.addHook('preClose', async () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    clearInterval(scheduleTimer);
    const sockets = [...clients.keys(), ...runners.keys()];
    clients.clear(); runners.clear();
    for (const socket of sockets) socket.terminate();
  });
  // Require a native token, even when a historical browser session still exists.
  function appToken(request: FastifyRequest) {
    const auth = request.headers.authorization;
    return auth?.startsWith('Bearer app.') ? auth.slice(7) : '';
  }
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.host !== expected.host) return reply.code(403).send({ error: 'Unrecognized host' });
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    const route = request.routeOptions.url;
    if (!route?.startsWith('/client/v1/')) return;
    if (request.headers.origin && request.headers.origin !== expected.origin) return reply.code(403).send({ error: 'Unrecognized origin' });
    if (request.headers['x-arthegall-client'] !== '1') return reply.code(400).send({ error: 'Client protocol version 1 required' });
    if (route !== '/client/v1/pair' && !store.session(appToken(request))) return reply.code(401).send({ error: 'Pair this app to continue' });
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request' });
    if (error instanceof Conflict) return reply.code(409).send({ error: error.message });
    return reply.code(500).send({ error: 'Request could not be saved. It is safe to retry the same command.' });
  });
  const pairingCode = z.strictObject({ code: z.string().trim().min(1).max(128) });
  app.post('/client/v1/pair', async (request, reply) => {
    const { code } = pairingCode.parse(request.body);
    const session = store.pair(code, request.ip);
    if (!session) return reply.code(400).send({ error: 'Code invalid, expired, or temporarily rate limited' });
    return { version: 1, sessionId: session.id, token: session.token };
  });
  const snapshot = (sessionId: string) => Snapshot.parse({ ...store.snapshot(), backups: backups?.status(),
    // Pairing events distinguish existing app tokens without rewriting historical session rows.
    pairings: store.db.prepare(`SELECT expires,id=? AS current FROM browser_sessions WHERE expires>? AND revoked=0
      AND id IN (SELECT json_extract(data,'$.sessionId') FROM events WHERE kind='app_paired')
      ORDER BY current DESC,expires DESC`).all(sessionId, Date.now()),
    runnerConnected: [...runners.values()].some((runner) => runner.ready) });
  app.get('/client/v1/snapshot', async request => ({ ...snapshot(store.session(appToken(request))!),
    settingsVersion: 1, commandApprovalsVersion: 1, recoveryVersion: 1 }));
  app.post('/client/v1/messages', async request => store.send(store.session(appToken(request))!, request.body));
  app.post('/client/v1/revoke', async request => {
    store.revokeSession(store.session(appToken(request))!);
    tick();
    return { revoked: true };
  });
  app.get('/client/v1/runs/:id/activity', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { before } = z.object({ before: z.coerce.number().int().positive().optional() }).parse(request.query);
    return RunActivityPage.parse(store.runActivity(id, before));
  });
  const checkApprovalChanges = async () => {
    if (store.recovery.paused()) throw new Conflict('Review runner records before changing approvals or assignments');
  };
  function settingsPost(path: string, handler: RouteHandlerMethod, options = { allowDuringRecovery: false }) {
    const hooks = options.allowDuringRecovery ? {} : { preHandler: checkApprovalChanges };
    app.post('/client/v1' + path, hooks, handler);
  }
  function settingsSession(request: FastifyRequest) {
    return store.session(appToken(request))!;
  }
  if (backups) {
    settingsPost('/backups/settings', async request => {
      backups.configure(BackupSettings.parse(request.body));
      void backups.tick();
      return { saved: true };
    }, { allowDuringRecovery: true });
    settingsPost('/backups/retry', async () => {
      backups.retry();
      void backups.tick();
      return { saved: true };
    }, { allowDuringRecovery: true });
  }
  settingsPost('/recovery/resume', async () => {
    store.recovery.resume();
    return { saved: true };
  }, { allowDuringRecovery: true });
  settingsPost('/recovery/recheck', async () => {
    if (store.recovery.paused()) for (const [socket, runner] of runners) {
      store.recovery.offline(runner.runnerId);
      socket.terminate();
    }
    return { saved: true };
  }, { allowDuringRecovery: true });
  const readSettings: RouteHandlerMethod = async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return store.db.transaction(() => ReportingSettings.parse(store.reporting.settings(id)))();
  };
  app.get('/client/v1/conversations/:id/settings', readSettings);
  settingsPost('/conversations/:id/definition', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { revision, instructions } = EditDefinition.parse(request.body);
    store.db.transaction(() => {
      const agent = store.reporting.assignment(id);
      if (!agent.assignmentInstructions || agent.closed) throw new Conflict('Select an open reporting assignment');
      if (agent.instructions === instructions) return;
      if (agent.revision !== revision) throw new Conflict('The agent definition has changed. Cancel to review the latest revision before editing.');
      store.reporting.revise(agent.agentId, instructions, null, settingsSession(request));
    })();
    return { saved: true };
  });
  settingsPost('/retention', async request => {
    const { days } = z.strictObject({days: RetentionDays}).parse(request.body);
    store.retention.configure(days);
    for (const runner of runners.values()) runner.nextCleanup = 0;
    return { saved: true };
  });
  settingsPost('/runs/:id/pin', async request => {
    const { id } = z.object({id:z.uuid()}).parse(request.params);
    const { pinned } = z.strictObject({pinned:z.boolean()}).parse(request.body);
    store.retention.pin(id,pinned);
    for (const runner of runners.values()) runner.nextCleanup = 0;
    return { saved: true };
  });
  settingsPost('/approvals/:id', async request => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { decision } = z.strictObject({ decision: z.enum(['accept', 'decline']) }).parse(request.body);
    store.decide(settingsSession(request), id, decision);
    return { saved: true };
  });
  settingsPost('/conversations/:id/close', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    store.reporting.closeAssignment(id, settingsSession(request));
    return { saved: true };
  });
  settingsPost('/access/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { decision, duration } = z.strictObject({ decision: z.enum(['accept','decline']), duration: z.enum(['run','assignment']) }).parse(request.body);
    store.db.transaction(() => store.reporting.decide(settingsSession(request), id, decision, duration))();
    return { saved: true };
  });
  function subscribe(socket: WebSocket, request: FastifyRequest, token: string) {
    const sessionId = store.session(token);
    const query = z.object({ after: z.coerce.number().int().min(0).default(0) }).safeParse(request.query);
    if (!sessionId || !query.success) { socket.close(1008); return; }
    clients.set(socket, { token, cursor: query.data.after });
    track(socket);
    socket.on('close', () => clients.delete(socket));
    tick();
  }
  app.get('/client/v1/events', { websocket: true }, (socket, request) => subscribe(socket, request, appToken(request)));
  app.get('/runner', { websocket: true }, (socket, request) => {
    if (request.headers.origin) { socket.close(1008); return; }
    const auth = request.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    const runnerId = request.headers['x-arthegall-runner'];
    if (typeof runnerId !== 'string' || !store.authenticateRunner(runnerId, token)) { socket.close(1008); return; }
    for (const [other, binding] of runners) if (binding.runnerId === runnerId) { runners.delete(other); other.close(1000, 'Runner reconnected'); }
    store.recovery.offline(runnerId);
    runners.set(socket, { runnerId, ready: false, nextCleanup: 0 });
    track(socket);
    socket.on('message', (raw) => {
      try {
        const frame = RunnerFrame.parse(JSON.parse(raw.toString()));
        const binding = runners.get(socket);
        if (!binding) throw new Error('Superseded connection');
        if (frame.type === 'hello') {
          if (frame.runnerId !== runnerId) throw new Error('Identity mismatch');
          if (binding.ready) throw new Error('Duplicate handshake');
          binding.ready = true;
          binding.retention = frame.retentionVersion === 1;
          if (store.recovery.paused()) {
            if (!frame.inventoryVersion) { store.recovery.unsupported(runnerId); return; }
            store.recovery.begin(runnerId);
            binding.scan = { received: 0, failed: false };
            send(socket, { type: 'inventory_next', version: 1 });
          }
        } else if (!binding.ready) throw new Error('Handshake required');
        else if (frame.type === 'inventory') {
          if (!binding.scan || !store.recovery.paused()) throw new Error('Unexpected inventory');
          store.recovery.apply(runnerId, binding.scan, frame.item);
          if (frame.item.kind === 'end') delete binding.scan;
          else send(socket, { type: 'inventory_next', version: 1 });
        } else if (store.recovery.paused() && frame.type !== 'status') return;
        else if (frame.type === 'prune_result') {
          store.retention.result(runnerId,frame.runId,frame.dispatchId,frame.error);
          binding.nextCleanup = 0;
        } else if (frame.type === 'accepted') store.accept(runnerId, frame.dispatchId);
        else if (frame.type === 'delivery') {
          const result = store.receive(runnerId, frame);
          send(socket, { type: 'receipt', version: 1, deliveryId: frame.deliveryId, result });
        } else if (frame.type === 'decision_ack') store.acknowledgeDecision(runnerId, frame.approvalId);
        else if (frame.type === 'status') store.runnerStatus(runnerId, frame.status);
      } catch { socket.close(1008, 'Invalid delivery or storage failure'); }
    });
    socket.on('close', () => {
      if (runners.delete(socket)) { store.recovery.offline(runnerId); store.runnerStatus(runnerId, 'unavailable'); }
    });
  });
  return app;
}
