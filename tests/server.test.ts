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
  const port = 20_000 + Math.floor(Math.random() * 10_000), origin = `http://127.0.0.1:${port}`;
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
  const port = 30_000 + Math.floor(Math.random() * 10_000), origin = `http://127.0.0.1:${port}`;
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
