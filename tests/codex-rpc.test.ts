import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { CodexRpc } from '../apps/runner/src/codex/rpc.js';

const fake = String.raw`
const readline = require('node:readline');
const send = (value) => process.stdout.write(JSON.stringify(value) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const r = JSON.parse(line);
  if (r.method === 'initialize') send({ id: r.id, result: { ready: true } });
  if (r.method === 'echo') send({ id: r.id, result: r.params });
  if (r.method === 'late') setTimeout(() => send({ id: r.id, result: true }), 80);
  if (r.method === 'notify') {
    send({ method: 'item/test', params: { text: 'synthetic' } });
    send({ id: r.id, result: {} });
  }
  if (r.method === 'ask') {
    send({ id: 'provider-request', method: 'unsupported/action', params: {} });
    send({ id: r.id, result: {} });
  }
  if (r.id === 'provider-request') send({ method: 'decision', params: r });
  if (r.method === 'malformed') process.stdout.write('not-json\n');
  if (r.method === 'exit') process.exit(1);
});
`;
const create = () => new CodexRpc(process.execPath, ['-e', fake], tmpdir());

test('RPC correlates concurrent responses and receives notifications', async () => {
  const rpc = create();
  try {
    await rpc.initialize();
    assert.deepEqual(await Promise.all([rpc.request('echo', { n: 1 }), rpc.request('echo', { n: 2 })]), [{ n: 1 }, { n: 2 }]);
    const notified = rpc.waitFor((event) => event.method === 'item/test');
    await rpc.request('notify', {});
    assert.deepEqual((await notified).params, { text: 'synthetic' });
  } finally { await rpc.close(); }
});

test('RPC denies unrecognized provider requests', async () => {
  const rpc = create();
  try {
    await rpc.initialize();
    const decision = rpc.waitFor((event) => event.method === 'decision');
    await rpc.request('ask', {});
    assert.deepEqual((await decision).params, {
      id: 'provider-request', error: { code: -32603, message: 'Request denied by runner' },
    });
  } finally { await rpc.close(); }
});

test('a timeout does not replay the request or misattribute its late response', async () => {
  const rpc = create();
  try {
    await rpc.initialize();
    await assert.rejects(rpc.request('late', {}, 10), /outcome may be unknown/);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await rpc.request('echo', 'next'), 'next');
  } finally { await rpc.close(); }
});

for (const method of ['exit', 'malformed']) {
  test(`${method} rejects outstanding calls and event waits`, async () => {
    const rpc = create();
    try {
      await rpc.initialize();
      const waiting = assert.rejects(rpc.waitFor(() => false));
      await assert.rejects(rpc.request(method, {}));
      await waiting;
      await assert.rejects(rpc.request('echo', {}));
    } finally { await rpc.close(); }
  });
}
