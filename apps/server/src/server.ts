import Fastify, { type FastifyRequest, type RouteHandlerMethod } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { BackupSettings, RetentionDays, RunnerFrame, SendMessage, Snapshot } from '../../../packages/contracts/src/index.js';
import type { DailyBackups } from '../../../scripts/daily-backups.js';
import type { Scan } from './restore-recovery.js';
import { Conflict, ServerStore } from './store.js';
import { EditDefinition, ReportingSettings, ScheduleRequest } from '../../../packages/contracts/src/reporting.js';

export async function createServer(store: ServerStore, origin: string, webRoot?: string, backups?: DailyBackups) {
  const expected = new URL(origin);
  if (expected.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(expected.hostname)) throw new Error('Remote browser access requires HTTPS');
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  const browsers = new Map<WebSocket, { sessionId: string; token: string; cursor: number }>();
  const runners = new Map<WebSocket, { runnerId: string; ready: boolean; retention?: boolean; nextCleanup: number; scan?: Scan }>();
  store.recovery.offline();
  const alive = new Set<WebSocket>();
  const track = (socket: WebSocket) => {
    alive.add(socket);
    socket.on('pong', () => alive.add(socket));
    socket.once('close', () => alive.delete(socket));
  };
  const heartbeat = setInterval(() => {
    for (const socket of [...browsers.keys(), ...runners.keys()]) {
      if (!alive.delete(socket)) socket.terminate();
      else if (socket.readyState === 1) socket.ping();
    }
  }, 15_000);
  const send = (socket: WebSocket, value: unknown) => { if (socket.readyState === 1 && socket.bufferedAmount < 512 * 1024) socket.send(JSON.stringify(value)); };
  const tick = () => {
    for (const [socket, browser] of browsers) {
      if (!store.session(browser.token)) { socket.close(1008, 'Session revoked'); continue; }
      for (const event of store.events(browser.cursor)) {
        const item = z.object({ sequence: z.number() }).parse(event);
        if (socket.bufferedAmount >= 512 * 1024) { socket.close(1013, 'Reload snapshot'); break; }
        send(socket, { type: 'event', ...event as object });
        browser.cursor = item.sequence;
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
  if (backups) {
    const timer = setInterval(() => { void backups.tick(); }, 30_000);
    app.addHook('onReady', async () => { void backups.tick(); });
    app.addHook('preClose', async () => { clearInterval(timer); await backups.close(); });
  }
  app.addHook('preClose', async () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    const sockets = [...browsers.keys(), ...runners.keys()];
    browsers.clear(); runners.clear();
    for (const socket of sockets) socket.terminate();
  });
  // The prefix is part of the hashed secret. A cookie cannot authenticate an app or vice versa.
  function appToken(request: FastifyRequest) {
    const auth = request.headers.authorization;
    return auth?.startsWith('Bearer app.') ? auth.slice(7) : '';
  }
  function browserToken(request: FastifyRequest) {
    const token = request.cookies.arthegall ?? '';
    return token.startsWith('app.') ? '' : token;
  }
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.host !== expected.host) return reply.code(403).send({ error: 'Unrecognized host' });
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (request.url.startsWith('/runner')) return;
    const route = request.routeOptions.url;
    if (route?.startsWith('/client/v1/')) {
      if (request.headers.origin && request.headers.origin !== expected.origin) return reply.code(403).send({ error: 'Unrecognized origin' });
      if (request.headers['x-arthegall-client'] !== '1') return reply.code(400).send({ error: 'Client protocol version 1 required' });
      if (route !== '/client/v1/pair' && !store.session(appToken(request))) return reply.code(401).send({ error: 'Pair this app to continue' });
      return;
    }
    if ((!['GET', 'HEAD'].includes(request.method) || request.url.startsWith('/events')) && request.headers.origin !== expected.origin) return reply.code(403).send({ error: 'Unrecognized origin' });
    if (request.url.startsWith('/api/') && request.url !== '/api/pair') {
      if (!store.session(browserToken(request))) return reply.code(401).send({ error: 'Pair this browser to continue' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request' });
    if (error instanceof Conflict) return reply.code(409).send({ error: error.message });
    return reply.code(500).send({ error: 'Request could not be saved. It is safe to retry the same command.' });
  });
  const pairingCode = z.strictObject({ code: z.string().trim().min(1).max(128) });
  app.post('/client/v1/pair', async (request, reply) => {
    const { code } = pairingCode.parse(request.body);
    const session = store.pair(code, request.ip, Date.now(), 'app');
    if (!session) return reply.code(400).send({ error: 'Code invalid, expired, or temporarily rate limited' });
    return { version: 1, sessionId: session.id, token: session.token };
  });
  app.post('/api/pair', async (request, reply) => {
    const { code } = pairingCode.parse(request.body);
    const session = store.pair(code, request.ip);
    if (!session) return reply.code(400).send({ error: 'Code invalid, expired, or temporarily rate limited' });
    reply.setCookie('arthegall', session.token, { path: '/', httpOnly: true, sameSite: 'strict', secure: expected.protocol === 'https:', maxAge: 365 * 24 * 60 * 60 });
    return { paired: true };
  });
  const snapshot = (sessionId: string) => Snapshot.parse({ ...store.snapshot(), backups: backups?.status(),
    pairings: store.db.prepare('SELECT expires,id=? AS current FROM browser_sessions WHERE expires>? AND revoked=0 ORDER BY current DESC,expires DESC')
      .all(sessionId, Date.now()),
    runnerConnected: [...runners.values()].some((runner) => runner.ready) });
  app.get('/api/snapshot', async request => snapshot(store.session(browserToken(request))!));
  app.get('/client/v1/snapshot', async request => ({ ...snapshot(store.session(appToken(request))!), settingsVersion: 1, commandApprovalsVersion: 1 }));
  app.post('/client/v1/messages', async request => store.send(store.session(appToken(request))!, request.body));
  app.post('/client/v1/revoke', async request => {
    store.revokeSession(store.session(appToken(request))!);
    tick();
    return { revoked: true };
  });
  app.get('/api/activity', async (request) => {
    const query = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return store.events(query.after);
  });
  const checkApprovalChanges = async () => {
    if (store.recovery.paused()) throw new Conflict('Review runner records before changing approvals or assignments');
  };
  function settingsPost(path: string, handler: RouteHandlerMethod, options = { allowDuringRecovery: false }) {
    const hooks = options.allowDuringRecovery ? {} : { preHandler: checkApprovalChanges };
    app.post('/api' + path, hooks, handler);
    app.post('/client/v1' + path, hooks, handler);
  }
  function settingsSession(request: FastifyRequest) {
    const token = request.routeOptions.url?.startsWith('/client/v1/') ? appToken(request) : browserToken(request);
    return store.session(token)!;
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
  app.post('/api/recovery/resume', async () => {
    store.recovery.resume();
    return { saved: true };
  });
  app.post('/api/recovery/recheck', async () => {
    if (store.recovery.paused()) for (const [socket, runner] of runners) {
      store.recovery.offline(runner.runnerId);
      socket.terminate();
    }
    return { saved: true };
  });
  app.post('/api/messages', async (request) => store.send(store.session(browserToken(request))!, SendMessage.parse(request.body)));
  const readSettings: RouteHandlerMethod = async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    return store.db.transaction(() => ReportingSettings.parse(store.reporting.settings(id)))();
  };
  app.get('/api/conversations/:id/settings', readSettings);
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
  settingsPost('/conversations/:id/schedule', async request => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { time, activeId, backfill } = ScheduleRequest.pick({ time: true }).extend({ activeId: z.uuid().nullable(), backfill: z.boolean() }).parse(request.body);
    store.db.transaction(() => {
      const agent = store.reporting.assignment(id);
      if (!agent.assignmentInstructions || agent.closed) throw new Conflict('Select an open reporting assignment');
      const schedules = store.db.prepare("SELECT id,state,time,backfill FROM report_schedules WHERE assignment_id=? AND state IN ('active','pending')")
        .all(agent.assignmentId) as { id: string; state: string; time: string; backfill: number }[];
      const pending = schedules.find(s => s.state === 'pending');
      const active = schedules.find(s => s.state === 'active');
      if (pending?.time === time && Boolean(pending.backfill) === backfill) return;
      if (!pending && active?.time === time && Boolean(active.backfill) === backfill) return;
      if (pending || (active?.id ?? null) !== activeId) throw new Conflict('The schedule changed. Review the current schedule before proposing another change.');
      const runnerId = store.db.prepare("SELECT value FROM metadata WHERE key='runner'").pluck().get() as string;
      store.scheduler.propose(agent.assignmentId, runnerId, time, backfill, { sessionId: settingsSession(request) });
    })();
    return { saved: true };
  });
  settingsPost('/retention', async request => {
    const { days } = z.strictObject({days: RetentionDays}).parse(request.body);
    store.retention.configure(days);
    for (const runner of runners.values()) runner.nextCleanup = 0;
    return { saved: true };
  });
  app.post('/api/runs/:id/pin', { preHandler: checkApprovalChanges }, async request => {
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
  settingsPost('/schedules/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { decision } = z.strictObject({ decision: z.enum(['accept','decline']) }).parse(request.body);
    store.scheduler.decide(id, settingsSession(request), decision === 'accept');
    return { saved: true };
  });
  settingsPost('/access/:id', async (request) => {
    const { id } = z.object({ id: z.uuid() }).parse(request.params);
    const { decision, duration } = z.strictObject({ decision: z.enum(['accept','decline']), duration: z.enum(['run','assignment']) }).parse(request.body);
    store.db.transaction(() => store.reporting.decide(settingsSession(request), id, decision, duration))();
    return { saved: true };
  });
  app.post('/api/revoke', async (request, reply) => {
    store.revokeSession(store.session(browserToken(request))!);
    reply.clearCookie('arthegall', { path: '/' });
    tick();
    return { revoked: true };
  });
  function subscribe(socket: WebSocket, request: FastifyRequest, token: string) {
    const sessionId = store.session(token);
    const query = z.object({ after: z.coerce.number().int().min(0).default(0) }).safeParse(request.query);
    if (!sessionId || !query.success) { socket.close(1008); return; }
    browsers.set(socket, { sessionId, token, cursor: query.data.after });
    track(socket);
    socket.on('close', () => browsers.delete(socket));
    tick();
  }
  app.get('/events', { websocket: true }, (socket, request) => subscribe(socket, request, browserToken(request)));
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
  if (webRoot) {
    await app.register(staticFiles, { root: webRoot });
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  }
  return app;
}
