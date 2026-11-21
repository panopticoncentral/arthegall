import { availablePort } from './helpers/port.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { ServerStore } from '../apps/server/src/store.js';
import { createServer } from '../apps/server/src/server.js';
import { RunnerStore } from '../apps/runner/src/store.js';
import { startRunner } from '../apps/runner/src/runner.js';

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean | Promise<boolean>) {
  for (let attempt = 0; attempt < 100; attempt++) { if (await predicate()) return; await pause(50); }
  throw new Error('Condition did not become true');
}
test('HTTP pairing, origin controls, snapshot-to-stream handoff and browser revocation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-http-test-'));
  const store = new ServerStore(join(root, 'server.sqlite'));
  store.setup('synthetic');
  const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
  const server = await createServer(store, origin);
  let ws: WebSocket | undefined;
  try {
    await server.listen({ host: '127.0.0.1', port });
    assert.equal((await fetch(`${origin}/api/snapshot`)).status, 401);
    const code = store.createPairingCode();
    const pair = await fetch(`${origin}/api/pair`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    assert.equal(pair.status, 200);
    const cookie = pair.headers.get('set-cookie')!.split(';')[0]!;
    assert(pair.headers.get('set-cookie')!.includes('HttpOnly'));
    const snapshot = await (await fetch(`${origin}/api/snapshot`, { headers: { Cookie: cookie } })).json() as { cursor: number };
    const command = { commandId: randomUUID(), text: 'Synthetic browser race' };
    assert.equal((await fetch(`${origin}/api/messages`, { method: 'POST', headers: { Cookie: cookie, Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: JSON.stringify(command) })).status, 403);
    assert.equal((await fetch(`${origin}/api/messages`, { method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(command) })).status, 200);
    const events: { sequence: number; kind: string }[] = [];
    ws = new WebSocket(`${origin.replace('http:', 'ws:')}/events?after=${snapshot.cursor}`, { headers: { Cookie: cookie, Origin: origin } });
    ws.on('message', (raw) => events.push(JSON.parse(raw.toString())));
    await until(() => events.some((event) => event.kind === 'message_accepted'));
    assert.equal(new Set(events.map((e) => e.sequence)).size, events.length);
    await fetch(`${origin}/api/revoke`, { method: 'POST', headers: { Cookie: cookie, Origin: origin } });
    await until(() => ws!.readyState === WebSocket.CLOSED);
    assert.equal((await fetch(`${origin}/api/snapshot`, { headers: { Cookie: cookie } })).status, 401);
  } finally { ws?.terminate(); await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('real runner connection persists fake-provider response through server restart exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-delivery-test-'));
  const store = new ServerStore(join(root, 'server.sqlite'));
  const ids = store.setup('synthetic');
  const session = store.pair(store.createPairingCode(), 'test')!;
  const port = await availablePort(), origin = `http://127.0.0.1:${port}`;
  let server = await createServer(store, origin);
  const local = new RunnerStore(join(root, 'runner.sqlite'), ids.runnerId);
  const runner = await startRunner(local, { runnerId: ids.runnerId, token: 'synthetic', serverUrl: origin, workspaceRoot: join(root, 'workspaces'), fake: true });
  try {
    await server.listen({ host: '127.0.0.1', port });
    const accepted = store.send(session.id, { commandId: randomUUID(), text: 'Synthetic restart' });
    await until(() => local.interrupted().length === 1);
    await server.close();
    await until(() => local.execution(accepted.runId).state === 'done');
    assert(local.nextDelivery());
    server = await createServer(store, origin);
    await server.listen({ host: '127.0.0.1', port });
    await until(() => store.nextDispatch(ids.runnerId) === undefined);
    assert.equal(store.snapshot().messages.length, 2);
    assert.equal((store.snapshot().messages[1] as { text: string }).text, 'Synthetic response: Synthetic restart');
    assert.equal(store.events(0).filter((event) => (event as { kind: string }).kind === 'outcome').length, 1);
  } finally { await runner.close(); local.close(); await server.close(); store.close(); rmSync(root, { recursive: true, force: true }); }
});

test('installed client v1 uses an independent expiring pairing for HTTP and live events', async () => {
  const root = mkdtempSync(join(tmpdir(), 'arthegall-app-test-'));
  const store = new ServerStore(join(root, 'server.sqlite'));
  const ids = store.setup('synthetic');
  const port = await availablePort();
  const origin = 'http://127.0.0.1:' + port;
  const server = await createServer(store, origin);
  const version = { 'x-arthegall-client': '1' };
  const pair = (code: string) => server.inject({ method: 'POST', url: '/client/v1/pair',
    headers: { ...version, host: new URL(origin).host }, payload: { code } });
  let socket: WebSocket | undefined;
  try {
    await server.listen({ host: '127.0.0.1', port });
    const old = store.pair(store.createPairingCode(), 'synthetic')!;
    const host = { host: new URL(origin).host };
    const expired = store.createPairingCode(Date.now() - 11 * 60_000);
    assert.equal((await pair(expired)).statusCode, 400);
    const code = store.createPairingCode();
    const response = await pair(code);
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['set-cookie'], undefined);
    const app = response.json<{ sessionId: string; token: string; version: number }>();
    assert.equal(app.version, 1);
    assert.equal(store.session(app.token), app.sessionId);
    assert.equal((await pair(code)).statusCode, 400);
    const headers = { ...host, ...version, authorization: 'Bearer ' + app.token };
    const snapshot = await server.inject({ url: '/client/v1/snapshot', headers });
    assert.equal(snapshot.statusCode, 200);
    assert.equal(snapshot.json().conversations[0].id, ids.conversationId);
    assert.equal((await server.inject({ url: '/api/snapshot', headers: { ...host, cookie: 'arthegall=' + app.token } })).statusCode, 401);
    assert.equal((await server.inject({ url: '/client/v1/snapshot', headers: { ...headers, authorization: 'Bearer ' + old.token } })).statusCode, 401);
    assert.equal((await server.inject({ url: '/client/v1/snapshot', headers: { ...headers, 'x-arthegall-client': '2' } })).statusCode, 400);
    const events: { sequence: number; kind: string }[] = [];
    socket = new WebSocket(origin.replace('http:', 'ws:') + '/client/v1/events?after=' + snapshot.json().cursor, { headers });
    socket.on('message', raw => events.push(JSON.parse(raw.toString())));
    await until(() => socket?.readyState === WebSocket.OPEN);
    const payload = { commandId: randomUUID(), conversationId: ids.conversationId, text: 'Synthetic Mac message' };
    const send = () => server.inject({ method: 'POST', url: '/client/v1/messages', headers, payload });
    const accepted = await send();
    assert.equal(accepted.statusCode, 200);
    assert.deepEqual((await send()).json(), accepted.json());
    await until(() => events.some(e => e.kind === 'message_accepted'));
    assert.equal(store.db.prepare('SELECT count(*) FROM dispatches').pluck().get(), 1);
    assert.equal(snapshot.json().commandApprovalsVersion, 1);
    const dispatch = store.nextDispatch(ids.runnerId)!;
    const approvalId = randomUUID();
    store.receive(ids.runnerId, { type: 'delivery', version: 1, deliveryId: randomUUID(), runId: dispatch.context.runId,
      sequence: 1, event: { kind: 'approval', approval: { approvalId, command: 'Synthetic operation' } } });
    const decide = (prefix: string, decision: string, credential: Record<string, string>) =>
      server.inject({ method: 'POST', url: `${prefix}/approvals/${approvalId}`, headers: credential, payload: { decision } });
    const browserHeaders = { ...host, ...version, origin, cookie: 'arthegall=' + old.token };
    assert.equal((await decide('/client/v1', 'accept', browserHeaders)).statusCode, 401);
    assert.equal((await decide('/client/v1', 'accept', headers)).statusCode, 200);
    assert.equal((await decide('/api', 'decline', browserHeaders)).statusCode, 409);
    assert.deepEqual(store.db.prepare('SELECT decision,session_id FROM approvals WHERE id=?').get(approvalId),
      { decision: 'accept', session_id: app.sessionId });
    assert.equal((await server.inject({ method: 'POST', url: '/client/v1/revoke', headers })).statusCode, 200);
    await until(() => socket?.readyState === WebSocket.CLOSED);
    assert.equal((await send()).statusCode, 401);
    assert.equal(store.session(old.token), old.id);
    const expiredSession = store.pair(store.createPairingCode(), 'fixture', Date.now(), 'app')!;
    store.db.prepare('UPDATE browser_sessions SET expires=? WHERE id=?').run(Date.now() - 1, expiredSession.id);
    assert.equal((await server.inject({ url: '/client/v1/snapshot', headers: { ...headers,
      authorization: 'Bearer ' + expiredSession.token } })).statusCode, 401);
  } finally {
    socket?.terminate();
    await server.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
