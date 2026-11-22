import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Snapshot } from '../../packages/contracts/src/index.js';

export const clientVersion = { 'X-Arthegall-Client': '1' };

export async function waitFor<T>(description: string, read: () => T | Promise<T>, timeout = 10_000): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (value) return value;
    await delay(100);
  } while (Date.now() < deadline);
  assert.fail('Timed out waiting for ' + description);
}

export async function waitForServer(origin: string) {
  await waitFor('the native pairing endpoint', async () =>
    (await fetch(origin + '/client/v1/snapshot', { headers: clientVersion }).catch(() => undefined))?.status === 401);
}

export const setupCode = (output: string) => {
  const code = output.match(/Pairing code \(valid for ten minutes\): (\S+)/)?.[1];
  assert(code, 'Setup did not issue a pairing code');
  return code;
};

export async function pairNative(origin: string, code: string) {
  const response = await fetch(origin + '/client/v1/pair', {
    method: 'POST', headers: { ...clientVersion, 'Content-Type': 'application/json' }, body: JSON.stringify({ code }),
  });
  assert.equal(response.status, 200);
  const pair = await response.json() as { version: number; token: string; sessionId: string };
  assert.equal(pair.version, 1);
  assert(pair.token.startsWith('app.'));
  return pair;
}

export class NativeTestClient {
  readonly headers;

  constructor(readonly origin: string, token: string) {
    this.headers = { ...clientVersion, Authorization: 'Bearer ' + token };
  }

  private async load(path: string, payload?: object) {
    const response = await fetch(this.origin + '/client/v1/' + path, payload === undefined ? { headers: this.headers } : {
      method: 'POST', headers: { ...this.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    });
    assert.equal(response.status, 200, path);
    return response.json();
  }

  async snapshot() { return Snapshot.parse(await this.load('snapshot')); }
  async post(path: string, payload: object = {}) { return this.load(path, payload); }
  async send(conversationId: string, text: string, replyTo?: string) {
    return this.post('messages', { commandId: randomUUID(), conversationId, text, replyTo }) as Promise<{ runId: string }>;
  }
}
