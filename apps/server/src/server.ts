import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import type { WebSocket } from 'ws';
import { z } from 'zod';
import { RunnerFrame, SendMessage, Snapshot } from '../../../packages/contracts/src/index.js';
import { Conflict, ServerStore } from './store.js';

export async function createServer(store: ServerStore, origin: string, webRoot?: string) {
  const expected = new URL(origin);
  if (expected.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(expected.hostname)) throw new Error('Remote browser access requires HTTPS');
  const app = Fastify({ logger: false, bodyLimit: 128 * 1024 });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 256 * 1024 } });
  const browsers = new Map<WebSocket, { sessionId: string; token: string; cursor: number }>();
  const runners = new Map<WebSocket, { runnerId: string; ready: boolean }>();
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
      if (!runner.ready) continue;
      const dispatch = store.nextDispatch(runner.runnerId);
      if (dispatch) send(socket, dispatch);
      for (const decision of store.decisions(runner.runnerId)) send(socket, decision);
    }
  };
  const timer = setInterval(() => {
    try { tick(); } catch { for (const socket of runners.keys()) socket.close(1011, 'Storage unavailable'); }
  }, 500);
  app.addHook('preClose', async () => {
    clearInterval(timer);
    clearInterval(heartbeat);
    const sockets = [...browsers.keys(), ...runners.keys()];
    browsers.clear(); runners.clear();
    for (const socket of sockets) socket.terminate();
  });
  app.addHook('onRequest', async (request, reply) => {
    if (request.headers.host !== expected.host) return reply.code(403).send({ error: 'Unrecognized host' });
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    if (request.url.startsWith('/runner')) return;
    if ((!['GET', 'HEAD'].includes(request.method) || request.url.startsWith('/events')) && request.headers.origin !== expected.origin) return reply.code(403).send({ error: 'Unrecognized origin' });
    if (request.url.startsWith('/api/') && request.url !== '/api/pair') {
      if (!store.session(request.cookies.arthegall ?? '')) return reply.code(401).send({ error: 'Pair this browser to continue' });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'Invalid request' });
    if (error instanceof Conflict) return reply.code(409).send({ error: error.message });
    return reply.code(500).send({ error: 'Request could not be saved. It is safe to retry the same command.' });
  });
  app.post('/api/pair', async (request, reply) => {
    const { code } = z.strictObject({ code: z.string().trim().min(1).max(128) }).parse(request.body);
    const session = store.pair(code, request.ip);
    if (!session) return reply.code(400).send({ error: 'Code invalid, expired, or temporarily rate limited' });
    reply.setCookie('arthegall', session.token, { path: '/', httpOnly: true, sameSite: 'strict', secure: expected.protocol === 'https:', maxAge: 365 * 24 * 60 * 60 });
    return { paired: true };
  });
  app.get('/api/snapshot', async () => Snapshot.parse({ ...store.snapshot(), runnerConnected: [...runners.values()].some((runner) => runner.ready) }));
  app.get('/api/activity', async (request) => {
    const query = z.object({ after: z.coerce.number().int().min(0).default(0) }).parse(request.query);
    return store.events(query.after);
  });
  app.post('/api/messages', async (request) => store.send(store.session(request.cookies.arthegall ?? '')!, SendMessage.parse(request.body)));
  app.post('/api/approvals/:id', async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const { decision } = z.strictObject({ decision: z.enum(['accept', 'decline']) }).parse(request.body);
    store.decide(store.session(request.cookies.arthegall ?? '')!, id, decision);
    return { saved: true };
  });
  app.post('/api/revoke', async (request, reply) => {
    store.revokeSession(store.session(request.cookies.arthegall ?? '')!);
    reply.clearCookie('arthegall', { path: '/' });
    tick();
    return { revoked: true };
  });
  app.get('/events', { websocket: true }, (socket, request) => {
    const token = request.cookies.arthegall ?? '';
    const sessionId = store.session(token);
    const query = z.object({ after: z.coerce.number().int().min(0).default(0) }).safeParse(request.query);
    if (!sessionId || !query.success) { socket.close(1008); return; }
    browsers.set(socket, { sessionId, token, cursor: query.data.after });
    track(socket);
    socket.on('close', () => browsers.delete(socket));
    tick();
  });
  app.get('/runner', { websocket: true }, (socket, request) => {
    if (request.headers.origin) { socket.close(1008); return; }
    const auth = request.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : '';
    const runnerId = request.headers['x-arthegall-runner'];
    if (typeof runnerId !== 'string' || !store.authenticateRunner(runnerId, token)) { socket.close(1008); return; }
    for (const [other, binding] of runners) if (binding.runnerId === runnerId) { runners.delete(other); other.close(1000, 'Runner reconnected'); }
    runners.set(socket, { runnerId, ready: false });
    track(socket);
    socket.on('message', (raw) => {
      try {
        const frame = RunnerFrame.parse(JSON.parse(raw.toString()));
        const binding = runners.get(socket);
        if (!binding) throw new Error('Superseded connection');
        if (frame.type === 'hello') {
          if (frame.runnerId !== runnerId) throw new Error('Identity mismatch');
          binding.ready = true;
        } else if (!binding.ready) throw new Error('Handshake required');
        else if (frame.type === 'accepted') store.accept(runnerId, frame.dispatchId);
        else if (frame.type === 'delivery') {
          store.receive(runnerId, frame);
          send(socket, { type: 'receipt', version: 1, deliveryId: frame.deliveryId });
        } else if (frame.type === 'decision_ack') store.acknowledgeDecision(runnerId, frame.approvalId);
        else if (frame.type === 'status') store.runnerStatus(runnerId, frame.status);
      } catch { socket.close(1008, 'Invalid delivery or storage failure'); }
    });
    socket.on('close', () => {
      if (runners.delete(socket)) store.runnerStatus(runnerId, 'unavailable');
    });
  });
  if (webRoot) {
    await app.register(staticFiles, { root: webRoot });
    app.get('/', async (_request, reply) => reply.sendFile('index.html'));
  }
  return app;
}
