import assert from 'node:assert/strict';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { startToolService } from '../apps/runner/src/mcp.js';
import { providerEnvironment } from '../apps/runner/src/codex/config.js';

const context = () => ({
  agentId: randomUUID(), assignmentId: randomUUID(), runId: randomUUID(),
  definitionVersion: 1, instructions: 'Synthetic context', messages: [],
});

test('MCP binds identity, rejects extra identity fields, and awaits persistence', async () => {
  const service = await startToolService();
  const scoped = context();
  let saved = false;
  const binding = service.bind(scoped, async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    saved = true;
  });
  const client = new Client({ name: 'test', version: '1.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: `Bearer ${binding.token}` } } }));
    const output = z.object({ content: z.array(z.object({ text: z.string() })) }).parse(await client.callTool({ name: 'read_context', arguments: {} }));
    assert.deepEqual(JSON.parse(output.content[0]!.text), scoped);
    assert.equal((await client.callTool({ name: 'read_context', arguments: { runId: randomUUID() } })).isError, true);
    assert.equal((await client.callTool({ name: 'report_outcome', arguments: { status: 'completed', message: '' } })).isError, true);
    assert.equal(saved, false);
    await client.callTool({ name: 'report_outcome', arguments: { status: 'completed', message: 'Synthetic result' } });
    assert.equal(saved, true);
    binding.revoke();
    await assert.rejects(client.callTool({ name: 'read_context', arguments: {} }));
  } finally { await client.close(); await service.close(); }
});

test('MCP denies absent, expired and wrong tokens, hostile origins and Host headers', async () => {
  const service = await startToolService();
  const expired = service.bind(context(), async () => {}, -1);
  const active = service.bind(context(), async () => {});
  try {
    for (const token of ['', 'invalid', expired.token]) {
      const response = await fetch(service.url, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{}' });
      assert.equal(response.status, 401);
    }
    for (const header of [{ Origin: 'https://example.com' }, { Host: 'example.com' }]) {
      const status = await new Promise<number | undefined>((resolve, reject) => {
        const req = request(service.url, { method: 'POST', headers: { Authorization: `Bearer ${active.token}`, ...header } }, (res) => {
          res.resume(); resolve(res.statusCode);
        });
        req.on('error', reject);
        req.end('{}');
      });
      assert.equal(status, 403);
    }
  } finally { await service.close(); }
});

test('provider environment excludes application credentials and unrelated API keys', () => {
  assert.deepEqual(providerEnvironment({ PATH: '/synthetic/bin', ARTHEGALL_RUNNER_TOKEN: 'synthetic', OPENAI_API_KEY: 'synthetic' }), { PATH: '/synthetic/bin' });
});

test('report tools follow the bound role, runner grant and exact period', async () => {
  const service = await startToolService();
  const range = { start: '2020-01-02', end: '2020-01-02' };
  const access = { approvalId: randomUUID(), duration: 'run' as const, tool: 'read_usage' as const, runnerId: randomUUID() };
  let reads = 0;
  try {
    for (const extra of [{}, { administrator: true as const }, { access }, { access, range }]) {
      const binding = service.bind({ ...context(), ...extra }, async () => {}, undefined, {
        admin: async () => ({}), usage: async () => { reads++; throw new Error('Synthetic input'); },
      });
      const client = new Client({ name: 'synthetic-client', version: '1' });
      try {
        await client.connect(new StreamableHTTPClientTransport(new URL(service.url), { requestInit: { headers: { Authorization: 'Bearer ' + binding.token } } }));
        const names = (await client.listTools()).tools.map((tool) => tool.name);
        assert.equal(names.includes('read_usage'), 'range' in extra);
        assert.equal(names.includes('run_usage_report'), 'administrator' in extra);
        assert.equal(names.includes('create_reporting_assignment'), 'administrator' in extra);
        assert.equal((await client.callTool({ name: 'read_usage', arguments: { ...range, start: '2020-01-01' } })).isError,true);
        assert.equal((await client.callTool({ name: 'read_usage', arguments: { ...range, runnerId: access.runnerId } })).isError,true);
      } finally { await client.close(); binding.revoke(); }
    }
    assert.equal(reads,0);
  } finally { await service.close(); }
});
